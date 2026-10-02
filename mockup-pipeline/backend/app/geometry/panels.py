"""Finished size of each printed panel per geometry template, in mm (width, height as printed)."""

from app.errors import NeedsReview


def panel_sizes(template: str, base: str | None, spec: dict, keyline: dict) -> dict[str, tuple[float, float]]:
    w = spec.get("pouch_closed_width_mm")
    h = spec.get("pouch_height_mm")
    g = spec.get("gusset_full_width_mm")
    if not w or not h:
        raise NeedsReview("missing_size", "Pouch width and height are needed to size the panels", {"form": "specs"})
    shape = base if template in ("spout_pouch", "shaped_diecut") and base and base != "auto" else template
    if template in ("spout_pouch", "shaped_diecut") and base == "auto":
        shape = "stand_up_bottom_gusset" if str(spec.get("gusset_type") or "").lower() == "bottom" else "three_side_seal"

    sizes: dict[str, tuple[float, float]] = {"front": (w, h), "back": (w, h)}
    if template == "roll_stock":
        # The printed repeat (along the roll) x the web: what the roll and the unwound web carry.
        # Front and back of the formed sachet are cut from one pouch blank of the repeat (texture step).
        rep, web = keyline.get("roll_repeat_mm"), keyline.get("roll_web_width_mm")
        sizes["roll"] = (float(rep) if rep else h, float(web) if web else spec.get("pouch_open_width_mm") or w)
        return sizes
    if shape == "stand_up_bottom_gusset":
        sizes["gusset"] = (w, g or 2 * float(keyline.get("gusset_depth_mm") or 0) or 0.3 * w)
    elif shape in ("center_seal_side_gusset", "quad_seal"):
        sg = g or 2 * float(keyline.get("side_gusset_depth_mm") or 0) or 0.3 * w
        sizes["side_left"] = sizes["side_right"] = (sg, h)
    elif shape == "flat_bottom_box_pouch":
        sg = g or 2 * float(keyline.get("side_gusset_depth_mm") or 0) or 0.3 * w
        sizes["side_left"] = sizes["side_right"] = (sg, h)
        sizes["bottom"] = (w, sg)
    sizes["top"] = (w, g or 0.3 * w)
    return sizes
