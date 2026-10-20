from __future__ import annotations

import hashlib
import secrets
from typing import Annotated, Literal

from fastapi import Depends, FastAPI
from pydantic import BaseModel, ConfigDict, Field

from .auth import require_internal_token
from .settings import Settings, get_settings


class HealthResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["ok"] = "ok"
    index_version: str = Field(serialization_alias="indexVersion")
    model_loaded: bool = Field(serialization_alias="modelLoaded")


def model_artifact_matches(settings: Settings) -> bool:
    model_path = settings.model_path
    expected_checksum = settings.model_sha256
    if model_path is None or expected_checksum is None or not model_path.is_file():
        return False

    digest = hashlib.sha256()
    try:
        with model_path.open("rb") as model_file:
            for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return False
    return secrets.compare_digest(digest.hexdigest(), expected_checksum)


app = FastAPI(
    title="Melon visual search",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.get(
    "/internal/health",
    dependencies=[Depends(require_internal_token)],
    response_model=HealthResponse,
)
async def health(
    settings: Annotated[Settings, Depends(get_settings)],
) -> HealthResponse:
    return HealthResponse(
        index_version=settings.active_version,
        model_loaded=model_artifact_matches(settings),
    )
