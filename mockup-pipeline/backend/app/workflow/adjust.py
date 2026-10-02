"""Job-page adjustments (the Pacdora-style controls): what an operator changes on a finished mockup.

Stored on the job (`job.inputs["adjust"]`) and, when an admin saves them as the item's default, in
the index (`item_override.adjustments`). Every step reads the merged view through `adjustments()`:
the job's own values win over the item default. Nothing here guesses: an unset field means "as
the automatic pipeline decided".

  panels    per panel role: where the artwork comes from and how it sits on the panel, what is
            drawn on top of it (logos, text) and its colour correction
  specs     spec table values the operator sets (width, height, gusset, ...): spec_corrections
  keyline   keyline values (seals, zipper, notch, corner radius, fill level, bulge): keyline_overrides
  material  finish / metallic film / plain-panel colour
  scene     lighting (exact print colours or a studio look), background, shadow, views
"""

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.index.schemas import Background

COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")


class Overlay(BaseModel):
    """A logo (uploaded image) or a line of text placed on a panel, in mm from the panel's top-left
    corner (the finished panel, as the keyline preview shows it). Baked into the texture."""

    id: str = Field("", max_length=40, description="the job page's handle for this overlay")
    kind: Literal["image", "text"] = "image"
    file_id: int | None = None  # image
    text: str = Field("", max_length=400)  # text (newlines make lines)
    x_mm: float = Field(0, ge=-5000, le=5000, description="centre, from the panel's left edge")
    y_mm: float = Field(0, ge=-5000, le=5000, description="centre, from the panel's top edge")
    width_mm: float = Field(30, gt=0, le=5000, description="image width; its height follows unless height_mm is set")
    height_mm: float | None = Field(None, gt=0, le=5000)
    size_mm: float = Field(8, gt=0, le=500, description="text size (the height of a capital letter, about)")
    rotation: float = Field(0, ge=-360, le=360, description="degrees counter-clockwise")
    opacity: float = Field(1, ge=0, le=1)
    color: str = "#000000"  # text colour
    background: str | None = None  # a box behind the text
    font: Literal["sans", "serif", "mono"] = "sans"
    bold: bool = False
    align: Literal["left", "center", "right"] = "center"

    @field_validator("color", "background")
    @classmethod
    def _hex(cls, v: str | None) -> str | None:
        if v is not None and not COLOUR.match(v):
            raise ValueError("colour must be #rrggbb")
        return v


class PanelAdjust(BaseModel):
    # auto: as found; sheet: panel N of the job's own sheet; file: an uploaded image or PDF; front:
    # the front's artwork; plain: unprinted film in `color`
    source: Literal["auto", "sheet", "file", "front", "plain"] = "auto"
    sheet_panel: int | None = Field(None, ge=0, description="index into the sheet layout's panels")
    file_id: int | None = None
    # How an uploaded image (or a PDF page without a matching dieline) fills the panel: cover crops
    # the overflow, contain shows it all over `background`, stretch distorts it to the panel.
    fit: Literal["cover", "contain", "stretch"] = "cover"
    background: str | None = None
    color: str | None = None
    rotation: int = Field(0, description="extra turn in degrees; 90 / 270 only when the panel is square")
    flip_x: bool = False
    flip_y: bool = False
    offset_x_mm: float = Field(0, ge=-2000, le=2000, description="move the artwork right (+) / left (-)")
    offset_y_mm: float = Field(0, ge=-2000, le=2000, description="move the artwork up (+) / down (-)")
    scale: float = Field(1.0, gt=0.1, le=10)
    # Colour correction, -100..100 (0 = as printed), and what is drawn on top; both are baked into
    # the finished texture by the texture step.
    brightness: float = Field(0, ge=-100, le=100)
    contrast: float = Field(0, ge=-100, le=100)
    saturation: float = Field(0, ge=-100, le=100)
    overlays: list[Overlay] = Field([], max_length=40)

    @field_validator("rotation")
    @classmethod
    def _quarter_turns(cls, v: int) -> int:
        if v % 90:
            raise ValueError("rotation must be a multiple of 90")
        return v % 360

    @field_validator("color", "background")
    @classmethod
    def _hex(cls, v: str | None) -> str | None:
        if v is not None and not COLOUR.match(v):
            raise ValueError("colour must be #rrggbb")
        return v

    def is_identity(self) -> bool:
        return not (self.rotation or self.flip_x or self.flip_y or self.offset_x_mm or self.offset_y_mm or self.scale != 1.0)

    def bakes(self) -> bool:
        """Whether the texture step has to redraw this panel's image (colour correction, overlays)."""
        return bool(self.overlays or self.brightness or self.contrast or self.saturation)

    def transform(self) -> dict | None:
        """What the viewer applies as a texture matrix (None when nothing is changed)."""
        if self.is_identity():
            return None
        return {"rotation": self.rotation, "flip_x": self.flip_x, "flip_y": self.flip_y,
                "offset_x_mm": self.offset_x_mm, "offset_y_mm": self.offset_y_mm, "scale": self.scale}


