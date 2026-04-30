"""Indoor photogrammetry task router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

import indoor_pipeline

router = APIRouter(prefix="/api/indoor/tasks", tags=["indoor"])


class IndoorTaskCreated(BaseModel):
    uuid: str
    images_uploaded: int


class IndoorTaskSummary(BaseModel):
    uuid: str
    name: str
    pipeline: str = "indoor"
    status: int
    status_text: str
    stage: str
    progress: float | None = None
    images_count: int | None = None
    date_created: float | None = None
    created_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    location: str | None = None
    capture_date: str | None = None
    description: str | None = None
    building_name: str | None = None
    floor_label: str | None = None
    space_label: str | None = None
    error_summary: str | None = None
    dispatch_error: str | None = None


def _serialize(task: dict[str, Any]) -> IndoorTaskSummary:
    return IndoorTaskSummary(**task)


@router.get("", response_model=list[IndoorTaskSummary])
async def list_indoor_tasks() -> list[IndoorTaskSummary]:
    return [_serialize(task) for task in indoor_pipeline.list_tasks()]


@router.get("/{uuid}", response_model=IndoorTaskSummary)
async def get_indoor_task(uuid: str) -> IndoorTaskSummary:
    return _serialize(indoor_pipeline.get_task(uuid))


@router.post("", response_model=IndoorTaskCreated)
async def create_indoor_task(
    images: list[UploadFile] = File(..., description="Indoor telefon fotoğrafları (>=15)"),
    name: str | None = Form(None),
    location: str | None = Form(None),
    capture_date: str | None = Form(None),
    description: str | None = Form(None),
    building_name: str | None = Form(None),
    floor_label: str | None = Form(None),
    space_label: str | None = Form(None),
) -> IndoorTaskCreated:
    payload = await indoor_pipeline.create_task(
        images=images,
        name=name,
        location=location,
        capture_date=capture_date,
        description=description,
        building_name=building_name,
        floor_label=floor_label,
        space_label=space_label,
    )
    return IndoorTaskCreated(**payload)


@router.delete("/{uuid}")
async def delete_indoor_task(uuid: str) -> dict[str, str]:
    return indoor_pipeline.delete_task(uuid)


@router.get("/{uuid}/tileset/url")
async def indoor_tileset_url(uuid: str) -> dict[str, str]:
    return indoor_pipeline.tileset_url(uuid)


@router.get("/{uuid}/log", response_class=PlainTextResponse)
async def indoor_log(uuid: str) -> PlainTextResponse:
    return PlainTextResponse(
        indoor_pipeline.read_log(uuid),
        headers={"Content-Disposition": f'attachment; filename="{uuid}.log"'},
    )
