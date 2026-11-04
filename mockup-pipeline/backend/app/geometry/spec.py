"""Geometry spec: everything the three.js builder needs, in millimetres (1 unit = 1 mm).

This JSON is the contract between the workflow and frontend/src/three/pouch.ts. The same file
drives the interactive viewer and the headless renders, so they always match.
"""

from typing import Any, Literal

from pydantic import BaseModel

from app.index.resolve import ResolvedMaterials
from app.index.schemas import OutputPreset, PouchType


class Seals(BaseModel):
    top: float
    bottom: float
    side: float
    fin: float
    crimp: float


class Zipper(BaseModel):
    enabled: bool
    y_from_top_mm: float
    ridge_height_mm: float


class Notch(BaseModel):
    type: str  # none, v_notch, straight, laser_score
    y_from_top_mm: float
    depth_mm: float = 4.0


HANG_HOLE_TYPES = ("round", "euro", "butterfly")


class HangHole(BaseModel):
    """A punched hang hole, centred across the face.

    round: a circle, `size_mm` across, centre `offset_mm` below the top edge.
    euro: a slot with round ends, `size_mm` tall and `width_mm` wide (0 = 3.2 x size), centred at `offset_mm`.
    butterfly: the sombrero ("butterfly") hole: a slot like euro with a dome rising from its middle;
    `height_mm` is the whole hole, dome top to slot bottom (0 = 1.6 x size). The spec table's
    "Butterfly Notch: Yes" means this hole, not a second tear notch (FGPO7700 / 7570 / 0928).
    """

    type: str  # none, round, euro, butterfly
    size_mm: float
    offset_mm: float
    width_mm: float = 0.0
    height_mm: float = 0.0


def hang_hole_dims(h: HangHole, panel_width_mm: float) -> tuple[float, float, float, float]:
    """(width, slot height, dome rise above the slot, dome radius) of a hang hole, in mm."""
    s = max(h.size_mm, 0.5)
    if h.type == "round":
        return s, s, 0.0, s / 2
    width = h.width_mm if h.width_mm > 0 else s * 3.2
    width = min(max(width, s), panel_width_mm * 0.9)
    if h.type != "butterfly":
        return width, s, 0.0, 0.0
    total = h.height_mm if h.height_mm > s else s * 1.6
    rise = total - s
    radius = min(max(rise, width * 0.2), total, width / 2)
    return width, s, rise, radius


def hang_hole_extent(h: HangHole, panel_width_mm: float) -> tuple[float, float]:
    """Top and bottom of the hole, mm below the face's top edge."""
    _, s, rise, _ = hang_hole_dims(h, panel_width_mm)
    return h.offset_mm - s / 2 - rise, h.offset_mm + s / 2


def hang_hole_path(h: HangHole, panel_width_mm: float) -> str:
    """The hole's outline as an SVG path (mm, y down), the same shape the 3D cut mask uses
    (frontend/src/three/hanghole.ts). Empty for no hole."""
    if h.type not in HANG_HOLE_TYPES:
        return ""
    cx, cy = panel_width_mm / 2, h.offset_mm
    width, s, rise, radius = hang_hole_dims(h, panel_width_mm)
    f = lambda v: f"{v:.3f}".rstrip("0").rstrip(".")  # noqa: E731
    if h.type == "round":
        r = s / 2
        return f"M{f(cx - r)} {f(cy)}A{f(r)} {f(r)} 0 1 1 {f(cx + r)} {f(cy)}A{f(r)} {f(r)} 0 1 1 {f(cx - r)} {f(cy)}Z"
    rs = s / 2
    x0, x1, top, bottom = cx - width / 2, cx + width / 2, cy - s / 2, cy + s / 2
    head = f"M{f(x0 + rs)} {f(top)}"
    if rise > 0.01:
        dome_cy = top - rise + radius
        half = (max(radius * radius - (dome_cy - top) ** 2, 0.0)) ** 0.5
        # centre below the slot's top line: the dome above it is the minor arc
        large = 0 if dome_cy >= top else 1
        head += f"L{f(cx - half)} {f(top)}A{f(radius)} {f(radius)} 0 {large} 1 {f(cx + half)} {f(top)}"
    return (head + f"L{f(x1 - rs)} {f(top)}A{f(rs)} {f(rs)} 0 0 1 {f(x1 - rs)} {f(bottom)}"
            f"L{f(x0 + rs)} {f(bottom)}A{f(rs)} {f(rs)} 0 0 1 {f(x0 + rs)} {f(top)}Z")


