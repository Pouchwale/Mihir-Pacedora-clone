"""Conditions over extracted specs, used by pouch-type match rules and material rules.

A rule is a list of groups; it holds when ANY group holds, and a group holds when ALL its
conditions hold ("stand-up AND bottom gusset" OR "doypack"). Text comparison ignores case,
hyphens, underscores and repeated spaces, so "Stand-up", "stand up" and "STAND_UP" are equal.
"""

import re
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.specs.schema import SpecSheet

Op = Literal["eq", "ne", "in", "not_in", "contains", "not_contains", "gt", "gte", "lt", "lte", "exists", "missing", "is_true", "is_false"]


class Condition(BaseModel):
    field: str = Field(description="Context path, e.g. spec.sealing_type, spec.gusset_type, panels")
    op: Op
    value: Any = None


class RuleGroup(BaseModel):
    all: list[Condition] = Field(min_length=1)


def norm(value: Any) -> Any:
    if isinstance(value, str):
        return re.sub(r"\s+", " ", re.sub(r"[-_]", " ", value)).strip().lower()
    if isinstance(value, list):
        return [norm(v) for v in value]
    return value


def lookup(ctx: dict, path: str) -> Any:
    cur: Any = ctx
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def holds(cond: Condition, ctx: dict) -> bool:
    actual = lookup(ctx, cond.field)
    a, v = norm(actual), norm(cond.value)
    op = cond.op
    if op == "exists":
        return actual not in (None, "", [])
    if op == "missing":
        return actual in (None, "", [])
    if op == "is_true":
        return actual is True
    if op == "is_false":
        return actual is False
    if actual is None:
        return op in ("ne", "not_in", "not_contains")
    if op == "eq":
        return a == v
    if op == "ne":
        return a != v
    if op == "in":
        return a in (v if isinstance(v, list) else [v])
    if op == "not_in":
        return a not in (v if isinstance(v, list) else [v])
    if op in ("contains", "not_contains"):
        needles = v if isinstance(v, list) else [v]
        haystack = a if isinstance(a, list) else str(a)
        found = any((n in haystack) for n in needles)
        return found if op == "contains" else not found
    try:
        a_num, v_num = float(actual), float(cond.value)
    except (TypeError, ValueError):
        return False
    return {"gt": a_num > v_num, "gte": a_num >= v_num, "lt": a_num < v_num, "lte": a_num <= v_num}[op]


def matches(groups: list[RuleGroup], ctx: dict) -> bool:
    return any(all(holds(c, ctx) for c in g.all) for g in groups)


def explain(groups: list[RuleGroup], ctx: dict) -> list[list[dict]]:
    """Per group, per condition: whether it held and the actual value (for the rule tester UI)."""
    return [[{"field": c.field, "op": c.op, "value": c.value, "actual": lookup(ctx, c.field), "holds": holds(c, ctx)} for c in g.all] for g in groups]


def spec_context(sheet: SpecSheet, panels: list[str] | None = None) -> dict:
    """Flat context for rules: spec.<field> = value, measured.<field> = value, panels, film text."""
    spec: dict[str, Any] = {}
    for name, field in sheet.spec_table:
        value = getattr(field, "value", None)
        if hasattr(value, "value"):  # enums
            value = value.value
        if name == "layers":
            value = [f"{l.micron:g} mic {l.material}" if l.micron else l.material for l in (value or [])]
        spec[name] = value
    spec["layers_text"] = " / ".join(spec.get("layers") or [])
    measured = {name: getattr(f, "value", f) for name, f in sheet.measured_keyline if name != "labels"}
    return {
        "spec": spec,
        "measured": measured,
        "linked_codes": sheet.linked_codes,
        "panels": sorted({"front", *sheet.linked_codes, *(panels or [])}),
    }
