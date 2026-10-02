"""Schemas of every index kind (spec section 3). One Pydantic model per kind validates each save."""

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.index import formula
from app.index.conditions import RuleGroup
from app.index.fields import FieldDef, check_keys
from app.index.graph import WorkflowGraph, validate_graph
from app.pdf.profile import PdfProfile
from app.specs.schema import SpecTable
from app.specs.validate import ValidationRules

KEY_PATTERN = r"^[a-z0-9][a-z0-9_\-]{0,119}$"

# Built-in parametric geometry templates (Phase 4 implements each in three.js).
GeometryTemplate = Literal[
    "three_side_seal", "center_seal_pillow", "center_seal_side_gusset", "stand_up_bottom_gusset",
    "flat_bottom_box_pouch", "quad_seal", "spout_pouch", "shaped_diecut", "roll_stock",
]
PanelRole = str  # front, back, gusset, side_left, side_right, bottom, top, ...


# ---------------------------------------------------------------- 3.1 pouch types
class PouchType(BaseModel):
    """A pouch type = a geometry template + match rules + required panels + a keyline template.

    Admins add a new type without code by reusing an existing geometry template with new rules
    and keyline defaults.
    """

    name: str
    description: str = ""
    active: bool = True
    # Place in the pouch catalog (index kind pouch_catalog): form -> style -> sealing type -> this type.
    form: str | None = Field(None, description="catalog form key, e.g. pouch / roll")
    style: str | None = Field(None, description="catalog style key, e.g. stand_up / flat / box")
    sealing_type: str | None = Field(None, description="catalog sealing type key, e.g. three_side_seal")
    default_material: str | None = Field(None, description="material rule applied as this type's base finish when set")
    default_output_preset: str | None = Field(None, description="output preset used unless the item or client says otherwise")
    thumbnail: str | None = Field(None, description="small picture for the catalog (data: URL, <= 96 kB)")
    geometry_template: GeometryTemplate
    # spout_pouch / shaped_diecut are built on a base shape; "auto" = stand-up when the spec has a
    # bottom gusset, otherwise flat.
    base_geometry: Literal["stand_up_bottom_gusset", "three_side_seal", "auto"] | None = None
    priority: int = Field(100, description="Lower is evaluated first; the first priority level with a match decides")
    match_rules: list[RuleGroup] = Field(min_length=1, description="Matches when ANY group has ALL its conditions true")
    required_panels: list[PanelRole] = Field(min_length=1)
    optional_panels: list[PanelRole] = []
    # One linked PDF may serve several roles, e.g. a single "side" PDF for both side gussets.
    panel_aliases: dict[PanelRole, list[PanelRole]] = {}
    keyline_template: str
    outline_svg: str | None = Field(None, description="Die-cut outline (shaped_diecut); SVG markup, 1 unit = 1 mm")

    @model_validator(mode="after")
    def _shape_rules(self) -> "PouchType":
        if self.geometry_template in ("spout_pouch", "shaped_diecut") and self.base_geometry is None:
            raise ValueError(f"{self.geometry_template} needs base_geometry")
        if self.geometry_template == "shaped_diecut" and self.outline_svg and "<svg" not in self.outline_svg:
            raise ValueError("outline_svg must be SVG markup")
        if self.thumbnail:
            if not self.thumbnail.startswith("data:image/"):
                raise ValueError("thumbnail must be a data:image/... URL")
            if len(self.thumbnail) > 96 * 1024:
                raise ValueError("thumbnail is larger than 96 kB; use a smaller picture")
        return self


# ---------------------------------------------------------------- pouch catalog (hierarchy)
class CatalogForm(BaseModel):
    key: str = Field(pattern=r"^[a-z0-9][a-z0-9_\-]{0,60}$")
    name: str
    description: str = ""


class CatalogStyle(BaseModel):
    key: str = Field(pattern=r"^[a-z0-9][a-z0-9_\-]{0,60}$")
    name: str
    form: str
    description: str = ""


class CatalogSealing(BaseModel):
    key: str = Field(pattern=r"^[a-z0-9][a-z0-9_\-]{0,60}$")
    name: str
    style: str
    printed: list[str] = Field([], description="how the sealing type is written on sheets, e.g. ['3 Side Seal', 'Three Side Seal']")
    description: str = ""