DECIDED = ("item_override", "client_override", "pouch_type")  # keyline sources that are someone's decision


def resolve_hang_hole(keyline: dict[str, Any], sources: dict[str, str] | None, measured: dict[str, Any] | None,
                      panel_width_mm: float) -> HangHole:
    """The hang hole the pouch gets.

    1. An item / client / job-page value or a pouch-type rule decides.
    2. Else the hole drawn on the dieline (app.pdf.vector.hang_hole), with its measured size and place.
    3. Else "Butterfly Notch: Yes" on the spec table: a butterfly (sombrero) hole of the usual size.
    Works whatever the index version says, so an index seeded before this rule existed gets it too.
    """
    sources, measured = sources or {}, measured or {}

    def decided(key: str) -> bool:
        return sources.get(key) in DECIDED

    kind = str(keyline.get("hang_hole_type") or "none")
    m_kind = measured.get("hang_hole_type")
    use_measured = not decided("hang_hole_type") and m_kind in HANG_HOLE_TYPES and (kind == "none" or kind == m_kind)
    if use_measured:
        kind = m_kind
    elif kind == "none" and not decided("hang_hole_type") and keyline.get("butterfly_notch") is True:
        kind = "butterfly"
    if kind not in HANG_HOLE_TYPES:
        return HangHole(type="none", size_mm=_num(keyline, "hang_hole_size_mm", 8), offset_mm=_num(keyline, "hang_hole_offset_mm", 10))

    # The drawing's sizes belong to the drawn hole: they apply whenever the hole is that type, also
    # when someone picked the type explicitly (picking the type that is drawn must not resize it).
    drawn = m_kind == kind

    def value(key: str, m_key: str, default: float, sombrero: float | None = None) -> float:
        if decided(key) and _num(keyline, key) > 0:
            return _num(keyline, key)
        if (drawn or (m_kind in HANG_HOLE_TYPES and key == "hang_hole_offset_mm")) and isinstance(measured.get(m_key), (int, float)) and measured[m_key] > 0:
            return float(measured[m_key])
        src = sources.get(key)
        if src == "default" and _num(keyline, key, default) != default:
            return _num(keyline, key)  # a default an admin saved for this pouch type (the shipped one is `default`)
        if sombrero is not None and kind == "butterfly" and src in (None, "default", "disabled", "measured"):
            return sombrero  # the usual sombrero; the template's 8 mm default size is a round hole's
        if src == "measured" and key != "hang_hole_offset_mm":
            return default  # measured on a hole of another type: not this hole's size (its place still is)
        return _num(keyline, key, default) or default

    size = value("hang_hole_size_mm", "hang_hole_size_mm", 8.0, 6.0)
    width = value("hang_hole_width_mm", "hang_hole_width_mm", 0.0, min(30.0, panel_width_mm * 0.3))
    return HangHole(type=kind, size_mm=round(size, 3), offset_mm=round(value("hang_hole_offset_mm", "hang_hole_y_mm", 10.0), 3),
                    width_mm=round(width, 3), height_mm=round(value("hang_hole_height_mm", "hang_hole_height_mm", 0.0), 3))


CENTRE_SEAL = ("center_seal_pillow", "center_seal_side_gusset")


class Window(BaseModel):
    enabled: bool
    x_mm: float = 0
    y_mm: float = 0
    width_mm: float = 0
    height_mm: float = 0
    radius_mm: float = 0
    shapes: list[dict] = []  # operator-marked windows (adjust.WindowShape), drawn by the viewer


class Spout(BaseModel):
    position: str
    diameter_mm: float
    cap_diameter_mm: float
    cap_height_mm: float


class Valve(BaseModel):
    panel: str  # front / back
    x_mm: float  # centre from the panel's left edge (as printed)
    y_from_top_mm: float
    diameter_mm: float


