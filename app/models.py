"""ORM models: users, monitored sites, check history, and tickets."""

from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Table,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# Which pages a client may see and raise tickets about. Admins are not listed
# here; they are unrestricted by rule, so an empty row set for an admin never
# means "no access".
user_sites = Table(
    "user_sites",
    Base.metadata,
    Column(
        "user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    ),
    Column(
        "site_id", ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True
    ),
)


class CheckStatus(str, enum.Enum):
    """Outcome of a single probe.

    DEGRADED covers "reachable, but the response does not prove the app is
    healthy" — most importantly a Cloudflare Access login redirect, which would
    otherwise be indistinguishable from a healthy 200.
    """

    UP = "up"
    DEGRADED = "degraded"
    DOWN = "down"


class TicketKind(str, enum.Enum):
    ISSUE = "issue"
    FIX = "fix"


class TicketStatus(str, enum.Enum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    RESOLVED = "resolved"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(128))
    email: Mapped[str] = mapped_column(String(255), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    tickets: Mapped[list[Ticket]] = relationship(back_populates="user")
    sites: Mapped[list[Site]] = relationship(
        secondary=user_sites, back_populates="users", order_by="Site.name"
    )


class Site(Base):
    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    url: Mapped[str] = mapped_column(String(512))
    description: Mapped[str] = mapped_column(String(512), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Send the Cloudflare Access service token with this site's probes.
    uses_cf_access: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    checks: Mapped[list[Check]] = relationship(
        back_populates="site", cascade="all, delete-orphan"
    )
    tickets: Mapped[list[Ticket]] = relationship(back_populates="site")
    users: Mapped[list[User]] = relationship(
        secondary=user_sites, back_populates="sites"
    )


class Check(Base):
    __tablename__ = "checks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), index=True
    )
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )
    status: Mapped[CheckStatus] = mapped_column(Enum(CheckStatus, native_enum=False))
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    detail: Mapped[str] = mapped_column(String(512), default="")

    site: Mapped[Site] = relationship(back_populates="checks")


class Ticket(Base):
    __tablename__ = "tickets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)

    subject: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[TicketKind] = mapped_column(
        Enum(TicketKind, native_enum=False), default=TicketKind.ISSUE
    )
    status: Mapped[TicketStatus] = mapped_column(
        Enum(TicketStatus, native_enum=False), default=TicketStatus.OPEN
    )
    # Submission timestamp shown to clients and mirrored into Odoo.
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )

    # Odoo mirror bookkeeping.
    odoo_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    odoo_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    odoo_error: Mapped[str] = mapped_column(String(512), default="")

    site: Mapped[Site] = relationship(back_populates="tickets")
    user: Mapped[User] = relationship(back_populates="tickets")
    attachments: Mapped[list[TicketAttachment]] = relationship(
        back_populates="ticket",
        cascade="all, delete-orphan",
        order_by="TicketAttachment.id",
    )


class TicketAttachment(Base):
    """A screenshot attached to a ticket.

    The bytes live here rather than on disk because the app container mounts no
    volume: its filesystem is rebuilt with every image, while this table sits in
    the Postgres volume that survives one. Storing them also keeps reads behind
    an authenticated route — see app/attachments.py.
    """

    __tablename__ = "ticket_attachments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ticket_id: Mapped[int] = mapped_column(
        ForeignKey("tickets.id", ondelete="CASCADE"), index=True
    )

    # Display label only; never used to touch the filesystem.
    filename: Mapped[str] = mapped_column(String(120))
    # Sniffed from the file's leading bytes, not taken from the browser.
    content_type: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    data: Mapped[bytes] = mapped_column(LargeBinary)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    ticket: Mapped[Ticket] = relationship(back_populates="attachments")
