FROM python:3.14-slim

# ADAPTERS.md section 3 "Install". Build context is ./worker.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

ARG HERMES_COMMIT=f4ac0bea1ea50bba62886fb0b7e308e4edee8fd3
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
 && cd /opt/hermes-agent && git checkout ${HERMES_COMMIT}
# A-1 fallbacks if this step fails: add build-essential above, or `--no-deps` then install the
# dependencies of pyproject.toml minus nemo-relay. Not needed on the host install (STATE.md).
RUN pip install --no-cache-dir -e /opt/hermes-agent
ENV HERMES_ADAPTER_VERSION=${HERMES_COMMIT}

WORKDIR /app
COPY requirements.txt /app/worker/requirements.txt
RUN pip install --no-cache-dir -r /app/worker/requirements.txt
COPY . /app/worker
ENV PYTHONPATH=/app
ENV WORK_DIR=/work TASKS_DIR=/tasks
RUN mkdir -p /work /tasks

EXPOSE 8000
WORKDIR /app/worker
CMD ["uvicorn", "worker.server:app", "--host", "0.0.0.0", "--port", "8000"]