class MaterialAdjust(BaseModel):
    finish: Literal["auto", "matt", "gloss"] = "auto"
    metallic: Literal["auto", "on", "off"] = "auto"  # metallised film showing where there is no white
    plain_color: str | None = None  # colour of unprinted (plain) panels

    @field_validator("plain_color")
    @classmethod
    def _hex(cls, v: str | None) -> str | None:
        if v is not None and not COLOUR.match(v):
            raise ValueError("colour must be #rrggbb")
        return v


class SceneAdjust(BaseModel):
    lighting: Literal["exact", "studio_soft", "studio_hard", "daylight", "product_dramatic"] | None = None
    background: Background | None = None
    shadow: bool | None = None
    views: list[Literal["front", "back", "three_quarter_left", "three_quarter_right", "top_down", "turntable"]] | None = None


class Adjustments(BaseModel):
    panels: dict[str, PanelAdjust] = {}
    swap_front_back: bool = False
    specs: dict[str, Any] = Field({}, description="spec table values, e.g. {'pouch_height_mm': 210}")
    keyline: dict[str, Any] = Field({}, description="keyline values, e.g. {'zipper_offset_from_top_mm': 25}")
    material: MaterialAdjust = MaterialAdjust()
    scene: SceneAdjust = SceneAdjust()

    def merged_over(self, base: "Adjustments") -> "Adjustments":
        """This job's values over the item default: set fields win, unset ones fall through."""
        panels = dict(base.panels)
        for role, p in self.panels.items():
            b = base.panels.get(role)
            panels[role] = p if b is None else PanelAdjust(**{**b.model_dump(), **p.model_dump(exclude_unset=True)})
        return Adjustments(
            panels=panels,
            swap_front_back=self.swap_front_back or base.swap_front_back,
            specs={**base.specs, **self.specs},
            keyline={**base.keyline, **self.keyline},
            material=MaterialAdjust(**{**base.material.model_dump(), **self.material.model_dump(exclude_unset=True)}),
            scene=SceneAdjust(**{**base.scene.model_dump(), **self.scene.model_dump(exclude_unset=True)}),
        )

    def earliest_step(self) -> str:
        """The first workflow step whose result these adjustments change."""
        if any(k in self.specs for k in ("pouch_height_mm", "pouch_closed_width_mm", "gusset_full_width_mm", "pouch_open_width_mm", "pouch_or_roll_form")):
            return "extract_specs"  # sizes decide how a sheet is split into panels
        if self.specs:
            return "validate"
        # workflow order: ... validate -> match_pouch_type -> resolve_keyline -> link_panels -> build_geometry -> texture -> render
        if self.keyline:
            return "resolve_keyline"
        if self.swap_front_back or any(p.source != "auto" for p in self.panels.values()):
            return "link_panels"  # another artwork source for a panel
        m, s = self.material, self.scene
        if m.finish != "auto" or m.metallic != "auto" or m.plain_color or any(v is not None for v in (s.lighting, s.background, s.shadow, s.views)):
            return "build_geometry"  # materials and the preset live in the geometry spec
        if any(p.bakes() for p in self.panels.values()):
            return "texture"  # overlays and colour correction are drawn into the finished images
        return "render"  # artwork placement only: applied by the scene, the renders just need redoing


def adjustments(ctx) -> Adjustments:
    """The merged adjustments of a job: the job's own over the item's saved default."""
    item = ctx.index.get("item_override", (ctx.job.item_code or "").lower())
    base = Adjustments.model_validate(getattr(item, "adjustments", None) or {})
    own = Adjustments.model_validate(ctx.inputs.get("adjust") or {})
    return own.merged_over(base)
