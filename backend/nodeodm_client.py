"""NodeODM REST API istemcisi.

NodeODM kendi REST API'sini port 3000'de açar. Belgeler:
https://github.com/OpenDroneMap/NodeODM/blob/master/docs/index.adoc

Buradaki wrapper sadece bizim arayüzün ihtiyaç duyduğu uçları kapsar:
- task oluşturma + foto yükleme + commit
- task durumu sorgulama
- task listesi
- task çıktılarını indirme (orthophoto, point cloud, 3d tiles vb.)
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Iterable

import httpx

from config import settings


class NodeODMError(RuntimeError):
    """NodeODM tarafında oluşan hatalar için."""


class NodeODMClient:
    def __init__(self, base_url: str | None = None, timeout: float = 60.0):
        self.base_url = base_url or settings.NODEODM_URL
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Yardımcılar
    # ------------------------------------------------------------------
    async def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)

    @staticmethod
    def _check(resp: httpx.Response) -> dict[str, Any]:
        if resp.status_code >= 400:
            raise NodeODMError(f"NodeODM {resp.status_code}: {resp.text}")
        try:
            return resp.json()
        except ValueError:
            return {"raw": resp.text}

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        """Tüm httpx hatalarını NodeODMError'a sararak istek yapar."""
        try:
            async with await self._client() as client:
                return await client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            raise NodeODMError(
                f"NodeODM bağlantı hatası ({self.base_url}): {exc.__class__.__name__}: {exc}"
            ) from exc

    # ------------------------------------------------------------------
    # NodeODM uçları
    # ------------------------------------------------------------------
    async def info(self) -> dict[str, Any]:
        """NodeODM'in çalışıp çalışmadığını ve sürümünü döner."""
        resp = await self._request("GET", "/info")
        return self._check(resp)

    async def list_tasks(self) -> list[str]:
        """Mevcut task UUID'lerini döner."""
        resp = await self._request("GET", "/task/list")
        data = self._check(resp)
        # /task/list bir liste döner: [{"uuid": "..."}, ...]
        if isinstance(data, list):
            return [t.get("uuid") for t in data if t.get("uuid")]
        return []

    async def task_info(self, uuid: str) -> dict[str, Any]:
        resp = await self._request("GET", f"/task/{uuid}/info")
        return self._check(resp)

    async def create_task(
        self,
        files: Iterable[tuple[str, bytes]],
        name: str | None = None,
        options: list[dict[str, Any]] | None = None,
    ) -> str:
        """Yeni bir ODM task'ı oluşturur ve fotoğrafları yükler.

        files: [(filename, bytes), ...]
        Geri dönüş: task UUID
        """
        # 1) /task/new/init  -> task uuid al
        init_payload: dict[str, Any] = {}
        if name:
            init_payload["name"] = name
        if options:
            import json
            init_payload["options"] = json.dumps(options)

        resp = await self._request("POST", "/task/new/init", data=init_payload)
        data = self._check(resp)
        uuid = data.get("uuid")
        if not uuid:
            raise NodeODMError(f"NodeODM init dönüşünde uuid yok: {data}")

        # 2) /task/new/upload/{uuid}  -> her foto için
        for fname, content in files:
            files_payload = {"images": (fname, content, "image/jpeg")}
            up = await self._request(
                "POST", f"/task/new/upload/{uuid}", files=files_payload
            )
            self._check(up)

        # 3) /task/new/commit/{uuid}  -> işleme başla
        commit = await self._request("POST", f"/task/new/commit/{uuid}")
        self._check(commit)

        return uuid

    async def remove_task(self, uuid: str) -> dict[str, Any]:
        resp = await self._request(
            "POST", "/task/remove", data={"uuid": uuid}
        )
        return self._check(resp)

    async def download_asset(self, uuid: str, asset: str, dest: Path) -> Path:
        """Bir task çıktısını indirir.

        asset örnekleri:
            "all.zip"             -> tüm çıktılar
            "orthophoto.tif"      -> ortofoto GeoTIFF
            "georeferenced_model.laz" -> nokta bulutu
            "textured_model.zip"  -> dokulu mesh
        """
        url = f"/task/{uuid}/download/{asset}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        async with await self._client() as client:
            async with client.stream("GET", url) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    raise NodeODMError(
                        f"NodeODM download {resp.status_code}: {body[:200]!r}"
                    )
                with open(dest, "wb") as fh:
                    async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                        fh.write(chunk)
        return dest


# Bütün uygulama tek bir client'ı paylaşır
client = NodeODMClient()



async def _selftest() -> None:
    """Komut satırından çalıştırınca NodeODM'e ping atar."""
    try:
        info = await client.info()
        print("NodeODM ulaşılabilir:", info)
    except Exception as exc:
        print("NodeODM'e ulaşılamadı:", exc)


if __name__ == "__main__":
    asyncio.run(_selftest())
