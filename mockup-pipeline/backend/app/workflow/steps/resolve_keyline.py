"""resolve_keyline: every keyline value with its source (spec 3.2 precedence).

Job-level values entered by the operator (job.inputs["keyline_overrides"]) act as an item override
and win over the index's item override for the same field.
"""

from pydantic import BaseModel

from app.errors import NeedsReview
from app.index.conditions import spec_context
from app.index.resolve import ResolvedKeyline, find_client, resolve_keyline
from app.index.schemas import ItemOverride, PouchType
from app.workflow.context import StepContext
from app.workflow.steps.match_pouch_type import Output as MatchOutput
from app.workflow.steps.validate import Output as ValidateOutput


class Output(BaseModel):
    keyline: ResolvedKeyline
    template: str
    template_version: int
    client: str | None
    item_override: str | None
    job_overrides: dict


def run(ctx: StepContext) -> Output:
    sheet = ctx.output("validate", ValidateOutput).sheet
    type_key = ctx.output("match_pouch_type", MatchOutput).pouch_type
    pouch: PouchType = ctx.index.get("pouch_type", type_key)  # type: ignore[assignment]
    template = ctx.index.get("keyline_template", pouch.keyline_template)
    if template is None:
        raise RuntimeError(f"keyline template {pouch.keyline_template} missing from the index snapshot")
    client_key, client = find_client(ctx.index.all("client"), sheet.spec_table.client_name.value)
    item_key = (sheet.spec_table.item_no.value or "").lower()
    item: ItemOverride | None = ctx.index.get("item_override", item_key)  # type: ignore[assignment]
    job_values = ctx.inputs.get("keyline_overrides") or {}
    if job_values:
        item = (item or ItemOverride()).model_copy(update={"keyline_overrides": {**(item.keyline_overrides if item else {}), **job_values}})
    resolved = resolve_keyline(pouch.keyline_template, template, type_key, spec_context(sheet), client, item)  # type: ignore[arg-type]
    version = ctx.index.version("keyline_template", pouch.keyline_template) or 0
    ctx.job.keyline_template, ctx.job.keyline_version = pouch.keyline_template, version
    if resolved.issues:
        raise NeedsReview("keyline", f"{len(resolved.issues)} keyline value(s) are invalid", {
            "form": "keyline",
            "issues": [i.model_dump() for i in resolved.issues],
            "keyline": resolved.model_dump(mode="json"),
        })
    ctx.log(f"Keyline {pouch.keyline_template} v{version} resolved", "audit", {"template": pouch.keyline_template, "version": version})
    return Output(keyline=resolved, template=pouch.keyline_template, template_version=version,
                  client=client_key, item_override=item_key if ctx.index.get("item_override", item_key) else None, job_overrides=job_values)
