"""Index services used by the workflow: match a pouch type, resolve a keyline, resolve materials."""

from typing import Any, Literal

from pydantic import BaseModel

from app.index import formula
from app.index.conditions import explain, matches, norm
from app.index.schemas import ClientSettings, ItemOverride, KeylineField, KeylineTemplate, MaterialRule, PouchType
from app.specs.validate import Issue


# ---------------------------------------------------------------- pouch type matching
class TypeEvaluation(BaseModel):
    key: str
    name: str
    priority: int
    matched: bool
    groups: list[list[dict]]


class MatchResult(BaseModel):
    status: Literal["matched", "override", "no_match", "ambiguous"]
    pouch_type: str | None
    candidates: list[str]  # the types that matched at the deciding priority (for the type picker)
    evaluated: list[TypeEvaluation]

    @property
    def needs_review(self) -> bool:
        return self.status in ("no_match", "ambiguous")


def match_pouch_type(types: dict[str, PouchType], ctx: dict, item: ItemOverride | None = None) -> MatchResult:
    active = sorted(((k, t) for k, t in types.items() if t.active), key=lambda kt: (kt[1].priority, kt[0]))
    evaluated = [
        TypeEvaluation(key=k, name=t.name, priority=t.priority, matched=matches(t.match_rules, ctx), groups=explain(t.match_rules, ctx))
        for k, t in active
    ]
    if item and item.pouch_type:
        return MatchResult(status="override", pouch_type=item.pouch_type, candidates=[item.pouch_type], evaluated=evaluated)
    for priority in sorted({e.priority for e in evaluated}):
        hits = [e.key for e in evaluated if e.priority == priority and e.matched]
        if len(hits) == 1:
            return MatchResult(status="matched", pouch_type=hits[0], candidates=hits, evaluated=evaluated)
        if len(hits) > 1:
            return MatchResult(status="ambiguous", pouch_type=None, candidates=hits, evaluated=evaluated)
    return MatchResult(status="no_match", pouch_type=None, candidates=[k for k, _ in active], evaluated=evaluated)


# ---------------------------------------------------------------- keyline resolution
# Options the code supports even where an index entry saved before them does not list them yet
# (an index seeded before the butterfly hang hole has hang_hole_type [none, round, euro]).
CODE_OPTIONS: dict[str, tuple[str, ...]] = {"hang_hole_type": ("none", "round", "euro", "butterfly")}

def seed_fields(template_key: str) -> dict[str, KeylineField]:
    """The fields the shipped seed gives keyline template `template_key`. An index stored before a field
    was added never gets it until `cli seed-apply`: the live index had no hang_hole_width_mm or
    hang_hole_height_mm, so the job page's hole width and dome height were saved and silently ignored.
    resolve_keyline adds the fields a stored template lacks from here (the stored ones always win)."""
    if template_key not in _SEED_FIELDS:
        from pathlib import Path

        import yaml

        try:
            seed = yaml.safe_load((Path(__file__).parent / "seed" / "index.yaml").read_text(encoding="utf-8"))
            raw = (seed.get("keyline_template") or {}).get(template_key, {}).get("fields") or {}
            _SEED_FIELDS[template_key] = {k: KeylineField.model_validate(v) for k, v in raw.items()}
        except Exception:  # noqa: BLE001 - no seed to fall back on: the stored template alone, as before
            _SEED_FIELDS[template_key] = {}
    return _SEED_FIELDS[template_key]


_SEED_FIELDS: dict[str, dict[str, KeylineField]] = {}


Source =Literal["item_override", "client_override", "pouch_type", "measured", "spec_table", "default", "disabled"]


class ResolvedField(BaseModel):
    value: Any
    source: Source
    detail: str = ""  # the expression or override that produced it
    unit: str = ""


class ResolvedKeyline(BaseModel):
    template: str
    pouch_type: str
    fields: dict[str, ResolvedField]
    issues: list[Issue]

    def values(self) -> dict[str, Any]:
        return {k: f.value for k, f in self.fields.items()}