class PouchCatalog(BaseModel):
    """The hierarchy Form -> Style -> Sealing type that groups the pouch types (singleton `default`)."""

    forms: list[CatalogForm] = []
    styles: list[CatalogStyle] = []
    sealing_types: list[CatalogSealing] = []

    @model_validator(mode="after")
    def _tree(self) -> "PouchCatalog":
        forms = {f.key for f in self.forms}
        styles = {s.key for s in self.styles}
        if len(forms) != len(self.forms) or len(styles) != len(self.styles) or len({s.key for s in self.sealing_types}) != len(self.sealing_types):
            raise ValueError("catalog keys must be unique within forms, styles and sealing types")
        for s in self.styles:
            if s.form not in forms:
                raise ValueError(f"style {s.key}: form {s.form!r} does not exist")
        for t in self.sealing_types:
            if t.style not in styles:
                raise ValueError(f"sealing type {t.key}: style {t.style!r} does not exist")
        return self

    def style_of(self, sealing_key: str) -> str | None:
        return next((t.style for t in self.sealing_types if t.key == sealing_key), None)

    def form_of(self, style_key: str) -> str | None:
        return next((s.form for s in self.styles if s.key == style_key), None)


# ---------------------------------------------------------------- size rules
class StandardSize(BaseModel):
    """A standard finished size. Validation reports sizes that match none (warning), and the nearest one."""

    name: str
    pouch_type: str | None = Field(None, description="only for this pouch type; empty = any")
    width_mm: float = Field(gt=0)
    height_mm: float = Field(gt=0)
    gusset_mm: float | None = Field(None, ge=0)
    tolerance_mm: float = Field(2.0, ge=0)
    notes: str = ""

    def distance(self, width: float | None, height: float | None) -> float | None:
        if width is None or height is None:
            return None
        return max(abs(width - self.width_mm), abs(height - self.height_mm))


# ---------------------------------------------------------------- 3.2 keyline templates
STANDARD_KEYLINE_FIELDS = [
    "bleed_left_mm", "bleed_right_mm", "bleed_top_mm", "bleed_bottom_mm",
    "top_seal_mm", "bottom_seal_mm", "side_seal_mm", "fin_seal_mm", "crimp_height_mm",
    "zipper_offset_from_top_mm", "zipper_ridge_height_mm",
    "tear_notch_type", "tear_notch_offset_mm", "butterfly_notch", "corner_radius_mm",
    "gusset_depth_mm", "gusset_shape", "side_gusset_depth_mm",
    "body_bulge_percent", "fill_level_percent",
    "spout_position", "spout_diameter_mm", "spout_cap_diameter_mm", "spout_cap_height_mm",
    "hang_hole_type", "hang_hole_size_mm", "hang_hole_offset_mm",
    "window_enabled", "window_x_mm", "window_y_mm", "window_width_mm", "window_height_mm", "window_corner_radius_mm",
    "texture_dpi",
]


class KeylineField(BaseModel):
    """One keyline value. Resolution order (first that yields a value wins):
    item override > client override > `formula` or pinned `default` (the pouch type's rule) >
    `from_measured` (PDF dimension lines) > `from_spec` (spec table) > plain `default`.
    """

    type: Literal["number", "bool", "enum", "text"] = "number"
    unit: str = "mm"
    default: Any = None
    pin: bool = Field(False, description="Default is the pouch type's value and beats measured/spec values")
    min: float | None = None
    max: float | None = None
    options: list[str] = []
    formula: str | None = Field(None, description="Pouch-type rule, e.g. 'spec.gusset_full_width_mm / 2'")
    from_measured: str | None = Field(None, description="Expression over measured.*, e.g. 'measured.width_segments_mm[0]'")
    from_spec: str | None = Field(None, description="Expression over spec.*, e.g. 'spec.sealing_width_mm'")
    value_map: dict[str, Any] = Field({}, description="Maps spec text to a value, e.g. {'v notch': 'v_notch'}")
    enabled_when: list[RuleGroup] = Field([], description="If set and false, the feature is off (value None)")
    description: str = ""

    @field_validator("formula", "from_measured", "from_spec")
    @classmethod
    def _valid_expression(cls, v: str | None) -> str | None:
        if v:
            formula.parse(v)  # raises FormulaError -> validation error shown to the admin
        return v

    @model_validator(mode="after")
    def _default_fits(self) -> "KeylineField":
        if self.type == "enum" and self.default is not None and self.default not in self.options:
            raise ValueError(f"default {self.default!r} is not one of {self.options}")
        if self.type == "number" and isinstance(self.default, (int, float)):
            if self.min is not None and self.default < self.min or self.max is not None and self.default > self.max:
                raise ValueError(f"default {self.default} is outside {self.min}..{self.max}")
        return self


