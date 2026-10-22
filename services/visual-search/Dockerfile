FROM ghcr.io/astral-sh/uv:0.13.3 AS uv

FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    VISUAL_SEARCH_MODEL_LOCK_PATH=/app/services/visual-search/model-lock.json \
    VISUAL_SEARCH_MODEL_PATH=/models/dinov2-small.onnx

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 melon \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin melon

COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /app/services/visual-search
COPY services/visual-search/pyproject.toml services/visual-search/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY services/visual-search/model-lock.json ./model-lock.json
COPY services/visual-search/config ./config
COPY services/visual-search/src ./src
RUN uv sync --frozen --no-dev \
    && mkdir -p /tmp/melon-visual-search \
    && chown -R melon:melon /app/services/visual-search /tmp/melon-visual-search

ENV PATH="/app/services/visual-search/.venv/bin:${PATH}"

USER melon:melon
EXPOSE 8091

ENTRYPOINT ["python", "-m", "melon_visual_search.container_entrypoint"]
CMD ["uvicorn", "melon_visual_search.app:app", "--host", "0.0.0.0", "--port", "8091", "--workers", "1", "--no-access-log"]
