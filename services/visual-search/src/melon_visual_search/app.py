from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import tempfile
import threading
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal, TypeVar
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.datastructures import FormData, UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.requests import Request

from .auth import require_internal_token
from .cli import (
    MODEL_LOCK_PATH,
    CliConfigurationError,
    build_storage,
    load_embedding_runtime,
)
from .image_io import (
    IMAGE_SEARCH_IMAGE_TOO_LARGE,
    IMAGE_SEARCH_INVALID_FILE,
    MAX_ENCODED_BYTES,
    ImageSearchError,
)
from .palette_search import validate_query_colors
from .repository import MAX_ALLOWED_PATTERN_IDS, Repository
from .search import (
    NoIndexError,
    PaletteSearchResult,
    SearchResult,
    SearchService,
    SearchUnavailableError,
)
from .settings import Settings, get_settings

SEARCH_TIMEOUT_SECONDS = 11.0
UPLOAD_CHUNK_BYTES = 1024 * 1024
MAX_MULTIPART_BYTES = MAX_ENCODED_BYTES + 1024 * 1024
MAX_MULTIPART_FIELD_BYTES = 512 * 1024
_SEARCH_FORM_FIELDS = frozenset(
    {"image", "ownerId", "allowedPatternIds", "requestId"}
)
_SEARCH_SERVICE_LOCK = threading.Lock()
_SEARCH_LIMITER_LOCK = threading.Lock()
_SEARCH_STATE = threading.Condition()
_ACTIVE_SEARCH_TASKS: set[asyncio.Task[Any]] = set()
_SEARCH_ADMISSIONS = 0
_SEARCH_STOPPING = False
_SearchResultT = TypeVar("_SearchResultT")


class MultipartBodyTooLargeError(Exception):
    pass


@dataclass(frozen=True)
class SearchMultipart:
    form: FormData
    image: UploadFile
    owner_id: str
    allowed_pattern_ids: str
    request_id: str


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


def _canonical_uuid_text(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("UUID values must be strings")
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as error:
        raise ValueError("UUID values must be canonical") from error
    if str(parsed) != value:
        raise ValueError("UUID values must be canonical")
    return value


class InternalPaletteSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    owner_id: UUID = Field(alias="ownerId")
    allowed_pattern_ids: tuple[UUID, ...] = Field(alias="allowedPatternIds")
    request_id: UUID = Field(alias="requestId")
    colors: tuple[str, ...]

    @field_validator("owner_id", "request_id", mode="before")
    @classmethod
    def _validate_identity(cls, value: object) -> object:
        return _canonical_uuid_text(value)

    @field_validator("allowed_pattern_ids", mode="before")
    @classmethod
    def _validate_allowed_pattern_ids(cls, value: object) -> object:
        if not isinstance(value, list) or len(value) > MAX_ALLOWED_PATTERN_IDS:
            raise ValueError("allowed pattern IDs are invalid")
        validated = tuple(_canonical_uuid_text(item) for item in value)
        if len(set(validated)) != len(validated):
            raise ValueError("allowed pattern IDs must be unique")
        return validated

    @field_validator("colors", mode="before")
    @classmethod
    def _validate_colors(cls, value: object) -> object:
        if not isinstance(value, list):
            raise ValueError("colors must be an array")
        return validate_query_colors(value)


class PaletteQueryResponse(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    colors: tuple[str, ...]


class PaletteSearchItemResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, allow_inf_nan=False)

    pattern_id: UUID = Field(serialization_alias="patternId")
    distance: float = Field(ge=0.0)


class InternalPaletteSearchResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, allow_inf_nan=False)

    request_id: UUID = Field(serialization_alias="requestId")
    query: PaletteQueryResponse
    items: tuple[PaletteSearchItemResponse, ...]


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


@lru_cache(maxsize=1)
def _get_search_service() -> SearchService:
    settings = get_settings()
    if settings.database_url is None:
        raise CliConfigurationError()
    repository = Repository(settings.database_url.get_secret_value())
    try:
        repository.require_pgvector_compatible()
        storage = build_storage(settings)
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
        with _SEARCH_SERVICE_LOCK:
            return _get_search_service()
    except Exception as error:
        raise _error(503, "UNAVAILABLE") from error


@lru_cache(maxsize=1)
def _get_search_limiter() -> SearchConcurrencyLimiter:
    return SearchConcurrencyLimiter(get_settings().max_concurrency)


