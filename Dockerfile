FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

# curl backs the healthcheck; sqlite3 is here to read the pre-PostgreSQL
# database file, and can go once that migration is done. Backups of the live
# database are taken with pg_dump from the `db` service, not from here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl sqlite3 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Mount point for the pre-PostgreSQL SQLite volume, which the app now mounts
# read-only so migrate_to_postgres.py can read it. The directory must exist in
# the image and be owned by appuser, because Docker seeds a fresh named volume
# from the image's directory. Removable with the migration.
RUN mkdir -p /srv/data

# Do not run the app as root.
RUN useradd --uid 1000 --create-home appuser \
    && chown -R appuser:appuser /srv
USER appuser

VOLUME ["/srv/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/healthz || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