class KeylineTemplate(BaseModel):
    name: str
    description: str = ""
    fields: dict[str, KeylineField]

    @model_validator(mode="after")
    def _complete_and_acyclic(self) -> "KeylineTemplate":
        missing = [f for f in STANDARD_KEYLINE_FIELDS if f not in self.fields]
        if missing:
            raise ValueError(f"missing standard keyline fields: {', '.join(missing)}")
        for name, f in self.fields.items():
            if not re.fullmatch(r"[a-z][a-z0-9_]*", name):
                raise ValueError(f"invalid field name {name!r}")
            for ns, ref in formula.references(f.formula) if f.formula else ():
                if ns == "" and ref not in self.fields:
                    raise ValueError(f"{name}.formula references unknown field {ref!r}")
        _check_cycles(self.fields)
        return self


def _check_cycles(fields: dict[str, KeylineField]) -> None:
    graph = {n: {r for ns, r in formula.references(f.formula) if ns == ""} if f.formula else set() for n, f in fields.items()}
    state: dict[str, int] = {}

    def visit(n: str, path: list[str]) -> None:
        if state.get(n) == 1:
            raise ValueError(f"formula cycle: {' -> '.join(path + [n])}")
        if state.get(n) == 2:
            return
        state[n] = 1
        for m in graph.get(n, ()):
            visit(m, path + [n])
        state[n] = 2

    for n in graph:
        visit(n, [])


# ---------------------------------------------------------------- 3.3 output presets
View = Literal["front", "back", "three_quarter_left", "three_quarter_right", "top_down", "turntable"]


class Background(BaseModel):
    type: Literal["studio_white", "transparent", "gradient", "custom_image"] = "studio_white"
    colors: list[str] = []  # gradient stops as #rrggbb
    image: str | None = None  # storage key of an uploaded image for custom_image

    @model_validator(mode="after")
    def _needs(self) -> "Background":
        if self.type == "gradient" and len(self.colors) < 2:
            raise ValueError("gradient needs at least two colors")
        if self.type == "custom_image" and not self.image:
            raise ValueError("custom_image needs an image")
        for c in self.colors:
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", c):
                raise ValueError(f"color {c!r} must be #rrggbb")
        return self


class OutputPreset(BaseModel):
    name: str
    is_default: bool = False
    views: list[View] = Field(min_length=1)
    width_px: int = Field(2000, ge=256, le=8192)
    height_px: int = Field(2000, ge=256, le=8192)
    background: Background = Background()
    shadow: bool = True
    shadow_opacity: float = Field(0.35, ge=0, le=1)
    # "exact": no light or shade, every pixel is the artwork's own colour (print colours); the other
    # presets are photographic studio set-ups.
    lighting: Literal["exact", "studio_soft", "studio_hard", "daylight", "product_dramatic"] = "exact"
    formats: list[Literal["png", "glb", "mp4"]] = Field(["png", "glb"], min_length=1)
    turntable_seconds: float = Field(6, gt=0, le=60)
    turntable_fps: int = Field(30, ge=10, le=60)
    naming_pattern: str = "{item_no}_{client}_{view}.png"

    @field_validator("naming_pattern")
    @classmethod
    def _placeholders(cls, v: str) -> str:
        allowed = {"item_no", "client", "view", "pouch_type", "item_name", "date", "format"}
        unknown = set(re.findall(r"{(\w+)}", v)) - allowed
        if unknown:
            raise ValueError(f"unknown placeholders {sorted(unknown)}; allowed: {sorted(allowed)}")
        return v