def get_search_limiter() -> SearchConcurrencyLimiter:
    try:
        with _SEARCH_LIMITER_LOCK:
            return _get_search_limiter()
    except Exception as error:
        raise _error(503, "UNAVAILABLE") from error


def _start_accepting_searches() -> None:
    global _SEARCH_STOPPING
    with _SEARCH_STATE:
        if _SEARCH_ADMISSIONS or _ACTIVE_SEARCH_TASKS:
            raise RuntimeError("cannot start while searches are active")
        _SEARCH_STOPPING = False


def _wait_for_searches_to_quiesce() -> None:
    with _SEARCH_STATE:
        _SEARCH_STATE.wait_for(
            lambda: _SEARCH_ADMISSIONS == 0 and not _ACTIVE_SEARCH_TASKS
        )


async def _stop_and_wait_for_searches() -> None:
    global _SEARCH_STOPPING
    with _SEARCH_STATE:
        _SEARCH_STOPPING = True
        if _SEARCH_ADMISSIONS == 0 and not _ACTIVE_SEARCH_TASKS:
            return
    await asyncio.to_thread(_wait_for_searches_to_quiesce)


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    _start_accepting_searches()
    try:
        yield
    finally:
        await _stop_and_wait_for_searches()
        try:
            with _SEARCH_SERVICE_LOCK:
                try:
                    if _get_search_service.cache_info().currsize:
                        _get_search_service().close()
                finally:
                    _get_search_service.cache_clear()
        finally:
            with _SEARCH_LIMITER_LOCK:
                _get_search_limiter.cache_clear()


app = FastAPI(
    title="Melon visual search",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=_lifespan,
)


def _error(status_code: int, code: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code})


def _require_search_running() -> Iterator[None]:
    global _SEARCH_ADMISSIONS
    with _SEARCH_STATE:
        if _SEARCH_STOPPING:
            raise _error(503, "UNAVAILABLE")
        _SEARCH_ADMISSIONS += 1
    try:
        yield
    finally:
        with _SEARCH_STATE:
            _SEARCH_ADMISSIONS -= 1
            _SEARCH_STATE.notify_all()


def _require_json_content_type(request: Request) -> None:
    content_type = request.headers.get("content-type", "")
    media_type = content_type.partition(";")[0].strip().lower()
    if media_type != "application/json":
        raise _error(415, "INVALID_COLORS")


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
    task: asyncio.Task[Any],
    limiter: SearchConcurrencyLimiter,
) -> None:
    with _SEARCH_STATE:
        _ACTIVE_SEARCH_TASKS.discard(task)
        _SEARCH_STATE.notify_all()
    limiter.release()
    if not task.cancelled():
        task.exception()


def _create_search_task(
    service: SearchService,
    limiter: SearchConcurrencyLimiter,
    owner_id: UUID,
    allowed_ids: tuple[UUID, ...],
    encoded: bytes,
) -> asyncio.Task[SearchResult]:
    with _SEARCH_STATE:
        if _SEARCH_STOPPING:
            raise _error(503, "UNAVAILABLE")
        task = asyncio.create_task(
            asyncio.to_thread(
                service.search_encoded,
                owner_id,
                allowed_ids,
                encoded,
            )
        )
        _ACTIVE_SEARCH_TASKS.add(task)
        task.add_done_callback(lambda done: _release_when_done(done, limiter))
        return task


def _create_palette_search_task(
    service: SearchService,
    limiter: SearchConcurrencyLimiter,
    body: InternalPaletteSearchRequest,
) -> asyncio.Task[PaletteSearchResult]:
    with _SEARCH_STATE:
        if _SEARCH_STOPPING:
            raise _error(503, "UNAVAILABLE")
        task = asyncio.create_task(
            asyncio.to_thread(
                service.search_palette,
                body.owner_id,
                body.allowed_pattern_ids,
                body.colors,
            )
        )
        _ACTIVE_SEARCH_TASKS.add(task)
        task.add_done_callback(lambda done: _release_when_done(done, limiter))
        return task


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


def _palette_response(
    request_id: UUID,
    result: PaletteSearchResult,
) -> InternalPaletteSearchResponse:
    return InternalPaletteSearchResponse(
        request_id=request_id,
        query=PaletteQueryResponse(colors=result.colors),
        items=tuple(
            PaletteSearchItemResponse(
                pattern_id=item.pattern_id,
                distance=item.distance,
            )
            for item in result.items
        ),
    )


