FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global --add safe.directory /kubespray

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend ./backend
COPY static ./static

WORKDIR /app/backend
ENV KUBESPRAY_ROOT=/kubespray

EXPOSE 8420
CMD ["python3", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8420"]