# ---------------------------------------------------------------- 3.5 materials
class MaterialSettings(BaseModel):
    roughness: float | None = Field(None, ge=0, le=1)
    metalness: float | None = Field(None, ge=0, le=1)
    clearcoat: float | None = Field(None, ge=0, le=1)
    clearcoat_roughness: float | None = Field(None, ge=0, le=1)
    sheen: float | None = Field(None, ge=0, le=1)
    specular_intensity: float | None = Field(None, ge=0, le=1)
    transmission: float | None = Field(None, ge=0, le=1)
    opacity: float | None = Field(None, ge=0, le=1)
    ior: float | None = Field(None, ge=1, le=2.5)
    normal_scale: float | None = Field(None, ge=0, le=2)


class MaterialRule(BaseModel):
    """Finish and film layers -> PBR settings for one surface of the pouch.

    Surfaces: base (whole film), unprinted (no ink), white_less (no white underlay: where MET PET
    shows through as metal), window (transparent window region), spot (spot varnish mask).
    Rules apply in priority order; later rules override the settings they set.
    """

    name: str
    priority: int = 100
    when: list[RuleGroup] = Field([], description="Empty = always applies")
    surface: Literal["base", "unprinted", "white_less", "window", "spot"] = "base"
    settings: MaterialSettings


# ---------------------------------------------------------------- overrides
class ClientSettings(BaseModel):
    """Per-client settings. `client_name` is matched against the spec table's Client Name."""

    client_name: str
    default_output_preset: str | None = None
    include_eyemarks: bool = False
    # pouch type key (or "*" for all types) -> keyline field -> value
    keyline_overrides: dict[str, dict[str, Any]] = {}
    notes: str = ""


class ItemOverride(BaseModel):
    """Per-item overrides (key = item code, e.g. fgpo7215)."""

    pouch_type: str | None = Field(None, description="Force this pouch type instead of the match rules")
    keyline_overrides: dict[str, Any] = {}
    output_preset: str | None = None
    # Job-page adjustments saved as this item's default (app.workflow.adjust.Adjustments): panel
    # artwork placement, material, scene. Every new job of the item starts from them.
    adjustments: dict[str, Any] = {}
    notes: str = ""


# ---------------------------------------------------------------- registry
KINDS: dict[str, type[BaseModel]] = {
    "field": FieldDef,
    "pouch_catalog": PouchCatalog,
    "pouch_type": PouchType,
    "keyline_template": KeylineTemplate,
    "standard_size": StandardSize,
    "pdf_profile": PdfProfile,
    "material": MaterialRule,
    "output_preset": OutputPreset,
    "client": ClientSettings,
    "item_override": ItemOverride,
    "validation_rules": ValidationRules,
    "workflow": WorkflowGraph,
}
SINGLETONS = {"pdf_profile", "validation_rules", "pouch_catalog"}  # only key "default"
KIND_LABELS = {
    "field": "Field dictionary", "pouch_catalog": "Pouch catalog", "pouch_type": "Pouch types",
    "keyline_template": "Keyline templates", "standard_size": "Size rules", "pdf_profile": "PDF profile & panels",
    "material": "Materials", "output_preset": "Output presets", "client": "Clients", "item_override": "Item overrides",
    "validation_rules": "Validation rules", "workflow": "Workflows",
}
# Kinds with their own editor page rather than the generic entry page.
KIND_PAGES = {"workflow": "/workflows"}


def field_keys(fields: dict[str, BaseModel]) -> set[str]:
    """Field names a FETCH node or a condition may refer to: the dictionary's, else the schema's."""
    keys = {k for k, f in fields.items() if not getattr(f, "stop", False)}
    return keys or set(SpecTable.model_fields)


def validate_entry(kind: str, key: str, data: dict) -> BaseModel:
    if kind not in KINDS:
        raise ValueError(f"unknown index kind {kind!r}")
    if not re.fullmatch(KEY_PATTERN, key):
        raise ValueError("key must be lowercase letters, digits, '_' or '-' (max 120)")
    if kind in SINGLETONS and key != "default":
        raise ValueError(f"{kind} has a single entry with key 'default'")
    return KINDS[kind].model_validate(data)


