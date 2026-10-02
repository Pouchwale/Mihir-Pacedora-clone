"""Keyline preview (spec 3.2): 2D dieline SVG of the resolved keyline over the finished artwork.

Units are mm (viewBox), so what the admin sees is exactly what the 3D geometry uses: seal zones
(hatched), zipper track, tear notches, rounded corners, hang hole, window, fold lines and
dimension labels. The artwork is embedded (downscaled JPEG) so the SVG is self-contained.
"""

import base64
import io
from xml.sax.saxutils import escape

from PIL import Image

from app.geometry.spec import GeometrySpec

M = 22.0  # margin around the panel for dimension labels, mm
BLUE = "#1f5bd6"
SEAL = "#ff2d55"


def _embed(image: Image.Image, max_px: int = 1400) -> str:
    im = image.convert("RGB")
    im.thumbnail((max_px, max_px), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _dim_h(x0: float, x1: float, y: float, text: str) -> str:
    return (f'<line x1="{x0}" y1="{y}" x2="{x1}" y2="{y}" class="dim" marker-start="url(#a)" marker-end="url(#a)"/>'
            f'<text x="{(x0 + x1) / 2}" y="{y - 1.5}" class="lbl" text-anchor="middle">{escape(text)}</text>')


def _dim_v(x: float, y0: float, y1: float, text: str) -> str:
    cx, cy = x - 1.5, (y0 + y1) / 2
    return (f'<line x1="{x}" y1="{y0}" x2="{x}" y2="{y1}" class="dim" marker-start="url(#a)" marker-end="url(#a)"/>'
            f'<text x="{cx}" y="{cy}" class="lbl" text-anchor="middle" transform="rotate(-90 {cx} {cy})">{escape(text)}</text>')


def _fmt(v: float) -> str:
    return f"{v:g}"


def panel_svg(role: str, g: GeometrySpec, image: Image.Image | None, color: str | None = None) -> str:
    size = g.panels[role]
    w, h = size.width_mm, size.height_mm
    parts: list[str] = []
    is_face = role in ("front", "back")
    r = g.corner_radius_mm if is_face else 0.0
    if image is not None:
        parts.append(f'<image href="{_embed(image)}" x="0" y="0" width="{w}" height="{h}" preserveAspectRatio="none" clip-path="url(#shape)"/>')
    else:
        parts.append(f'<rect x="0" y="0" width="{w}" height="{h}" rx="{r}" fill="{color or "#dddddd"}"/>')

    if is_face:
        s = g.seals
        seal_rects = []
        if s.side:
            seal_rects += [(0, 0, s.side, h), (w - s.side, 0, s.side, h)]
        top = s.top or s.crimp
        bottom = s.bottom or s.crimp
        if top:
            seal_rects.append((0, 0, w, top))
        if bottom and g.shape != "stand_up_bottom_gusset":
            seal_rects.append((0, h - bottom, w, bottom))
        if g.shape == "stand_up_bottom_gusset" and g.gusset_depth_mm:
            gd = g.gusset_depth_mm
            # K-seal: diagonal corner seals where front meets the bottom gusset
            parts.append(f'<path d="M0 {h - gd} L{min(gd, w / 3)} {h} L0 {h} Z" class="seal"/>')
            parts.append(f'<path d="M{w} {h - gd} L{w - min(gd, w / 3)} {h} L{w} {h} Z" class="seal"/>')
            parts.append(f'<line x1="0" y1="{h - gd}" x2="{w}" y2="{h - gd}" class="fold"/>')
            parts.append(f'<text x="{w / 2}" y="{h - gd - 1.5}" class="note" text-anchor="middle">gusset fold (depth {_fmt(gd)} mm)</text>')
            if bottom:
                seal_rects.append((0, h - bottom, w, bottom))
        for x, y, rw, rh in seal_rects:
            parts.append(f'<rect x="{x}" y="{y}" width="{rw}" height="{rh}" class="seal"/>')
        if g.zipper.enabled:
            zy = g.zipper.y_from_top_mm
            parts.append(f'<line x1="{s.side}" y1="{zy}" x2="{w - s.side}" y2="{zy}" class="zip"/>')
            parts.append(f'<text x="{w / 2}" y="{zy - 1.5}" class="note" text-anchor="middle">zipper {_fmt(zy)} mm from top</text>')
        if g.tear_notch.type != "none":
            ny, d = g.tear_notch.y_from_top_mm, g.tear_notch.depth_mm
            parts.append(f'<path d="M0 {ny - d / 2} L{d} {ny} L0 {ny + d / 2} Z" class="cut"/>')
            parts.append(f'<path d="M{w} {ny - d / 2} L{w - d} {ny} L{w} {ny + d / 2} Z" class="cut"/>')
            parts.append(f'<text x="{d + 1.5}" y="{ny + 1}" class="note">{escape(g.tear_notch.type.replace("_", " "))} {_fmt(ny)} mm</text>')
        if g.hang_hole.type != "none":
            hs, ho = g.hang_hole.size_mm, g.hang_hole.offset_mm
            if g.hang_hole.type == "round":
                parts.append(f'<circle cx="{w / 2}" cy="{ho}" r="{hs / 2}" class="cut"/>')
            else:
                parts.append(f'<rect x="{w / 2 - hs * 1.6}" y="{ho - hs / 2}" width="{hs * 3.2}" height="{hs}" rx="{hs / 2}" class="cut"/>')
        if g.window.enabled:
            win = g.window
            parts.append(f'<rect x="{win.x_mm}" y="{win.y_mm}" width="{win.width_mm}" height="{win.height_mm}" rx="{win.radius_mm}" class="win"/>')
    elif role == "gusset":
        parts.append(f'<line x1="0" y1="{h / 2}" x2="{w}" y2="{h / 2}" class="fold"/>')
        parts.append(f'<text x="{w / 2}" y="{h / 2 - 1.5}" class="note" text-anchor="middle">centre fold (base)</text>')
    elif role.startswith("side"):
        parts.append(f'<line x1="{w / 2}" y1="0" x2="{w / 2}" y2="{h}" class="fold"/>')

    parts.append(f'<rect x="0" y="0" width="{w}" height="{h}" rx="{r}" class="outline"/>')
    parts.append(_dim_h(0, w, -8, f"{_fmt(w)} mm"))
    parts.append(_dim_v(-8, 0, h, f"{_fmt(h)} mm"))
    if is_face and g.seals.side:
        parts.append(_dim_h(0, g.seals.side, h + 8, _fmt(g.seals.side)))
    if is_face and (g.seals.top or g.seals.crimp):
        t = g.seals.top or g.seals.crimp
        parts.append(_dim_v(w + 8, 0, t, _fmt(t)))

    style = (
        f".outline{{fill:none;stroke:{BLUE};stroke-width:.5}}"
        f".seal{{fill:{SEAL};fill-opacity:.18;stroke:{SEAL};stroke-width:.3;stroke-dasharray:1.5 1}}"
        f".fold{{stroke:{BLUE};stroke-width:.35;stroke-dasharray:3 2}}"
        f".zip{{stroke:#00a37a;stroke-width:1.2;stroke-dasharray:1 .8}}"
        f".cut{{fill:#fff;stroke:{BLUE};stroke-width:.4}}"
        f".win{{fill:#9fd3ff;fill-opacity:.35;stroke:{BLUE};stroke-width:.4}}"
        f".dim{{stroke:{BLUE};stroke-width:.3}}"
        f".lbl{{font:3.4px sans-serif;fill:{BLUE}}}.note{{font:2.8px sans-serif;fill:#00664d}}"
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-M} {-M} {w + 2 * M} {h + 2 * M}" width="{w + 2 * M}mm" height="{h + 2 * M}mm">'
        f"<style>{style}</style>"
        f'<defs><marker id="a" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse">'
        f'<path d="M0 0 L6 3 L0 6 Z" fill="{BLUE}"/></marker>'
        f'<clipPath id="shape"><rect x="0" y="0" width="{w}" height="{h}" rx="{r}"/></clipPath></defs>'
        f'<rect x="{-M}" y="{-M}" width="{w + 2 * M}" height="{h + 2 * M}" fill="#ffffff"/>'
        + "".join(parts)
        + f'<text x="{-M + 2}" y="{-M + 5}" class="lbl">{escape(role)} · {escape(g.template)}</text></svg>'
    )
