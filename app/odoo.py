"""Mirror submitted tickets into Odoo.

Odoo is a downstream sink: the monitor owns the ticket, Odoo receives a copy in
the `codepr.monitor.ticket` model provided by the bundled addon (see
odoo-addon/codepr_monitor).

JSON-RPC is used instead of XML-RPC because odoo.code.pr sits behind Cloudflare
Access, and this lets the service-token headers ride along on every request.
"""

from __future__ import annotations

import logging
import threading
from datetime import timezone
from typing import Any

import httpx
from sqlalchemy import select

from .config import get_settings
from .db import session_scope
from .models import Ticket
from .models import utcnow

log = logging.getLogger(__name__)
settings = get_settings()

ODOO_MODEL = "codepr.monitor.ticket"
ODOO_DATETIME_FMT = "%Y-%m-%d %H:%M:%S"


class OdooError(RuntimeError):
    pass


def _cf_headers() -> dict[str, str]:
    if not settings.has_cf_access_token:
        return {}
    return {
        "CF-Access-Client-Id": settings.cf_access_client_id,
        "CF-Access-Client-Secret": settings.cf_access_client_secret,
    }


def _call(client: httpx.Client, service: str, method: str, args: list[Any]) -> Any:
    payload = {
        "jsonrpc": "2.0",
        "method": "call",
        "params": {"service": service, "method": method, "args": args},
        "id": 1,
    }
    response = client.post(
        f"{settings.odoo_url.rstrip('/')}/jsonrpc",
        json=payload,
        headers={"Content-Type": "application/json", **_cf_headers()},
    )

    if "cloudflareaccess.com" in (response.url.host or ""):
        raise OdooError(
            "Blocked by Cloudflare Access — configure a service token authorized "
            "for odoo.code.pr, or add a bypass policy for /jsonrpc."
        )

    response.raise_for_status()
    data = response.json()
    if "error" in data:
        message = data["error"].get("data", {}).get("message") or data["error"].get(
            "message", "unknown Odoo error"
        )
        raise OdooError(message)
    return data.get("result")


def _authenticate(client: httpx.Client) -> int:
    uid = _call(
        client,
        "common",
        "login",
        [settings.odoo_db, settings.odoo_username, settings.odoo_password],
    )
    if not uid:
        raise OdooError("Odoo rejected the credentials (check ODOO_DB / user / password).")
    return int(uid)


def _ticket_values(ticket: Ticket) -> dict[str, Any]:
    submitted = ticket.submitted_at
    if submitted.tzinfo is not None:
        submitted = submitted.astimezone(timezone.utc).replace(tzinfo=None)
    return {
        "name": ticket.subject,
        "description": ticket.body,
        "site_name": ticket.site.name,
        "site_url": ticket.site.url,
        "submitted_by": ticket.user.full_name,
        "submitted_at": submitted.strftime(ODOO_DATETIME_FMT),
        "kind": ticket.kind.value,
        "state": ticket.status.value,
        "monitor_ref": str(ticket.id),
    }


def sync_ticket(ticket_id: int) -> None:
    """Push one ticket to Odoo and record the outcome on the local row."""
    if not settings.odoo_enabled:
        log.debug("Odoo push disabled; skipping ticket %s", ticket_id)
        return

    with session_scope() as db:
        ticket = db.scalar(select(Ticket).where(Ticket.id == ticket_id))
        if ticket is None:
            log.warning("Ticket %s vanished before Odoo sync", ticket_id)
            return

        values = _ticket_values(ticket)
        try:
            with httpx.Client(timeout=30.0, follow_redirects=True) as client:
                uid = _authenticate(client)

                def execute(method: str, args: list[Any]) -> Any:
                    return _call(
                        client,
                        "object",
                        "execute_kw",
                        [
                            settings.odoo_db,
                            uid,
                            settings.odoo_password,
                            ODOO_MODEL,
                            method,
                            args,
                        ],
                    )

                # An earlier attempt may have created the record but lost the
                # response, so adopt an existing match rather than duplicating.
                existing = execute(
                    "search", [[["monitor_ref", "=", values["monitor_ref"]]]]
                )
                odoo_id = existing[0] if existing else execute("create", [values])

            ticket.odoo_id = int(odoo_id)
            ticket.odoo_synced_at = utcnow()
            ticket.odoo_error = ""
            log.info("Ticket %s mirrored to Odoo as %s", ticket_id, odoo_id)
        except (OdooError, httpx.HTTPError) as exc:
            # The local ticket is still valid; the mirror is best-effort and
            # retryable from the admin UI.
            ticket.odoo_error = str(exc)[:512]
            log.warning("Odoo sync failed for ticket %s: %s", ticket_id, exc)


def sync_ticket_background(ticket_id: int) -> None:
    """Fire-and-forget push so submitting a ticket never waits on Odoo."""
    if not settings.odoo_enabled:
        return
    threading.Thread(
        target=sync_ticket, args=(ticket_id,), name=f"odoo-sync-{ticket_id}", daemon=True
    ).start()
