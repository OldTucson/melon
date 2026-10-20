from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.datastructures import UploadFile as StarletteUploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request
from starlette.responses import Response

from .auth import require_internal_token
from .cli import MODEL_LOCK_PATH, CliConfigurationError, load_embedding_runtime
from .image_io import (
    IMAGE_SEARCH_IMAGE_TOO_LARGE,
    IMAGE_SEARCH_INVALID_FILE,
    MAX_ENCODED_BYTES,
    ImageSearchError,
)
from .repository import MAX_ALLOWED_PATTERN_IDS, Repository
from .search import NoIndexError, SearchResult, SearchService, SearchUnavailableError
from .settings import Settings, get_settings
from .storage import AlibabaOssStorage

SEARCH_TIMEOUT_SECONDS = 11.0
UPLOAD_CHUNK_BYTES = 1024 * 1024


class HealthResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["ok"] = "ok"
    index_version: str = Field(serialization_alias="indexVersion")
    model_loaded: bool = Field(serialization_alias="modelLoaded")


class SearchQueryResponse(BaseModel):
    width: int
    height: int


class SearchItemResponse(BaseModel):
    pattern_id: UUID = Field(serialization_alias="patternId")
    kind: Literal["probable_source", "possible_source", "visually_similar"]
    score: float


class InternalSearchResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    request_id: UUID = Field(serialization_alias="requestId")
    query: SearchQueryResponse
    items: tuple[SearchItemResponse, ...]


class SearchConcurrencyLimiter:
    def __init__(self, limit: int) -> None:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
            raise ValueError("search concurrency limit must be positive")
        self._semaphore = asyncio.Semaphore(limit)

    @property
    def locked(self) -> bool:
        return self._semaphore.locked()

    async def try_acquire(self) -> bool:
        if self._semaphore.locked():
            return False
        await self._semaphore.acquire()
        return True

    def release(self) -> None:
        self._semaphore.release()


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


def _required_text(value: str | None) -> str:
    if value is None:
        raise CliConfigurationError()
    return value


@lru_cache(maxsize=1)
def _get_search_service() -> SearchService:
    settings = get_settings()
    if settings.database_url is None:
        raise CliConfigurationError()
    repository = Repository(settings.database_url.get_secret_value())
    try:
        repository.require_pgvector_compatible()
        storage = AlibabaOssStorage(
            region=_required_text(settings.oss_region),
            bucket=_required_text(settings.oss_bucket),
            endpoint=_required_text(settings.oss_endpoint),
            environment=settings.environment,
        )
        runtime = load_embedding_runtime(settings, lock_path=MODEL_LOCK_PATH)
        return SearchService(
            repository,
            storage,
            runtime,
            index_version=settings.active_version,
        )
    except Exception:
        repository.close()
        raise


def get_search_service() -> SearchService:
    try:
        return _get_search_service()
    except Exception as error:
        raise _error(503, "UNAVAILABLE") from error


@lru_cache(maxsize=1)
def get_search_limiter() -> SearchConcurrencyLimiter:
    return SearchConcurrencyLimiter(get_settings().max_concurrency)


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    if _get_search_service.cache_info().currsize:
        _get_search_service().close()
    _get_search_service.cache_clear()
    get_search_limiter.cache_clear()


app = FastAPI(
    title="Melon visual search",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=_lifespan,
)


def _error(status_code: int, code: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code})


def _canonical_uuid(value: object) -> UUID:
    if not isinstance(value, str):
        raise _error(415, "INVALID_FILE")
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as error:
        raise _error(415, "INVALID_FILE") from error
    if str(parsed) != value:
        raise _error(415, "INVALID_FILE")
    return parsed


def _allowed_pattern_ids(encoded: str) -> tuple[UUID, ...]:
    try:
        raw: object = json.loads(encoded)
    except json.JSONDecodeError as error:
        raise _error(415, "INVALID_FILE") from error
    if not isinstance(raw, list) or len(raw) > MAX_ALLOWED_PATTERN_IDS:
        raise _error(415, "INVALID_FILE")
    values = tuple(_canonical_uuid(item) for item in raw)
    if len(set(values)) != len(values):
        raise _error(415, "INVALID_FILE")
    return values


async def _save_upload(upload: UploadFile, temp_dir: Path) -> Path:
    temp_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(
        prefix="query-",
        suffix=".upload",
        dir=temp_dir,
    )
    path = Path(name)
    total = 0
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            descriptor = -1
            while True:
                chunk = await upload.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ENCODED_BYTES:
                    raise _error(413, "IMAGE_TOO_LARGE")
                output.write(chunk)
        return path
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        path.unlink(missing_ok=True)
        raise


def _release_when_done(
    task: asyncio.Task[SearchResult],
    limiter: SearchConcurrencyLimiter,
) -> None:
    limiter.release()
    if not task.cancelled():
        task.exception()


