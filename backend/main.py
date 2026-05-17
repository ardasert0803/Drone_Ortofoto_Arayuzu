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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(tasks.router)
app.include_router(indoor.router)

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
