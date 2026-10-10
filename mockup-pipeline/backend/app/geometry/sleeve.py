"""Shrink sleeve geometry: which container the sleeve goes on, and that container sized from the sleeve.

The sleeve is a tube: its lay-flat width is half its circumference, so the container's diameter is
2 x lay-flat / pi (shrinking takes up the slack). The container is as tall as the sleeve divided by the
share of its height the sleeve covers (Container.sleeve_from .. sleeve_to).
"""

import math
import re

from pydantic import BaseModel

from app.index.schemas import Container


class Sleeve(BaseModel):
    container: str  # index key
    name: str
    shape: str  # can, tin, bottle, jar
    chosen_by: str  # "job" (upload / job page), "words" (the item name matched), "default"
    diameter_mm: float
    container_height_mm: float
    sleeve_height_mm: float
    printed_width_mm: float
    layflat_mm: float
    circumference_mm: float
    overlap_mm: float  # the seam: printed width - circumference
    sleeve_from: float  # share of the container height where the sleeve starts
    sleeve_to: float
    front_center_pct: float  # across the printed width: the point that faces the front
    lid: bool
    neck_ratio: float
    body_color: str
    cap_color: str
    material: str


def pick_container(containers: dict[str, Container], chosen: str | None, text: str) -> tuple[str, Container, str]:
    """The job's own choice, else the first container (by priority) whose words match `text`, else the default."""
    if chosen and chosen in containers:
        return chosen, containers[chosen], "job"
    text = re.sub(r"[_\-+]+", " ", text)  # "Gulab_Oil_Sleeve", "KOOL CHOCOLATE_PET_180": words, not one token
    ordered = sorted(containers.items(), key=lambda kv: (kv[1].priority, kv[0]))
    for key, c in ordered:
        if any(re.search(w, text, re.IGNORECASE) for w in c.match_words):
            return key, c, "words"
    key, c = next(((k, c) for k, c in ordered if c.default), ordered[0])
    return key, c, "default"


# How high each shape's body goes (a share of the container height): a cap or lid sits above it, and a
# sleeve moved up stops there. (The 3D model's bodyTop in pouch.ts draws the same.)
BODY_TOP = {"bottle": 0.9, "jar": 0.88, "pot": 0.8}


def build(containers: dict[str, Container], chosen: str | None, text: str, printed_width: float, height: float,
          layflat: float, front_center_pct: float = 50.0, style: dict | None = None) -> Sleeve:
    """`style`: the job's own look, set by the team on the job page (never on a share link): body_color,
    cap_color, material, sleeve_from (where the sleeve sits; it keeps its real height) and height_mm (the
    container's height; at least the sleeve's)."""
    key, c, how = pick_container(containers, chosen, text)
    style = {k: v for k, v in (style or {}).items() if v is not None}
    c = c.model_copy(update={k: style[k] for k in ("body_color", "cap_color", "material") if k in style})
    layflat = layflat if 0.3 * printed_width <= layflat <= 0.55 * printed_width else (printed_width - 3.0) / 2
    circumference = 2 * layflat
    diameter = circumference / math.pi
    # as tall as the sleeve needs, and never squatter than the container's kind allows: a short sleeve is
    # then a band at its usual place, its own height
    top = BODY_TOP.get(c.shape, 1.0)
    total = max(height / (c.sleeve_to - c.sleeve_from), c.min_height_ratio * diameter)
    if style.get("height_mm"):
        total = max(float(style["height_mm"]), height / top)  # the team's height, never shorter than the sleeve
    band = min(1.0, height / total)
    start = min(max(0.0, float(style.get("sleeve_from", c.sleeve_from))), max(0.0, top - band))
    return Sleeve(container=key, name=c.name, shape=c.shape, chosen_by=how, diameter_mm=round(diameter, 2),
                  container_height_mm=round(total, 2), sleeve_height_mm=height,
                  printed_width_mm=printed_width, layflat_mm=layflat, circumference_mm=circumference,
                  overlap_mm=round(max(0.0, printed_width - circumference), 2), sleeve_from=round(start, 4),
                  sleeve_to=round(start + band if "sleeve_from" in style else min(c.sleeve_to, start + band), 4),
                  front_center_pct=front_center_pct, lid=c.lid, neck_ratio=c.neck_ratio, body_color=c.body_color, cap_color=c.cap_color,
                  material=c.material)


if __name__ == "__main__":  # the containers shipped in the seed pick these items' containers
    import yaml

    from pathlib import Path

    seed = yaml.safe_load((Path(__file__).parents[1] / "index" / "seed" / "index.yaml").read_text(encoding="utf-8"))
    cs = {k: Container.model_validate(v) for k, v in seed["container"].items()}
    for text, want in [("FGSL3970_WONDER_TURMERIC POWDER_400g", "tin"), ("FGSL3991-XTCY classic AI new 250ml", "drink_can"),
                       ("FGSL4053_GOLI SODA_JEERA_200 ml", "bottle"), ("FGSL4001_Gulab Oil Mild Mustard Oil 500ml", "bottle"),
                       ("FGSL4090-Bilona Ghee 250ml Sleeve", "ghee_pot"), ("FGSL3996-Gulab_Oil_Sleeve_Mustard", "bottle"),
                       ("FGSL4089_KOOL CHOCOLATE_PET_180 ML", "bottle"), ("FGSL4099_Vinodine 75G can pack", "tin"), ("plain", "tin")]:
        assert pick_container(cs, None, text)[0] == want, (text, pick_container(cs, None, text)[0])
    s = build(cs, None, "FGSL3970 400g", 300, 115.358, 148.5)
    assert (s.container, round(s.diameter_mm, 1), s.overlap_mm) == ("tin", 94.5, 3.0)
    assert pick_container(cs, "jar", "250ml")[2] == "job"
    moved = build(cs, None, "Gulab Oil 1 Ltr", 262, 63.5, 129.5, style={"sleeve_from": 0.3, "cap_color": "#ff0000", "material": "plastic"})
    assert (moved.sleeve_from, moved.cap_color, moved.material) == (0.3, "#ff0000", "plastic")
    assert round((moved.sleeve_to - moved.sleeve_from) * moved.container_height_mm, 1) == 63.5  # moved, its own height
    assert build(cs, None, "Gulab Oil 1 Ltr", 262, 63.5, 129.5, style={"sleeve_from": 0.9}).sleeve_to <= BODY_TOP["bottle"]  # stops under the cap
    tall = build(cs, "tin", "", 300, 115.358, 148.5, style={"height_mm": 160})
    assert tall.container_height_mm == 160 and round((tall.sleeve_to - tall.sleeve_from) * 160, 1) == 115.4
    assert build(cs, "tin", "", 300, 115.358, 148.5, style={"height_mm": 50}).container_height_mm == 115.36  # not below the sleeve
    oil = build(cs, None, "Gulab Oil 1 Ltr", 262, 63.5, 129.5)  # a 63.5 mm band on an 82 mm bottle
    assert oil.container_height_mm >= 2 * oil.diameter_mm and round((oil.sleeve_to - oil.sleeve_from) * oil.container_height_mm, 1) == 63.5
    print("ok")