async def _await_search(task: asyncio.Task[_SearchResultT]) -> _SearchResultT:
    shielded = asyncio.shield(task)
    timeout_factory = getattr(asyncio, "timeout", None)
    if timeout_factory is not None:
        async with timeout_factory(SEARCH_TIMEOUT_SECONDS):
            return await shielded
    return await asyncio.wait_for(shielded, timeout=SEARCH_TIMEOUT_SECONDS)


async def _bounded_request_stream(request: Request) -> AsyncGenerator[bytes, None]:
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_MULTIPART_BYTES:
            raise MultipartBodyTooLargeError()
        yield chunk


async def _parse_search_multipart(request: Request) -> SearchMultipart:
    parser = MultiPartParser(
        request.headers,
        _bounded_request_stream(request),
        max_files=1,
        max_fields=3,
        max_part_size=MAX_MULTIPART_FIELD_BYTES,
    )
    try:
        form = await parser.parse()
    except MultipartBodyTooLargeError as error:
        raise _error(413, "IMAGE_TOO_LARGE") from error
    except (KeyError, MultiPartException) as error:
        raise _error(415, "INVALID_FILE") from error

    try:
        items = tuple(form.multi_items())
        if len(items) != len(_SEARCH_FORM_FIELDS):
            raise _error(415, "INVALID_FILE")
        if {name for name, _ in items} != _SEARCH_FORM_FIELDS:
            raise _error(415, "INVALID_FILE")

        values = dict(items)
        image = values["image"]
        owner_id = values["ownerId"]
        allowed_pattern_ids = values["allowedPatternIds"]
        request_id = values["requestId"]
        if (
            not isinstance(image, UploadFile)
            or not isinstance(owner_id, str)
            or not isinstance(allowed_pattern_ids, str)
            or not isinstance(request_id, str)
        ):
            raise _error(415, "INVALID_FILE")
        return SearchMultipart(
            form=form,
            image=image,
            owner_id=owner_id,
            allowed_pattern_ids=allowed_pattern_ids,
            request_id=request_id,
        )
    except BaseException:
        await form.close()
        raise


@app.exception_handler(RequestValidationError)
async def _validation_error_handler(
    request: Request,
    error: RequestValidationError,
) -> JSONResponse:
    del error
    if request.url.path == "/internal/search":
        return JSONResponse(status_code=415, content={"detail": {"code": "INVALID_FILE"}})
    if request.url.path == "/internal/palette-search":
        return JSONResponse(
            status_code=422,
            content={"detail": {"code": "INVALID_COLORS"}},
        )
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
    dependencies=[Depends(require_internal_token), Depends(_require_search_running)],
    response_model=InternalSearchResponse,
)
async def internal_search(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    service: Annotated[SearchService, Depends(get_search_service)],
    limiter: Annotated[SearchConcurrencyLimiter, Depends(get_search_limiter)],
) -> InternalSearchResponse:
    temp_path: Path | None = None
    acquired = False
    work_task: asyncio.Task[SearchResult] | None = None
    multipart: SearchMultipart | None = None
    try:
        multipart = await _parse_search_multipart(request)
        owner_id = _canonical_uuid(multipart.owner_id)
        allowed_ids = _allowed_pattern_ids(multipart.allowed_pattern_ids)
        request_id = _canonical_uuid(multipart.request_id)
        temp_path = await _save_upload(multipart.image, settings.temp_dir)
        encoded = temp_path.read_bytes()

        acquired = await limiter.try_acquire()
        if not acquired:
            raise _error(429, "BUSY")
        work_task = _create_search_task(
            service,
            limiter,
            owner_id,
            allowed_ids,
            encoded,
        )
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
            if multipart is not None:
                await multipart.form.close()
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)


@app.post(
    "/internal/palette-search",
    dependencies=[
        Depends(require_internal_token),
        Depends(_require_search_running),
        Depends(_require_json_content_type),
    ],
    response_model=InternalPaletteSearchResponse,
)
async def internal_palette_search(
    body: InternalPaletteSearchRequest,
    service: Annotated[SearchService, Depends(get_search_service)],
    limiter: Annotated[SearchConcurrencyLimiter, Depends(get_search_limiter)],
) -> InternalPaletteSearchResponse:
    acquired = False
    work_task: asyncio.Task[PaletteSearchResult] | None = None
    try:
        acquired = await limiter.try_acquire()
        if not acquired:
            raise _error(503, "UNAVAILABLE")
        work_task = _create_palette_search_task(service, limiter, body)
        try:
            result = await _await_search(work_task)
        except (TimeoutError, asyncio.TimeoutError) as error:
            raise _error(504, "TIMEOUT") from error
        return _palette_response(body.request_id, result)
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
