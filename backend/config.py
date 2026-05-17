import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env")

class Settings:
    PROJECT_DIR: Path = BASE_DIR
    DOCKER_DIR: Path = BASE_DIR / "docker"

    NODEODM_HOST: str = os.getenv("NODEODM_HOST", "localhost")
    NODEODM_PORT: int = int(os.getenv("NODEODM_PORT", "3000"))
    try:
        MAX_GLTF_TEXTURE_SIZE: int = max(1024, int(os.getenv("MAX_GLTF_TEXTURE_SIZE", "8192")))
    except ValueError:
        MAX_GLTF_TEXTURE_SIZE = 8192

    @property
    def NODEODM_URL(self) -> str:
        return f"http://{self.NODEODM_HOST}:{self.NODEODM_PORT}"

    UPLOAD_DIR: Path = BASE_DIR / os.getenv("UPLOAD_DIR", "data/uploads").lstrip("./")
    OUTPUT_DIR: Path = BASE_DIR / os.getenv("OUTPUT_DIR", "data/outputs").lstrip("./")
    TILES_DIR: Path = BASE_DIR / os.getenv("TILES_DIR", "data/tiles").lstrip("./")
    FRONTEND_DIR: Path = BASE_DIR / "frontend"

    def ensure_dirs(self) -> None:
        for d in (
            self.UPLOAD_DIR,
            self.OUTPUT_DIR,
            self.TILES_DIR,
        ):
            d.mkdir(parents=True, exist_ok=True)

settings = Settings()
settings.ensure_dirs()
