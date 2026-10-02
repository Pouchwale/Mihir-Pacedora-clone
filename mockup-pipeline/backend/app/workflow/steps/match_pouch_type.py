"""match_pouch_type: pick the pouch type from the index match rules (spec 3.1).

Precedence: the operator's pick (job.inputs["pouch_type"]) > the workflow's SET POUCH TYPE node
(job.inputs["workflow_pouch_type"], set by the graph runner while that node runs) > the item
override > the match rules. No match or several matches at the deciding priority -> NEEDS_REVIEW
with a type picker.
"""

from pydantic import BaseModel

from app.errors import NeedsReview
from app.index.conditions import spec_context
from app.index.resolve import MatchResult, match_pouch_type
from app.workflow.context import StepContext
from app.workflow.steps.validate import Output as ValidateOutput


class Output(BaseModel):
    pouch_type: str
    source: str  # matched, override (item override), workflow (SET POUCH TYPE node), operator
    match: MatchResult
    pouch_type_version: int


def run(ctx: StepContext) -> Output:
    sheet = ctx.output("validate", ValidateOutput).sheet
    types = ctx.index.all("pouch_type")
    item = ctx.index.get("item_override", (sheet.spec_table.item_no.value or "").lower())
    result = match_pouch_type(types, spec_context(sheet), item)
    chosen, source = result.pouch_type, result.status
    picked = ctx.inputs.get("pouch_type")
    workflow_pick = ctx.inputs.get("workflow_pouch_type")
    if picked:
        if picked not in types:
            raise NeedsReview("unknown_pouch_type", f"Pouch type {picked!r} is not in the index", {"form": "pouch_type", "candidates": list(types)})
        chosen, source = picked, "operator"
    elif workflow_pick:
        if workflow_pick not in types:
            raise NeedsReview("unknown_pouch_type", f"The workflow sets pouch type {workflow_pick!r}, which is not in the index",
                              {"form": "pouch_type", "candidates": list(types), "all_types": {k: t.name for k, t in types.items()}})
        chosen, source = workflow_pick, "workflow"
    elif result.needs_review:
        what = "No pouch type matched" if result.status == "no_match" else f"Several pouch types matched: {', '.join(result.candidates)}"
        raise NeedsReview("pouch_type", what, {
            "form": "pouch_type",
            "candidates": result.candidates,
            "all_types": {k: t.name for k, t in types.items()},
            "evaluated": [e.model_dump() for e in result.evaluated],
        })
    ctx.job.pouch_type = chosen
    ctx.log(f"Pouch type {chosen} ({source})", "audit", {"pouch_type": chosen, "source": source})
    return Output(pouch_type=chosen, source=source, match=result, pouch_type_version=ctx.index.version("pouch_type", chosen) or 0)
