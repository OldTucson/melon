from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import (
    AliasChoices,
    Field,
    SecretStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic.functional_validators import ModelWrapValidatorHandler
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "production"]

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_REGION_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_BUCKET_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
_VERSION_PATTERN = re.compile(r"^[a-z0-9-]{1,64}$")
_DATABASE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,63}$")


class Settings(BaseSettings):
    """Validated runtime configuration loaded from ``VISUAL_SEARCH_*``."""

    model_config = SettingsConfigDict(
        env_prefix="VISUAL_SEARCH_",
        extra="ignore",
        populate_by_name=True,
        hide_input_in_errors=True,
    )

    database_url: SecretStr | None = None
    oss_region: str | None = None
    oss_bucket: str | None = None
    oss_endpoint: str | None = None
    internal_token: SecretStr = Field(min_length=32)
    active_version: str = "visual-search-v2"
    model_path: Path | None = None
    model_sha256: str | None = None
    production_database_name: str | None = None
    feature_storage_dir: Path | None = None
    temp_dir: Path = Path("/tmp/melon-visual-search")
    max_concurrency: int = Field(default=1, gt=0)
    host: str = "127.0.0.1"
    port: int = Field(default=8091, ge=1, le=65535)
    environment: Environment = Field(
        default="development",
        validation_alias=AliasChoices("VISUAL_SEARCH_ENV", "VISUAL_SEARCH_ENVIRONMENT"),
    )

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        parsed = urlsplit(value.get_secret_value())
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
            raise ValueError("database URL must be a PostgreSQL URL")
        return value

    @field_validator("oss_region")
    @classmethod
    def validate_oss_region(cls, value: str | None) -> str | None:
        if value is not None and (
            not _REGION_PATTERN.fullmatch(value) or value.startswith("oss-")
        ):
            raise ValueError(
                "OSS region must be lowercase dash-separated without an oss- prefix"
            )
        return value

    @field_validator("oss_bucket")
    @classmethod
    def validate_oss_bucket(cls, value: str | None) -> str | None:
        if value is not None and not _BUCKET_PATTERN.fullmatch(value):
            raise ValueError("OSS bucket must be a canonical DNS-compatible name")
        return value

    @field_validator("oss_endpoint")
    @classmethod
    def validate_oss_endpoint(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlsplit(value)
        has_path = parsed.path not in {"", "/"}
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or has_path
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("OSS endpoint must be an HTTP origin without credentials")
        return value.removesuffix("/")

    @field_validator("internal_token")
    @classmethod
    def validate_internal_token(cls, value: SecretStr) -> SecretStr:
        token = value.get_secret_value()
        if not token.isascii() or any(character.isspace() for character in token):
            raise ValueError("internal token must contain non-whitespace ASCII characters only")
        return value

    @field_validator("active_version")
    @classmethod
    def validate_active_version(cls, value: str) -> str:
        if not _VERSION_PATTERN.fullmatch(value):
            raise ValueError("active version must be lowercase and URL-safe")
        return value

    @field_validator("model_path", "feature_storage_dir", "temp_dir", mode="before")
    @classmethod
    def validate_path(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            raise ValueError("path must not be empty")
        return value

    @field_validator("feature_storage_dir")
    @classmethod
    def validate_feature_storage_dir(cls, value: Path | None) -> Path | None:
        if value is not None and not value.is_absolute():
            raise ValueError("local feature storage directory must be absolute")
        return value

    @field_validator("model_sha256")
    @classmethod
    def validate_model_sha256(cls, value: str | None) -> str | None:
        if value is not None and not _SHA256_PATTERN.fullmatch(value):
            raise ValueError("model SHA-256 must be 64 lowercase hexadecimal characters")
        return value

    @field_validator("production_database_name")
    @classmethod
    def validate_production_database_name(cls, value: str | None) -> str | None:
        if value is not None and not _DATABASE_NAME_PATTERN.fullmatch(value):
            raise ValueError("production database name must be a canonical identifier")
        return value

    @field_validator("host")
    @classmethod
    def validate_host(cls, value: str) -> str:
        if not value or value != value.strip():
            raise ValueError("host must not be empty or padded")
        return value

    @model_validator(mode="after")
    def validate_production_contract(self) -> Settings:
        if self.environment != "production":
            return self

        if self.feature_storage_dir is not None:
            raise ValueError("local feature storage is forbidden in production")

        if self.host not in {"127.0.0.1", "::1"}:
            raise ValueError("production host must be 127.0.0.1 or ::1")

        required = {
            "database_url": self.database_url,
            "oss_region": self.oss_region,
            "oss_bucket": self.oss_bucket,
            "oss_endpoint": self.oss_endpoint,
            "model_path": self.model_path,
            "model_sha256": self.model_sha256,
        }
        missing = sorted(name for name, value in required.items() if value is None)
        if missing:
            raise ValueError(f"production settings are missing: {', '.join(missing)}")
        if self.oss_endpoint is not None and not self.oss_endpoint.startswith("https://"):
            raise ValueError("production OSS endpoint must use HTTPS")
        return self

    @model_validator(mode="wrap")
    @classmethod
    def remove_inputs_from_validation_errors(
        cls,
        values: object,
        handler: ModelWrapValidatorHandler[Settings],
    ) -> Settings:
        try:
            return handler(values)
        except ValidationError as error:
            sanitized_errors: list[Any] = []
            for error_detail in error.errors(include_url=False):
                sanitized_detail = dict(error_detail)
                sanitized_detail["input"] = None
                sanitized_errors.append(sanitized_detail)
            raise ValidationError.from_exception_data(
                cls.__name__,
                sanitized_errors,
                hide_input=True,
            ) from None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    # BaseSettings supplies required values from the environment at runtime.
    return Settings()  # type: ignore[call-arg]
