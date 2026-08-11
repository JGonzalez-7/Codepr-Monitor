"""Background uptime checker.

This is the data source behind the custom client/admin UI. Uptime Kuma runs
alongside it for deeper drill-down, but the friendly status view is served from
these checks so it stays under our control and needs no Kuma login.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import session_scope
from .models import Check, CheckStatus, Site

log = logging.getLogger(__name__)
settings = get_settings()

USER_AGENT = "CodePR-Monitor/0.1 (+uptime checker)"

# Cloudflare Zero Trust bounces unauthenticated traffic to this host. Seeing it
# means the probe never reached the origin, so the origin's health is unknown.
CF_ACCESS_LOGIN_HOST = "cloudflareaccess.com"


@dataclass(frozen=True)
class ProbeResult:
    status: CheckStatus
    http_status: int | None
    response_ms: float | None
    detail: str


def _headers_for(site: Site) -> dict[str, str]:
    headers = {"User-Agent": USER_AGENT}
    if site.uses_cf_access and settings.has_cf_access_token:
        headers["CF-Access-Client-Id"] = settings.cf_access_client_id
        headers["CF-Access-Client-Secret"] = settings.cf_access_client_secret
    return headers


def _hit_cf_access_wall(response: httpx.Response) -> bool:
    """True when the request was intercepted by Cloudflare Access."""
    if CF_ACCESS_LOGIN_HOST in (response.url.host or ""):
        return True
    for hop in [*response.history, response]:
        if hop.headers.get("www-authenticate", "").startswith("Cloudflare-Access"):
            return True
        if CF_ACCESS_LOGIN_HOST in hop.headers.get("location", ""):
            return True
    return False


def probe(site: Site, client: httpx.Client) -> ProbeResult:
    """Perform one HTTP check and classify the outcome."""
    try:
        response = client.get(site.url, headers=_headers_for(site))
    except httpx.TimeoutException:
        return ProbeResult(
            CheckStatus.DOWN,
            None,
            None,
            f"No response within {settings.request_timeout_seconds:g}s.",
        )
    except httpx.RequestError as exc:
        return ProbeResult(
            CheckStatus.DOWN, None, None, f"Could not connect: {type(exc).__name__}."
        )

    elapsed_ms = response.elapsed.total_seconds() * 1000
    code = response.status_code

    if _hit_cf_access_wall(response):
        reason = (
            "service token was rejected"
            if settings.has_cf_access_token
            else "no service token configured"
        )
        return ProbeResult(
            CheckStatus.DEGRADED,
            code,
            elapsed_ms,
            f"Blocked by Cloudflare Access — {reason}. Origin health unknown.",
        )

    if 200 <= code < 300:
        return ProbeResult(CheckStatus.UP, code, elapsed_ms, f"HTTP {code}")
    if 300 <= code < 400:
        return ProbeResult(
            CheckStatus.DEGRADED, code, elapsed_ms, f"Unresolved redirect (HTTP {code})"
        )
    return ProbeResult(CheckStatus.DOWN, code, elapsed_ms, f"HTTP {code}")


def check_all_sites() -> int:
    """Probe every active site once and record the results."""
    checked = 0
    with httpx.Client(
        follow_redirects=True,
        timeout=settings.request_timeout_seconds,
        verify=True,
    ) as client:
        with session_scope() as db:
            sites = db.scalars(select(Site).where(Site.is_active.is_(True))).all()
            for site in sites:
                result = probe(site, client)
                db.add(
                    Check(
                        site_id=site.id,
                        status=result.status,
                        http_status=result.http_status,
                        response_ms=result.response_ms,
                        detail=result.detail,
                    )
                )
                checked += 1
                log.info(
                    "check %s -> %s (%s)", site.slug, result.status.value, result.detail
                )
    return checked


def prune_history() -> None:
    """Drop checks older than the retention window."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.history_retention_days)
    with session_scope() as db:
        db.execute(delete(Check).where(Check.checked_at < cutoff))


# --- Read helpers used by the UI ----------------------------------------


def latest_check(db: Session, site_id: int) -> Check | None:
    return db.scalar(
        select(Check)
        .where(Check.site_id == site_id)
        .order_by(Check.checked_at.desc())
        .limit(1)
    )


def recent_checks(db: Session, site_id: int, limit: int = 30) -> list[Check]:
    rows = db.scalars(
        select(Check)
        .where(Check.site_id == site_id)
        .order_by(Check.checked_at.desc())
        .limit(limit)
    ).all()
    return list(reversed(rows))


def uptime_percent(db: Session, site_id: int, hours: int = 24) -> float | None:
    """Share of checks in the window that were fully UP, or None if no data."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    total = db.scalar(
        select(func.count())
        .select_from(Check)
        .where(Check.site_id == site_id, Check.checked_at >= since)
    )
    if not total:
        return None
    up = db.scalar(
        select(func.count())
        .select_from(Check)
        .where(
            Check.site_id == site_id,
            Check.checked_at >= since,
            Check.status == CheckStatus.UP,
        )
    )
    return round((up or 0) / total * 100, 2)


def average_response_ms(db: Session, site_id: int, hours: int = 24) -> float | None:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    value = db.scalar(
        select(func.avg(Check.response_ms)).where(
            Check.site_id == site_id,
            Check.checked_at >= since,
            Check.response_ms.is_not(None),
        )
    )
    return round(float(value), 1) if value is not None else None


# --- Background runner ---------------------------------------------------


class MonitorRunner:
    """Daemon thread that re-checks every site on a fixed interval."""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="codepr-monitor", daemon=True
        )
        self._thread.start()
        log.info("Monitor started (every %ss)", settings.check_interval_seconds)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        log.info("Monitor stopped")

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                check_all_sites()
                prune_history()
            except Exception:
                # A failed round must never kill the loop.
                log.exception("Monitor round failed")
            self._stop.wait(settings.check_interval_seconds)


runner = MonitorRunner()