def cross_check(entries: dict[str, dict[str, BaseModel]]) -> list[str]:
    """References between entries (all kinds loaded). Returns problems; empty = consistent."""
    problems: list[str] = []
    keylines = entries.get("keyline_template", {})
    presets = entries.get("output_preset", {})
    types = entries.get("pouch_type", {})
    materials = entries.get("material", {})
    catalog: PouchCatalog | None = entries.get("pouch_catalog", {}).get("default")  # type: ignore[assignment]
    for key, pt in types.items():
        if pt.keyline_template not in keylines:
            problems.append(f"pouch_type {key}: keyline_template {pt.keyline_template!r} does not exist")
        if pt.default_material and pt.default_material not in materials:
            problems.append(f"pouch_type {key}: default material {pt.default_material!r} does not exist")
        if pt.default_output_preset and pt.default_output_preset not in presets:
            problems.append(f"pouch_type {key}: default output preset {pt.default_output_preset!r} does not exist")
        if catalog is not None:
            if pt.form and pt.form not in {f.key for f in catalog.forms}:
                problems.append(f"pouch_type {key}: form {pt.form!r} is not in the pouch catalog")
            if pt.style and pt.style not in {s.key for s in catalog.styles}:
                problems.append(f"pouch_type {key}: style {pt.style!r} is not in the pouch catalog")
            if pt.sealing_type and pt.sealing_type not in {t.key for t in catalog.sealing_types}:
                problems.append(f"pouch_type {key}: sealing type {pt.sealing_type!r} is not in the pouch catalog")
            if pt.sealing_type and pt.style and catalog.style_of(pt.sealing_type) not in (None, pt.style):
                problems.append(f"pouch_type {key}: sealing type {pt.sealing_type!r} belongs to style {catalog.style_of(pt.sealing_type)!r}, not {pt.style!r}")
            if pt.style and pt.form and catalog.form_of(pt.style) not in (None, pt.form):
                problems.append(f"pouch_type {key}: style {pt.style!r} belongs to form {catalog.form_of(pt.style)!r}, not {pt.form!r}")
    for key, size in entries.get("standard_size", {}).items():
        if size.pouch_type and size.pouch_type not in types:
            problems.append(f"standard_size {key}: pouch type {size.pouch_type!r} does not exist")
    problems += check_keys(entries.get("field", {}))  # type: ignore[arg-type]
    fields = field_keys(entries.get("field", {}))
    workflows = entries.get("workflow", {})
    for key, wf in workflows.items():
        problems += [f"workflow {key}: {p}" for p in validate_graph(wf, set(types), fields, set(workflows), self_key=key)]
    for key, c in entries.get("client", {}).items():
        if c.default_output_preset and c.default_output_preset not in presets:
            problems.append(f"client {key}: output preset {c.default_output_preset!r} does not exist")
        for type_key, fields in c.keyline_overrides.items():
            if type_key != "*" and type_key not in types:
                problems.append(f"client {key}: pouch type {type_key!r} does not exist")
            problems += _unknown_fields(f"client {key}", fields, keylines)
    for key, item in entries.get("item_override", {}).items():
        if item.pouch_type and item.pouch_type not in types:
            problems.append(f"item_override {key}: pouch type {item.pouch_type!r} does not exist")
        if item.output_preset and item.output_preset not in presets:
            problems.append(f"item_override {key}: output preset {item.output_preset!r} does not exist")
        problems += _unknown_fields(f"item_override {key}", item.keyline_overrides, keylines)
    defaults = [k for k, p in presets.items() if p.is_default]
    if presets and len(defaults) != 1:
        problems.append(f"exactly one output preset must be the default (found {defaults or 'none'})")
    return problems


def _unknown_fields(where: str, fields: dict[str, Any], keylines: dict[str, BaseModel]) -> list[str]:
    known = {f for kt in keylines.values() for f in kt.fields}
    return [f"{where}: unknown keyline field {f!r}" for f in fields if f not in known]


def json_schema(kind: str) -> dict:
    return KINDS[kind].model_json_schema()