class Roll(BaseModel):
    repeat_mm: float
    web_width_mm: float
    outer_diameter_mm: float
    core_diameter_mm: float


class PanelSize(BaseModel):
    width_mm: float
    height_mm: float


class Dimension(BaseModel):
    label: str
    value_mm: float
    kind: Literal["width", "height", "gusset", "side_gusset", "seal", "depth", "other"]


class GeometrySpec(BaseModel):
    version: int = 1
    template: str
    shape: str  # the base shape actually built (spout/shaped use a base)
    width_mm: float
    height_mm: float
    gusset_full_mm: float
    gusset_depth_mm: float
    side_gusset_full_mm: float
    side_gusset_depth_mm: float
    seals: Seals
    zipper: Zipper
    tear_notch: Notch
    # True when the hang hole is the spec's butterfly hole. Never a second notch: kept so viewers of
    # older geometry files (butterfly_notch true, no hang hole) can still show the hole.
    butterfly_notch: bool
    corner_radius_mm: float
    hang_hole: HangHole
    window: Window
    spout: Spout | None
    valve: Valve | None = None
    roll: Roll | None
    sleeve: Any = None  # app.geometry.sleeve.Sleeve: a shrink sleeve and the container it is shrunk onto
    body_bulge_percent: float
    fill_level_percent: float
    outline_svg: str | None
    panels: dict[str, PanelSize]
    materials: ResolvedMaterials
    preset: OutputPreset
    preset_key: str
    dimensions: list[Dimension]


