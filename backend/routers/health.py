"""Sağlık ve config bilgisi uçları."""
from fastapi import APIRouter

from config import settings
from nodeodm_client import NodeODMError, client as odm

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health() -> dict:
    """Web + NodeODM sağlık kontrolü."""
    web_ok = True
    nodeodm_ok = False
    nodeodm_info = None
    try:
        nodeodm_info = await odm.info()
        nodeodm_ok = True
    except NodeODMError as exc:
        nodeodm_info = {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        nodeodm_info = {"error": str(exc)}

    return {
        "web": web_ok,
        "nodeodm": nodeodm_ok,
        "nodeodm_url": settings.NODEODM_URL,
        "nodeodm_info": nodeodm_info,
    }


@router.get("/config")
async def public_config() -> dict:
    """Frontend'in ihtiyaç duyduğu konfig değerleri (token vb.)."""
    return {
        "cesium_ion_token": settings.CESIUM_ION_TOKEN,
        "nodeodm_url": settings.NODEODM_URL,
    }