def _response(request_id: UUID, result: SearchResult) -> InternalSearchResponse:
    return InternalSearchResponse(
        request_id=request_id,
        query=SearchQueryResponse(width=result.width, height=result.height),
        items=tuple(
            SearchItemResponse(
                pattern_id=item.pattern_id,
                kind=item.kind,
                score=item.score,
            )
            for item in result.items
        ),
    )


async def _await_search(task: asyncio.Task[SearchResult]) -> SearchResult:
    shielded = asyncio.shield(task)
    timeout_factory = getattr(asyncio, "timeout", None)
    if timeout_factory is not None:
        async with timeout_factory(SEARCH_TIMEOUT_SECONDS):
            return await shielded
    return await asyncio.wait_for(shielded, timeout=SEARCH_TIMEOUT_SECONDS)


async def _multipart_uploads(
    request: Request,
) -> tuple[tuple[str, StarletteUploadFile], ...]:
    form = await request.form()
    return tuple(
        (name, value)
        for name, value in form.multi_items()
        if isinstance(value, StarletteUploadFile)
    )


async def _close_uploads(uploads: tuple[StarletteUploadFile, ...]) -> None:
    seen: set[int] = set()
    for upload in uploads:
        identity = id(upload)
        if identity in seen:
            continue
        seen.add(identity)
        try:
            await upload.close()
        except Exception:
            continue


@app.exception_handler(StarletteHTTPException)
async def _http_error_handler(
    request: Request,
    error: StarletteHTTPException,
) -> Response:
    if request.url.path == "/internal/search" and error.status_code == 400:
        return JSONResponse(
            status_code=415,
            content={"detail": {"code": "INVALID_FILE"}},
        )
    return await http_exception_handler(request, error)


@app.exception_handler(RequestValidationError)
async def _validation_error_handler(
    request: Request,
    error: RequestValidationError,
) -> JSONResponse:
    del error
    if request.url.path == "/internal/search":
        return JSONResponse(status_code=415, content={"detail": {"code": "INVALID_FILE"}})
    return JSONResponse(status_code=422, content={"detail": "Invalid request"})


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


@app.post(
    "/internal/search",
    dependencies=[Depends(require_internal_token)],
    response_model=InternalSearchResponse,
)
async def internal_search(
    request: Request,
    image: Annotated[UploadFile, File()],
    owner_id_value: Annotated[str, Form(alias="ownerId")],
    allowed_ids_value: Annotated[str, Form(alias="allowedPatternIds")],
    request_id_value: Annotated[str, Form(alias="requestId")],
    settings: Annotated[Settings, Depends(get_settings)],
    service: Annotated[SearchService, Depends(get_search_service)],
    limiter: Annotated[SearchConcurrencyLimiter, Depends(get_search_limiter)],
) -> InternalSearchResponse:
    temp_path: Path | None = None
    acquired = False
    work_task: asyncio.Task[SearchResult] | None = None
    multipart_uploads: tuple[tuple[str, StarletteUploadFile], ...] = ()
    try:
        multipart_uploads = await _multipart_uploads(request)
        if (
            len(multipart_uploads) != 1
            or multipart_uploads[0][0] != "image"
            or multipart_uploads[0][1] is not image
        ):
            raise _error(415, "INVALID_FILE")
        owner_id = _canonical_uuid(owner_id_value)
        allowed_ids = _allowed_pattern_ids(allowed_ids_value)
        request_id = _canonical_uuid(request_id_value)
        temp_path = await _save_upload(image, settings.temp_dir)
        encoded = temp_path.read_bytes()

        acquired = await limiter.try_acquire()
        if not acquired:
            raise _error(429, "BUSY")
        work_task = asyncio.create_task(
            asyncio.to_thread(
                service.search_encoded,
                owner_id,
                allowed_ids,
                encoded,
            )
        )
        work_task.add_done_callback(lambda task: _release_when_done(task, limiter))
        try:
            result = await _await_search(work_task)
        except (TimeoutError, asyncio.TimeoutError) as error:
            raise _error(504, "TIMEOUT") from error
        return _response(request_id, result)
    except ImageSearchError as error:
        if error.code == IMAGE_SEARCH_IMAGE_TOO_LARGE:
            raise _error(413, "IMAGE_TOO_LARGE") from error
        if error.code == IMAGE_SEARCH_INVALID_FILE:
            raise _error(415, "INVALID_FILE") from error
        raise _error(503, "UNAVAILABLE") from error
    except NoIndexError as error:
        raise _error(409, "NO_INDEX") from error
    except SearchUnavailableError as error:
        raise _error(503, "UNAVAILABLE") from error
    except HTTPException:
        raise
    except asyncio.CancelledError:
        raise
    except Exception as error:
        raise _error(503, "UNAVAILABLE") from error
    finally:
        if acquired and work_task is None:
            limiter.release()
        try:
            await _close_uploads(
                (image, *(upload for _, upload in multipart_uploads))
            )
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
