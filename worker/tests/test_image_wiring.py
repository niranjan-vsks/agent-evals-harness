"""The Dockerfile and docker-compose.yml wiring of the manifest pins. Read as text: the files are only there when the
worker directory is (Dockerfile) or the repo root is mounted next to it (docker-compose.yml), so each check skips when its file is absent."""
from pathlib import Path

import pytest

WORKER_DIR = Path(__file__).resolve().parent.parent
DOCKERFILE = WORKER_DIR / "Dockerfile"
COMPOSE = WORKER_DIR.parent / "docker-compose.yml"


def _text(path: Path) -> str:
    if not path.is_file():
        pytest.skip(f"{path.name} is not in this tree")
    return path.read_text(encoding="utf-8")


def _compose_worker() -> str:
    text = _text(COMPOSE)
    return text.split("\n  worker:\n", 1)[1].split("\n  web:\n", 1)[0]


def test_the_image_bakes_the_commit_it_was_built_from():
    text = _text(DOCKERFILE)
    assert "ARG GIT_COMMIT" in text
    assert "LABEL org.opencontainers.image.revision=${GIT_COMMIT}" in text
    assert "ENV WORKER_COMMIT=${GIT_COMMIT}" in text


def test_compose_passes_the_commit_and_the_image_digest():
    worker = _compose_worker()
    assert "GIT_COMMIT: ${GIT_COMMIT:-unknown}" in worker
    assert "IMAGE_DIGEST: ${IMAGE_DIGEST:-}" in worker
