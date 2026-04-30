"""FastAPI giriş noktası.

Çalıştırma:
    cd backend
    uvicorn main:app --reload --host 0.0.0.0 --port 8000

Sunucu:
  - / -> frontend (statik HTML/JS/CSS)
  - /api/* -> REST uçları (tasks, health, config)
  - /data/outputs/* -> NodeODM'den indirilmiş ortofoto/3D tile çıktıları
NodeODM Docker container'ı ayrıca docker/docker-compose.yml ile ayağa kaldırılır.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import settings
from routers import health, indoor, tasks

app = FastAPI(
    title="Sektörel Cesium — Ortofoto Arayüzü",
    version="0.1.0",
    description=(
        "Drone fotoğraflarını NodeODM ile ortofoto + 3D tile'a çevirip "
        "CesiumJS üzerinde gösteren web arayüzü."
    ),
)

# Geliştirme aşamasında her yere CORS aç — prod'da daralt
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# REST router'ları
app.include_router(health.router)
app.include_router(tasks.router)
app.include_router(indoor.router)

# NodeODM'den indirilen çıktılar (orthophoto.tif, 3d_tiles/...)
app.mount(
    "/data/outputs",
    StaticFiles(directory=str(settings.OUTPUT_DIR)),
    name="outputs",
)
app.mount(
    "/data/indoor/outputs",
    StaticFiles(directory=str(settings.INDOOR_OUTPUT_DIR)),
    name="indoor_outputs",
)

# Frontend (Cesium SPA) — en sona mount edilmeli, en geniş prefix yakalar
app.mount(
    "/",
    StaticFiles(directory=str(settings.FRONTEND_DIR), html=True),
    name="frontend",
)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
