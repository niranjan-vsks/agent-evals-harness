#!/usr/bin/env bash
# Builds the worker image, then starts the stack with what it was built from pinned in the worker manifest:
# worker_manifest.commit (the git commit, "-dirty" when the tree has changes) and worker_manifest.image_digest (the built image's id).
# Usage: scripts/up.sh [docker compose up args]   e.g. scripts/up.sh -d
# On a host that needs it (OneDrive checkout): DOCKER_BUILDKIT=0 COMPOSE_BAKE=false scripts/up.sh -d
set -euo pipefail
cd "$(dirname "$0")/.."

GIT_COMMIT="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then GIT_COMMIT="${GIT_COMMIT}-dirty"; fi
export GIT_COMMIT

docker compose build worker
project="${COMPOSE_PROJECT_NAME:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]')}"
IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "${project}-worker" 2>/dev/null || true)"
export IMAGE_DIGEST

echo "worker image ${IMAGE_DIGEST:-<unknown, the manifest will carry the commit only>} built from ${GIT_COMMIT}"
exec docker compose up "$@"
