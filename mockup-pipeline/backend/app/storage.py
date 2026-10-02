"""Object storage. Production uses an S3-compatible bucket (Cloudflare R2 or AWS S3), because Render
disks attach to one service only and the API and worker both need the files. Dev and tests use a
local folder. Keys are POSIX-style paths such as "jobs/12/FGPO7215_front_finished.png"."""

from functools import lru_cache
from pathlib import Path
from typing import Protocol


class Storage(Protocol):
    def put_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str: ...

    def get_bytes(self, key: str) -> bytes: ...

    def exists(self, key: str) -> bool: ...


class LocalStorage:
    def __init__(self, root: Path):
        self.root = Path(root)

    def path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root.resolve() not in path.parents:
            raise ValueError(f"invalid storage key {key!r}")
        return path

    def put_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        path = self.path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return key

    def get_bytes(self, key: str) -> bytes:
        return self.path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self.path(key).exists()


class S3Storage:
    def __init__(self, bucket: str, endpoint_url: str | None, access_key: str, secret_key: str, region: str):
        import boto3

        self.bucket = bucket
        self.client = boto3.client(
            "s3", endpoint_url=endpoint_url or None, aws_access_key_id=access_key,
            aws_secret_access_key=secret_key, region_name=region or "auto",
        )

    def put_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)
        return key

    def get_bytes(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except self.client.exceptions.ClientError:
            return False


@lru_cache
def get_storage() -> Storage:
    from app.config import get_settings

    s = get_settings()
    if s.s3_bucket:
        return S3Storage(s.s3_bucket, s.s3_endpoint_url, s.s3_access_key_id, s.s3_secret_access_key, s.s3_region)
    return LocalStorage(s.work_dir / "storage")
