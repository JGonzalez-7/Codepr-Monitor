"""Validation for ticket screenshot uploads.

Screenshots are stored in the database rather than on disk. The app container
mounts no volume, so anything written to its filesystem is lost on the next
image rebuild, while the Postgres volume survives one. Keeping the bytes in a
table also means every read goes through a route that can check who is asking,
instead of sitting under a guessable static URL.
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import BinaryIO

# A browser sends the type it inferred from the file extension, so it says
# nothing about the actual content. The real type is read from the leading bytes
# and that is what gets stored and served back.
#
# SVG is deliberately unsupported: it is a document format that can carry
# script, not a screenshot format, and serving one back to an admin would be a
# stored-XSS vector.
_PNG = b"\x89PNG\r\n\x1a\n"
_JPEG = b"\xff\xd8\xff"
_GIF87 = b"GIF87a"
_GIF89 = b"GIF89a"

ACCEPTED_LABEL = "PNG, JPEG, GIF, or WebP"
# Mirrors the sniffed formats; used for the file input's accept attribute.
ACCEPT_ATTRIBUTE = "image/png,image/jpeg,image/gif,image/webp"


class AttachmentError(ValueError):
    """A rejected upload. The message is written to be shown to the client."""


def sniff_image_type(data: bytes) -> str | None:
    """Return the image MIME type implied by the leading bytes, or None."""
    if data.startswith(_PNG):
        return "image/png"
    if data.startswith(_JPEG):
        return "image/jpeg"
    if data.startswith((_GIF87, _GIF89)):
        return "image/gif"
    # RIFF....WEBP — four size bytes sit between the two markers.
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def clean_filename(name: str) -> str:
    """Reduce a client-supplied name to a plain display label.

    The name is never used to touch the filesystem, but it is rendered back to
    the client and to admins, so it is stripped of directory components and of
    anything that would read as markup even before Jinja escapes it.
    """
    base = PurePosixPath(name.replace("\\", "/")).name
    base = re.sub(r"[^A-Za-z0-9._ -]", "_", base).strip()
    return (base or "screenshot")[:120]


def read_image(upload: BinaryIO, *, max_bytes: int, label: str) -> tuple[bytes, str]:
    """Read one upload, enforcing the size cap and the format allowlist.

    Returns the bytes and the sniffed content type. Reads one byte past the cap
    so an oversized file is rejected on its length rather than silently
    truncated to a corrupt image.
    """
    data = upload.read(max_bytes + 1)

    if not data:
        raise AttachmentError(f"{label} is empty.")

    if len(data) > max_bytes:
        raise AttachmentError(
            f"{label} is larger than {max_bytes // (1024 * 1024)} MB. "
            "Crop it or save it at a lower quality."
        )

    content_type = sniff_image_type(data)
    if content_type is None:
        raise AttachmentError(
            f"{label} is not an image the app recognises. Attach a "
            f"{ACCEPTED_LABEL} file."
        )

    return data, content_type
