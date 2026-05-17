from __future__ import annotations

import asyncio
import mimetypes
from pathlib import Path
from typing import Any, Iterable

import httpx

from config import settings

class NodeODMError(RuntimeError):
    pass

class NodeODMClient:
    def __init__(self, base_url: str | None = None, timeout: float = 300.0):
        self.base_url = base_url or settings.NODEODM_URL
        self.timeout = timeout

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
        try:
            async with await self._client() as client:
                return await client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            raise NodeODMError(
                f"NodeODM bağlantı hatası ({self.base_url}): {exc.__class__.__name__}: {exc}"
            ) from exc

    async def info(self) -> dict[str, Any]:
        resp = await self._request("GET", "/info")
        return self._check(resp)

    async def list_tasks(self) -> list[str]:
        resp = await self._request("GET", "/task/list")
        data = self._check(resp)
        if isinstance(data, list):
            return [t.get("uuid") for t in data if t.get("uuid")]
        return []

    async def task_info(self, uuid: str) -> dict[str, Any]:
        resp = await self._request("GET", f"/task/{uuid}/info")
        return self._check(resp)

    async def create_task(
        self,
        files: Iterable[tuple[str, bytes | Path]],
        name: str | None = None,
        options: list[dict[str, Any]] | None = None,
    ) -> str:
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

        for fname, content in files:
            mime_type = mimetypes.guess_type(fname)[0] or "application/octet-stream"
            if isinstance(content, Path):
                with content.open("rb") as fh:
                    files_payload = {"images": (fname, fh, mime_type)}
                    up = await self._request(
                        "POST", f"/task/new/upload/{uuid}", files=files_payload
                    )
            else:
                files_payload = {"images": (fname, content, mime_type)}
                up = await self._request(
                    "POST", f"/task/new/upload/{uuid}", files=files_payload
                )
            self._check(up)

        commit = await self._request("POST", f"/task/new/commit/{uuid}")
        self._check(commit)

        return uuid

    async def remove_task(self, uuid: str) -> dict[str, Any]:
        resp = await self._request(
            "POST", "/task/remove", data={"uuid": uuid}
        )
        return self._check(resp)

    async def download_asset(self, uuid: str, asset: str, dest: Path) -> Path:
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

client = NodeODMClient()

async def _selftest() -> None:
    try:
        info = await client.info()
        print("NodeODM ulaşılabilir:", info)
    except Exception as exc:
        print("NodeODM'e ulaşılamadı:", exc)

if __name__ == "__main__":
    asyncio.run(_selftest())
