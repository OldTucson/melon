from __future__ import annotations

import hashlib
import os
import secrets
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from .embedding import load_model_contract

PREFLIGHT_ERROR_CODE = "IMAGE_SEARCH_CONTAINER_PREFLIGHT_FAILED"


class ContainerPreflightError(RuntimeError):
    code = PREFLIGHT_ERROR_CODE

    def __init__(self) -> None:
        super().__init__(self.code)


def _required_environment(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name)
    if value is None or not value or value != value.strip():
        raise ContainerPreflightError()
    return value


def verify_model_artifact(
    *,
    lock_path: Path,
    model_path: Path,
    expected_sha256: str,
) -> None:
    try:
        contract = load_model_contract(lock_path)
        if not secrets.compare_digest(
            expected_sha256,
            contract.artifact_sha256,
        ):
            raise ContainerPreflightError()
        if not model_path.is_file():
            raise ContainerPreflightError()
        if model_path.stat().st_size != contract.artifact_size_bytes:
            raise ContainerPreflightError()
        digest = hashlib.sha256()
        with model_path.open("rb") as model_file:
            for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
                digest.update(chunk)
        if not secrets.compare_digest(digest.hexdigest(), expected_sha256):
            raise ContainerPreflightError()
    except ContainerPreflightError:
        raise
    except Exception as error:
        raise ContainerPreflightError() from error


ExecFunction = Callable[[str, list[str]], object]


def run(
    argv: Sequence[str],
    *,
    environ: Mapping[str, str] = os.environ,
    exec_fn: ExecFunction = os.execvp,
) -> int:
    command = list(argv)
    if not command:
        raise ContainerPreflightError()
    lock_path = Path(
        _required_environment(environ, "VISUAL_SEARCH_MODEL_LOCK_PATH")
    )
    model_path = Path(_required_environment(environ, "VISUAL_SEARCH_MODEL_PATH"))
    expected_sha256 = _required_environment(
        environ,
        "VISUAL_SEARCH_MODEL_SHA256",
    )
    verify_model_artifact(
        lock_path=lock_path,
        model_path=model_path,
        expected_sha256=expected_sha256,
    )
    exec_fn(command[0], command)
    return 0


def main() -> int:
    try:
        return run(sys.argv[1:])
    except Exception:
        print(PREFLIGHT_ERROR_CODE, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
