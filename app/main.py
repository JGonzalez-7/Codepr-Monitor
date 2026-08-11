"""CodePR-Monitor application entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import models  # noqa: F401 — registers tables on Base before create_all
from .config import get_settings
from .db import Base, SessionLocal, engine
from .monitor import runner
from .routers import admin, api, auth, client
from .seed import run_seed
from .templating import STATIC_DIR, templates

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s"
)
log = logging.getLogger(__name__)
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        run_seed(db)
    finally:
        db.close()

    runner.start()
    try:
        yield
    finally:
        runner.stop()


app = FastAPI(
    title="CodePR-Monitor",
    description="Uptime tracking for CodePR web properties.",
    version="0.1.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

app.include_router(auth.router)
app.include_router(client.router)
app.include_router(admin.router)
app.include_router(api.router)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Send browsers to the login page, but keep /api responses as JSON."""
    is_api = request.url.path.startswith("/api")
    location = (exc.headers or {}).get("Location")

    if location and not is_api:
        return RedirectResponse(location, status_code=303)

    if is_api:
        # An auth redirect is not meaningful to a fetch() caller.
        status_code = 401 if location else exc.status_code
        return JSONResponse({"detail": exc.detail}, status_code=status_code)

    return templates.TemplateResponse(
        request,
        "error.html",
        {"status_code": exc.status_code, "detail": exc.detail},
        status_code=exc.status_code,
    )
