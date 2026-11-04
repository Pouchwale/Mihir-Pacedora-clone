"""Upload size limits, enforced while reading (an upload is never held in memory past the limit)."""

from fastapi import HTTPException, UploadFile

from app.config import get_settings

CHUNK = 1024 * 1024


def max_bytes() -> int:
    return get_settings().max_upload_mb * 1024 * 1024


async def read_limited(upload: UploadFile, limit: int | None = None) -> bytes:
    """The upload's bytes; 413 as soon as it passes `limit` (default: MAX_UPLOAD_MB)."""
    limit = max_bytes() if limit is None else limit
    out = bytearray()
    while chunk := await upload.read(CHUNK):
        out += chunk
        if len(out) > limit:
            raise HTTPException(413, f"{upload.filename or 'The upload'} is larger than {limit // (1024 * 1024)} MB")
    return bytes(out)
