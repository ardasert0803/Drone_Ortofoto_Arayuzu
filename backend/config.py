"""Uygulama konfigürasyonu — .env dosyasından okunur."""
import os
from pathlib import Path
from dotenv import load_dotenv

# Proje kökü = backend/'in bir üstü
BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env")


class Settings:
    PROJECT_DIR: Path = BASE_DIR
    DOCKER_DIR: Path = BASE_DIR / "docker"

    # Cesium ion
    CESIUM_ION_TOKEN: str = os.getenv("CESIUM_ION_TOKEN", "")

    # NodeODM
    NODEODM_HOST: str = os.getenv("NODEODM_HOST", "localhost")
    NODEODM_PORT: int = int(os.getenv("NODEODM_PORT", "3000"))

    @property
    def NODEODM_URL(self) -> str:
        return f"http://{self.NODEODM_HOST}:{self.NODEODM_PORT}"

    # Veri klasörleri (mutlak yola çevir)
    UPLOAD_DIR: Path = BASE_DIR / os.getenv("UPLOAD_DIR", "data/uploads").lstrip("./")
    OUTPUT_DIR: Path = BASE_DIR / os.getenv("OUTPUT_DIR", "data/outputs").lstrip("./")
    TILES_DIR: Path = BASE_DIR / os.getenv("TILES_DIR", "data/tiles").lstrip("./")
    INDOOR_BASE_DIR: Path = BASE_DIR / os.getenv("INDOOR_BASE_DIR", "data/indoor").lstrip("./")
    INDOOR_UPLOAD_DIR: Path = INDOOR_BASE_DIR / "uploads"
    INDOOR_WORKSPACE_DIR: Path = INDOOR_BASE_DIR / "workspaces"
    INDOOR_OUTPUT_DIR: Path = INDOOR_BASE_DIR / "outputs"
    INDOOR_LOG_DIR: Path = INDOOR_BASE_DIR / "logs"

    # Frontend
    FRONTEND_DIR: Path = BASE_DIR / "frontend"

    def ensure_dirs(self) -> None:
        for d in (
            self.UPLOAD_DIR,
            self.OUTPUT_DIR,
            self.TILES_DIR,
            self.INDOOR_UPLOAD_DIR,
            self.INDOOR_WORKSPACE_DIR,
            self.INDOOR_OUTPUT_DIR,
            self.INDOOR_LOG_DIR,
        ):
            d.mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.ensure_dirs()