def resolve_keyline(
    template_key: str,
    template: KeylineTemplate,
    pouch_type_key: str,
    ctx: dict,
    client: ClientSettings | None = None,
    item: ItemOverride | None = None,
) -> ResolvedKeyline:
    resolved: dict[str, ResolvedField] = {}
    issues: list[Issue] = []
    in_progress: set[str] = set()
    fields = {**seed_fields(template_key), **template.fields}  # (stored fields win; shipped ones fill the gaps)
    client_values = {**(client.keyline_overrides.get("*", {}) if client else {}), **(client.keyline_overrides.get(pouch_type_key, {}) if client else {})}
    item_values = item.keyline_overrides if item else {}

    def lookup(ns: str, name: str) -> Any:
        if ns in ("spec", "measured"):
            return ctx.get(ns, {}).get(name)
        if name not in fields:
            raise formula.FormulaError(f"unknown keyline field {name!r} (spec.<field> or measured.<field>?)")
        return resolve(name).value

    def resolve(name: str) -> ResolvedField:
        if name in resolved:
            return resolved[name]
        if name in in_progress:
            raise formula.FormulaError(f"cycle at {name}")
        in_progress.add(name)
        try:
            resolved[name] = _field(name, fields[name])
        finally:
            in_progress.discard(name)
        return resolved[name]

    def _field(name: str, f: KeylineField) -> ResolvedField:
        # An item (or job page) value is a decision and switches a conditional field on: e.g. a window
        # region set on the job page for a pouch whose spec table says "no window".
        if f.enabled_when and not matches(f.enabled_when, ctx) and name not in item_values:
            return ResolvedField(value=None, source="disabled", detail="enabled_when is false", unit=f.unit)
        candidates: list[tuple[Source, str, Any]] = []
        if name in item_values:
            candidates.append(("item_override", "item override", item_values[name]))
        if name in client_values:
            candidates.append(("client_override", f"client {client.client_name}", client_values[name]))
        for source, detail, value in candidates:
            return _finish(name, f, source, detail, value)
        if f.formula:
            value = _try(name, f.formula, "formula")
            if value is not None:
                return _finish(name, f, "pouch_type", f"formula: {f.formula}", value)
        if f.pin and f.default is not None:
            return _finish(name, f, "pouch_type", "pinned default", f.default)
        for source, expr in (("measured", f.from_measured), ("spec_table", f.from_spec)):
            if expr:
                value = _try(name, expr, source)
                if source == "measured" and f.from_spec and not _in_range(f, value):
                    # A drawing segment that cannot be this field (FGPO4583 labels the 255 mm body, not a
                    # top seal): the spec table's value instead, still range-checked.
                    continue
                if value is not None:
                    return _finish(name, f, source, expr, value)
        return _finish(name, f, "default", "template default", f.default)

    def _in_range(f: KeylineField, value: Any) -> bool:
        if value is None or f.type != "number":
            return True
        try:
            v = float(value)
        except (TypeError, ValueError):
            return True  # _coerce reports it
        return not (f.min is not None and v < f.min or f.max is not None and v > f.max)

    def _try(name: str, expr: str, what: str) -> Any:
        try:
            return formula.evaluate(expr, lookup)
        except formula.MissingValue:
            return None  # not available for this job: fall through to the next source
        except (formula.FormulaError, ArithmeticError, TypeError, ValueError, KeyError, AttributeError) as exc:  # (ArithmeticError: / 0, overflow)
            issues.append(Issue(code="keyline_formula", field=f"keyline.{name}", message=f"{what} {expr!r} failed: {exc}"))
            return None

    def _finish(name: str, f: KeylineField, source: Source, detail: str, value: Any) -> ResolvedField:
        if isinstance(value, str) and f.value_map:
            value = {norm(k): v for k, v in f.value_map.items()}.get(norm(value), value)
        value = _coerce(name, f, value)
        return ResolvedField(value=value, source=source, detail=detail, unit=f.unit)

    def _coerce(name: str, f: KeylineField, value: Any) -> Any:
        if value is None:
            return None
        try:
            if f.type == "number":
                value = round(float(value), 4)
                if f.min is not None and value < f.min or f.max is not None and value > f.max:
                    issues.append(Issue(code="keyline_out_of_range", field=f"keyline.{name}", message=f"{value} {f.unit} is outside {f.min}..{f.max}"))
            elif f.type == "bool":
                value = value if isinstance(value, bool) else norm(str(value)) in ("yes", "true", "1")
            elif f.type == "enum" and value not in f.options and value not in CODE_OPTIONS.get(name, ()):
                issues.append(Issue(code="keyline_bad_option", field=f"keyline.{name}", message=f"{value!r} is not one of {f.options}"))
            elif f.type == "text":
                value = str(value)
        except (TypeError, ValueError):
            issues.append(Issue(code="keyline_bad_value", field=f"keyline.{name}", message=f"{value!r} is not a {f.type}"))
        return value

    for name in fields:
        try:
            resolve(name)
        except formula.FormulaError as exc:
            issues.append(Issue(code="keyline_formula", field=f"keyline.{name}", message=str(exc)))
    return ResolvedKeyline(template=template_key, pouch_type=pouch_type_key, fields=resolved, issues=issues)


def find_client(clients: dict[str, ClientSettings], name: str | None) -> tuple[str | None, ClientSettings | None]:
    """Client settings whose client_name equals the spec table's Client Name (case/spacing-insensitive)."""
    for key, c in clients.items():
        if name and norm(c.client_name) == norm(name):
            return key, c
    return None, None


# ---------------------------------------------------------------- materials
class ResolvedMaterials(BaseModel):
    surfaces: dict[str, dict[str, float]]  # surface -> merged settings
    applied: dict[str, list[str]]  # surface -> rule keys, in the order applied


def resolve_materials(rules: dict[str, MaterialRule], ctx: dict) -> ResolvedMaterials:
    surfaces: dict[str, dict[str, float]] = {}
    applied: dict[str, list[str]] = {}
    for key, rule in sorted(rules.items(), key=lambda kr: (kr[1].priority, kr[0])):
        if rule.when and not matches(rule.when, ctx):
            continue
        settings = {k: v for k, v in rule.settings.model_dump().items() if v is not None}
        surfaces.setdefault(rule.surface, {}).update(settings)
        applied.setdefault(rule.surface, []).append(key)
    return ResolvedMaterials(surfaces=surfaces, applied=applied)
