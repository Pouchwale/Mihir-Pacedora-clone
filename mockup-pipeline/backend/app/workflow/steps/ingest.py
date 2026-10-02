"""ingest: verify the uploaded PDF and pin the index versions this job will use."""

from pydantic import BaseModel

from app.index import store
from app.workflow.context import StepContext


class Output(BaseModel):
    file_id: int
    filename: str
    sha256: str
    size: int
    item_code: str | None
    index_snapshot: dict[str, dict[str, int]]
    latest_index: bool


def run(ctx: StepContext) -> Output:
    job, f = ctx.job, ctx.job.file
    ctx.local_file(f)  # downloads and checks the SHA-256
    latest = bool(ctx.inputs.get("use_latest_index"))
    if job.index_snapshot is None or latest:
        job.index_snapshot = store.snapshot(ctx.session)
        inputs = dict(job.inputs or {})
        inputs.pop("use_latest_index", None)
        job.inputs = inputs
    ctx.log(f"Input {f.filename} sha256 {f.sha256[:12]}…", "audit", {"sha256": f.sha256, "size": f.size})
    return Output(file_id=f.id, filename=f.filename, sha256=f.sha256, size=f.size, item_code=f.item_code,
                  index_snapshot=job.index_snapshot, latest_index=latest)