def _num(kl: dict[str, Any], key: str, default: float = 0.0) -> float:
    v = kl.get(key)
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def build(pouch: PouchType, spec: dict[str, Any], keyline: dict[str, Any], panels: dict[str, tuple[float, float]],
          materials: ResolvedMaterials, preset: OutputPreset, preset_key: str,
          sources: dict[str, str] | None = None, measured: dict[str, Any] | None = None) -> GeometrySpec:
    """`sources`: each keyline value's source (app.index.resolve); `measured`: the drawing's
    measurements (measured.*). Both only refine the hang hole; without them the keyline decides."""
    w, h = float(spec["pouch_closed_width_mm"]), float(spec["pouch_height_mm"])
    shape = pouch.geometry_template
    if shape in ("spout_pouch", "shaped_diecut"):
        base = pouch.base_geometry or "stand_up_bottom_gusset"
        if base == "auto":
            base = "stand_up_bottom_gusset" if str(spec.get("gusset_type") or "").lower() == "bottom" else "three_side_seal"
        shape = base
    gusset_full = float(spec.get("gusset_full_width_mm") or 0)
    gusset_depth = _num(keyline, "gusset_depth_mm") or (gusset_full / 2 if shape == "stand_up_bottom_gusset" else 0)
    side_depth = _num(keyline, "side_gusset_depth_mm")
    side_full = panels.get("side_left", (2 * side_depth, h))[0] if shape in ("center_seal_side_gusset", "quad_seal", "flat_bottom_box_pouch") else 0.0
    if side_full and not side_depth:
        side_depth = side_full / 2

    zipper_on = keyline.get("zipper_offset_from_top_mm") is not None
    notch_type = str(keyline.get("tear_notch_type") or "none")
    if notch_type == "v_notch" and (shape in CENTRE_SEAL or pouch.geometry_template == "roll_stock"):
        notch_type = "none"  # a centre-seal (pillow) pack is never V-notched
    roll = None
    fin = _num(keyline, "fin_seal_mm")
    if pouch.geometry_template == "roll_stock":
        roll_size = panels.get("roll", (_num(keyline, "roll_repeat_mm", w), _num(keyline, "roll_web_width_mm", h)))
        roll = Roll(repeat_mm=roll_size[0], web_width_mm=roll_size[1],
                    outer_diameter_mm=_num(keyline, "roll_outer_diameter_mm", 300), core_diameter_mm=_num(keyline, "roll_core_diameter_mm", 76))
        # The sachet formed from the web: a pillow whose fin seal takes up open width - 2 x closed width.
        open_w = float(spec.get("pouch_open_width_mm") or 0)
        if open_w > 2 * w:
            fin = (open_w - 2 * w) / 2
    spout = None
    if pouch.geometry_template == "spout_pouch":
        spout = Spout(position=str(keyline.get("spout_position") or "top_center"), diameter_mm=_num(keyline, "spout_diameter_mm", 22),
                      cap_diameter_mm=_num(keyline, "spout_cap_diameter_mm", 32), cap_height_mm=_num(keyline, "spout_cap_height_mm", 20))
    window_on = bool(keyline.get("window_enabled")) and keyline.get("window_x_mm") is not None
    valve = None
    if keyline.get("valve_panel") in ("front", "back"):
        valve = Valve(panel=str(keyline["valve_panel"]), x_mm=_num(keyline, "valve_x_mm") or w / 2,
                      y_from_top_mm=_num(keyline, "valve_y_from_top_mm", 45), diameter_mm=_num(keyline, "valve_diameter_mm", 22))

    hang = resolve_hang_hole(keyline, sources, measured, w)
    if pouch.geometry_template in ("roll_stock", "shrink_sleeve") or (spout is not None and spout.position == "top_center"):
        hang = HangHole(type="none", size_mm=hang.size_mm, offset_mm=hang.offset_mm)  # no hole where the spout or the web is

    dims = [Dimension(label="Width", value_mm=w, kind="width"), Dimension(label="Height", value_mm=h, kind="height")]
    if shape == "stand_up_bottom_gusset" and gusset_full:
        dims.append(Dimension(label="Bottom gusset (full)", value_mm=gusset_full, kind="gusset"))
    if side_full:
        dims.append(Dimension(label="Side gusset (full)", value_mm=side_full, kind="side_gusset"))
    if _num(keyline, "side_seal_mm"):
        dims.append(Dimension(label="Side seal", value_mm=_num(keyline, "side_seal_mm"), kind="seal"))
    if _num(keyline, "top_seal_mm"):
        dims.append(Dimension(label="Top seal", value_mm=_num(keyline, "top_seal_mm"), kind="seal"))

    return GeometrySpec(
        template=pouch.geometry_template,
        shape=shape,
        width_mm=w,
        height_mm=h,
        gusset_full_mm=gusset_full if shape == "stand_up_bottom_gusset" else 0,
        gusset_depth_mm=gusset_depth if shape == "stand_up_bottom_gusset" else 0,
        side_gusset_full_mm=side_full,
        side_gusset_depth_mm=side_depth if side_full else 0,
        seals=Seals(top=_num(keyline, "top_seal_mm"), bottom=_num(keyline, "bottom_seal_mm"), side=_num(keyline, "side_seal_mm"),
                    fin=fin, crimp=_num(keyline, "crimp_height_mm")),
        zipper=Zipper(enabled=zipper_on, y_from_top_mm=_num(keyline, "zipper_offset_from_top_mm"), ridge_height_mm=_num(keyline, "zipper_ridge_height_mm", 3)),
        tear_notch=Notch(type=notch_type, y_from_top_mm=_num(keyline, "tear_notch_offset_mm", 20), depth_mm=_num(keyline, "tear_notch_depth_mm", 4) or 4),
        butterfly_notch=hang.type == "butterfly",
        corner_radius_mm=_num(keyline, "corner_radius_mm"),
        hang_hole=hang,
        window=Window(enabled=window_on, x_mm=_num(keyline, "window_x_mm"), y_mm=_num(keyline, "window_y_mm"),
                      width_mm=_num(keyline, "window_width_mm"), height_mm=_num(keyline, "window_height_mm"),
                      radius_mm=_num(keyline, "window_corner_radius_mm")),
        spout=spout,
        valve=valve,
        roll=roll,
        body_bulge_percent=_num(keyline, "body_bulge_percent", 12),
        fill_level_percent=_num(keyline, "fill_level_percent", 85),
        outline_svg=pouch.outline_svg,
        panels={r: PanelSize(width_mm=pw, height_mm=ph) for r, (pw, ph) in panels.items()} | (
            {"front": PanelSize(width_mm=w, height_mm=h), "back": PanelSize(width_mm=w, height_mm=h)} if roll else {}),
        materials=materials,
        preset=preset,
        preset_key=preset_key,
        dimensions=dims,
    )
