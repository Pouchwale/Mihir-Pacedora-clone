"""texture: finished panel textures, material masks and keyline previews.

Per panel (spec 2.1 c-e): cut the bleed with the resolved keyline values, verify the finished
size against the pouch size (+/- tolerance), run the technical-colour safety scan, then:
- a web texture (JPEG, <= 4096 px, what WebGL loads) next to the full-resolution PNG;
- material masks: `metal` (where a metallised film shows through: unprinted areas when the job
  has no white ink) and `spot` (spot varnish separation, when the PDF carries one);
- the keyline preview SVG.
Seals, zipper, notches and corners are never cut out of the image (spec 2.1 d).

Job-page adjustments (app.workflow.adjust) are baked here: an "image" panel (an uploaded picture or
PDF page) is fitted to the panel size, and every panel's colour correction and overlays (logos,
text) are drawn into its finished image (app.workflow.panel_art), so renders, GLB and viewer agree.
"""

import io
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from pydantic import BaseModel

from app.errors import NeedsReview
from app.geometry.dieline import panel_svg
from app.models import UploadedFile
from app.ocr import pdf_text
from app.pdf.inks import emphasize_inks
from app.pdf.layers import Box, output_intent_profile, write_layer_copy
from app.pdf.render import pdftoppm_png
from app.specs.validate import Issue
from app.steps import trim_artwork as trim_impl
from app.steps.trim_artwork import Sides
from app.workflow import panel_art
from app.workflow.adjust import PanelAdjust, adjustments
from app.workflow.context import StepContext
from app.workflow.steps.build_geometry import Output as GeometryOutput
from app.workflow.steps.link_panels import Output as LinkOutput
from app.workflow.steps.resolve_keyline import Output as KeylineOutput
from app.workflow.steps.validate import Output as ValidateOutput

WEB_MAX = 4096
MASK_MAX = 1024


class PanelTexture(BaseModel):
    role: str
    source: str
    finished_key: str | None
    web_key: str
    width_mm: float
    height_mm: float
    px: tuple[int, int]
    masks: dict[str, str]  # metal / spot -> storage key (grayscale PNG, white = effect on)
    preview_key: str
    technical_preview_key: str | None = None
    color: str | None = None
    raw_web_key: str | None = None  # the web texture before overlays / colour correction were baked in (the job page previews on it)
    clear: bool = False  # transparent unprinted film (a "Window" side / gusset)


class Output(BaseModel):
    textures: dict[str, PanelTexture]
    issues: list[Issue]


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def _jpeg(img: Image.Image, max_px: int) -> bytes:
    """The web texture: lossless WebP (the 3D model shows the print colours exactly; JPEG would shift
    them by a few values), no larger than `max_px` on its long side."""
    im = img.convert("RGB")
    if max(im.size) > max_px:
        im.thumbnail((max_px, max_px), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="WEBP", lossless=True, quality=100, method=1)
    return buf.getvalue()


def _load(ctx: StepContext, key: str) -> Image.Image:
    img = Image.open(io.BytesIO(ctx.storage.get_bytes(key)))
    img.load()
    return img


def run(ctx: StepContext) -> Output:
    geo = ctx.output("build_geometry", GeometryOutput).geometry
    panels = ctx.output("link_panels", LinkOutput).panels
    keyline = ctx.output("resolve_keyline", KeylineOutput).keyline.values()
    sheet = ctx.output("validate", ValidateOutput).sheet
    profile = ctx.index.pdf_profile()
    client = ctx.index.all("client").get(ctx.output("resolve_keyline", KeylineOutput).client or "")
    if client is not None and getattr(client, "include_eyemarks", False):
        profile = profile.model_copy(update={"include_eyemarks": True})
    acknowledged = set(ctx.inputs.get("acknowledged") or [])
    inks = [i.lower() for i in (sheet.spec_table.inks.value or [])]
    # A white plate in the ink row or in the PDF's own separations: no bare metallised film shows.
    has_white = any(w.lower() in inks for w in profile.white_inks) or any(p.trim and p.trim.inks.get("white") for p in panels.values())
    wants_metal = "white_less" in geo.materials.surfaces
    wants_spot = "spot" in geo.materials.surfaces

    textures: dict[str, PanelTexture] = {}
    issues: list[Issue] = []
    previews: dict[str, str] = {}
    front_bleed = Sides(left=keyline.get("bleed_left_mm") or 0, right=keyline.get("bleed_right_mm") or 0,
                        top=keyline.get("bleed_top_mm") or 0, bottom=keyline.get("bleed_bottom_mm") or 0)

    adj = adjustments(ctx)
    plain_colour = adj.material.plain_color
    dpi = float(keyline.get("texture_dpi") or 300)
    art_cache: dict[int, Image.Image | None] = {}

    def art_image(file_id: int) -> Image.Image | None:
        """An uploaded picture / PDF page used as a logo overlay (None when the file is gone)."""
        if file_id not in art_cache:
            row = ctx.session.get(UploadedFile, file_id)
            try:
                art_cache[file_id] = panel_art.open_upload(ctx.storage.get_bytes(row.storage_key), dpi) if row else None
            except (FileNotFoundError, OSError, KeyError):
                art_cache[file_id] = None
            if art_cache[file_id] is None:
                ctx.log(f"overlay image {file_id} is missing; skipped", "warning")
        return art_cache[file_id]

    def baked(role: str, img: Image.Image, width_mm: float) -> tuple[Image.Image, bool]:
        """`img` with the panel's colour correction and overlays drawn in (flag: anything changed)."""
        pa = adj.panels.get(role) or PanelAdjust()
        if not pa.bakes():
            return img, False
        out = panel_art.compose(img, pa, width_mm, art_image)
        ctx.log(f"{role}: baked {len(pa.overlays)} overlay(s)" + (", colour correction" if pa.brightness or pa.contrast or pa.saturation else ""), "audit",
                {"brightness": pa.brightness, "contrast": pa.contrast, "saturation": pa.saturation,
                 "overlays": [o.model_dump(include={"kind", "text", "file_id", "x_mm", "y_mm", "width_mm", "size_mm", "rotation"}) for o in pa.overlays]})
        return out, True

    def raw_web(base: str, raw: Image.Image | None) -> str | None:
        """The web texture before the bake, for the job page's live preview (None when nothing was baked)."""
        return ctx.storage.put_bytes(f"{base}_web_raw.webp", _jpeg(raw, WEB_MAX), "image/webp") if raw is not None else None

    def store_panel(role: str, img: Image.Image, source: str, base: str, w: float, h: float, spot: str | None = None,
                    raw: Image.Image | None = None) -> PanelTexture:
        """Finished PNG, masks, web texture and keyline preview of a panel image drawn by this step."""
        fin_key = ctx.storage.put_bytes(f"{base}_finished.png", _png(img), "image/png")
        masks: dict[str, str] = {}
        if wants_metal and not has_white:
            masks["metal"] = ctx.storage.put_bytes(f"{base}_metal.png", _png(_unprinted_mask(img)), "image/png")
        if spot:
            masks["spot"] = spot
        web_key = ctx.storage.put_bytes(f"{base}_web.webp", _jpeg(img, WEB_MAX), "image/webp")
        prev = ctx.storage.put_bytes(f"{base}_keyline.svg", panel_svg(role, geo, img).encode(), "image/svg+xml")
        return PanelTexture(role=role, source=source, finished_key=fin_key, web_key=web_key, width_mm=w, height_mm=h, px=img.size, masks=masks,
                            preview_key=prev, raw_web_key=raw_web(base, raw))

    # Sizes the operator typed or corrected win over the drawing (spec review, details form, job-page
    # adjustments): artwork cut at the dieline that comes out another size is fitted to the panel.
    corrections = ctx.inputs.get("spec_corrections") or {}
    operator_sized = {f for f in ("pouch_closed_width_mm", "pouch_height_mm", "pouch_open_width_mm") if f"spec_table.{f}" in corrections}
    tol = profile.finished_size_tolerance_mm
    for role in sorted(panels, key=lambda r: r != "front"):  # front first: substitutes reuse it
        p = panels[role]
        w, h = p.expected_mm
        base = f"{ctx.prefix}/{ctx.job.item_code or 'item'}_{role}"
        if p.source == "plain":
            p.color = plain_colour or p.color
            raw = panel_art.blank(p.color or "#dddddd", (w, h), dpi)
            img, changed = baked(role, raw, w)
            if changed:  # a logo or text on plain film: a real image, not a colour
                textures[role] = store_panel(role, img, "plain", base, w, h, raw=Image.new("RGB", (64, 64), p.color or "#dddddd"))
                continue
            img = Image.new("RGB", (64, 64), p.color or "#dddddd")
            web_key = ctx.storage.put_bytes(f"{base}_web.webp", _jpeg(img, 64), "image/webp")
            svg = panel_svg(role, geo, None, p.color)
            prev = ctx.storage.put_bytes(f"{base}_keyline.svg", svg.encode(), "image/svg+xml")
            textures[role] = PanelTexture(role=role, source="plain", finished_key=None, web_key=web_key, width_mm=w, height_mm=h,
                                          px=img.size, masks={}, preview_key=prev, color=p.color, clear=p.clear)
            continue
        if p.source == "front":
            f = textures["front"]
            front_img = _load(ctx, f.finished_key) if f.finished_key else None
            if front_img is not None:
                img, changed = baked(role, front_img, w)
                if changed:  # this panel's own overlays on the front's artwork
                    textures[role] = store_panel(role, img, "front", base, w, h, spot=f.masks.get("spot"), raw=front_img)
                    continue
            svg = panel_svg(role, geo, front_img)
            prev = ctx.storage.put_bytes(f"{base}_keyline.svg", svg.encode(), "image/svg+xml")
            textures[role] = f.model_copy(update={"role": role, "source": "front", "preview_key": prev, "technical_preview_key": None})
            continue
        if p.source == "image":
            # An uploaded picture (or PDF page) fitted to the panel: cover / contain / stretch, as set.
            pa = adj.panels.get(role) or PanelAdjust()
            f_row = ctx.session.get(UploadedFile, p.file_id)
            if f_row is None:
                raise NeedsReview("panel_file_missing", f"{role}: the uploaded picture is gone; upload it again or pick another source",
                                  {"form": "panels", "missing": [{"role": role, "code": None, "expected_mm": (w, h)}], "found": {}})
            src = panel_art.open_upload(ctx.storage.get_bytes(f_row.storage_key), dpi)
            raw = panel_art.fit_image(src, panel_art.pixel_size((w, h), dpi), pa.fit, pa.background)
            img, changed = baked(role, raw, w)
            textures[role] = store_panel(role, img, "image", base, w, h, raw=raw if changed else None)
            ctx.log(f"{role}: {f_row.filename} ({src.width}x{src.height} px) fitted '{pa.fit}' to {w:g} x {h:g} mm = {img.width}x{img.height} px at {dpi:g} dpi",
                    "audit", {"sha256": f_row.sha256, "fit": pa.fit})
            continue

        trim = p.trim
        assert trim is not None
        f_row = ctx.session.get(UploadedFile, p.file_id)
        pdf = ctx.local_file(f_row)
        # Files without layers print their eyemarks as part of the artwork: nothing to add.
        if profile.include_eyemarks and trim.mode == "layers":
            trim = trim_impl.run(trim_impl.TrimArtworkInput(pdf_path=pdf, filename=f_row.filename, panel=role, key_prefix=ctx.prefix), profile, ctx.storage)
        # Panels & artwork rules (PDF profile): a fixed bleed for linked PDFs of this role, an extra
        # turn and a mirror, on top of what the panel itself needs to stand upright.
        rule = profile.panel_rule(role)
        # the job's own front takes the keyline's bleed; a front replaced by another PDF, its measured one
        bleed = front_bleed if role == "front" and (p.file_id == ctx.job.file_id or p.bleed is None) else p.bleed
        if p.source == "blank":
            bleed = Sides.uniform(0)  # the blank is cut exactly at the dieline
        elif role != "front" and p.source == "file" and rule.bleed_mm is not None:
            bleed = Sides.uniform(rule.bleed_mm)
        turn = (p.turn + rule.rotation) % 360
        open_w = float(sheet.spec_table.pouch_open_width_mm.value or 2 * w)
        cw, ch = (open_w, h) if p.source == "blank" else (w, h)  # a blank is the whole flat pouch, open width wide
        ew, eh = (ch, cw) if turn in (90, 270) else (cw, ch)
        fitted = _fit_to_operator_size(trim, bleed, (ew, eh), turn, p.source, operator_sized, tol, ctx.index.validation_rules().dimension_tolerance_mm)
        try:
            fin = trim_impl.finish(trim, pdf, bleed, *(fitted or (ew, eh)), ctx.prefix, profile, ctx.storage)
        except NeedsReview as exc:
            if exc.code != "finished_size" or not ctx.settings.auto_review:
                raise
            # no person to ask: the artwork between its dieline lines is fitted to the panel size
            fitted = tuple(exc.details["finished_mm"])
            fin = trim_impl.finish(trim, pdf, bleed, *fitted, ctx.prefix, profile, ctx.storage)
        img = _load(ctx, fin.finished_key)
        labels: list[str] = []
        face_window = None  # a window drawn in the face's artwork, transformed with the image below
        if role in ("front", "back"):
            x0, y0, x1, y1 = trim.trim_box_pt
            b, pt = fin.bleed_mm, 72 / 25.4
            box = (x0 + b.left * pt, y0 + b.bottom * pt, x1 - b.right * pt, y1 - b.top * pt)
            img, labels = drop_labels(img, pdf, box, fin.finished_mm[0])
            if labels:
                ctx.log(f"{role}: technical note(s) on the drawing painted out: {' '.join(labels)}", "audit")
            img, face_window = window_marked(img, pdf, box, fin.finished_mm[0])
            if face_window is not None:
                labels.append("Window")
        if fitted:
            size = (max(1, round(img.width * ew / fitted[0])), max(1, round(img.height * eh / fitted[1])))
            img = img.resize(size, Image.LANCZOS)
            face_window = face_window.resize(size, Image.NEAREST) if face_window is not None else None
            issues.append(Issue(code="artwork_fitted", field=f"artwork.{role}", severity="warning",
                                message=f"{role}: the artwork between the dieline lines is {fitted[0]:g} x {fitted[1]:g} mm; "
                                        f"fitted to the {ew:g} x {eh:g} mm panel size"))
            ctx.log(issues[-1].message, "warning")
        if turn:
            img = img.rotate(turn, expand=True)
            face_window = face_window.rotate(turn, expand=True, fillcolor=255) if face_window is not None else None
        if p.source == "blank":
            front_img, back_img = split_blank(img, open_w, w)
            img = front_img if role == "front" else back_img
            if face_window is not None:
                face_window = split_blank(face_window.convert("RGB"), open_w, w)[0 if role == "front" else 1].convert("L")
        if rule.mirror:
            img = ImageOps.mirror(img)
            face_window = ImageOps.mirror(face_window) if face_window is not None else None
        if face_window is not None and face_window.getextrema()[0] == 255:
            face_window = None  # the window lies on the other face of the blank
        marks: list = []
        ruled = 0
        if role in ("front", "back") and trim.mode != "layers":
            # (a layered file draws its dieline on a technical layer the render already leaves out)
            img, ruled = drop_drawn_rules(img, w, geo.seals.top, geo.seals.bottom)
            if ruled:
                ctx.log(f"{role}: {ruled} dieline / seal line(s) drawn in the artwork removed", "audit")
        if role != "roll" and not profile.include_eyemarks:
            # (sides and gussets carry eyemarks too: FGPO7030's black squares in the gussets' bottom corners)
            img, marks = drop_eyemarks(img, w, geo.seals.side, geo.seals.top, geo.seals.bottom)
            if marks:
                ctx.log(f"{role}: {len(marks)} eyemark(s) in the seals removed: " + ", ".join(f"{a:g} x {b:g} mm" for a, b in marks), "audit")
        window = face_window
        if role.startswith("side") or role == "gusset":
            window = window_rect(img, w)
            if window is not None and not window_named(ctx, pdf, trim):
                window = None  # an unprinted white area is a window only where the designer says "Window"
        raw = img
        img, changed = baked(role, img, w) if role != "roll" else (img, False)
        # a flat blank's two faces are cut from one render: each keeps its own file (sharing the blank's,
        # the back overwrote the front, and "back: same as front" or a download got the wrong face)
        finished_key = f"{base}_finished.png" if p.source == "blank" else fin.finished_key
        if turn or rule.mirror or p.source == "blank" or fitted or changed or labels or marks or ruled:
            ctx.storage.put_bytes(finished_key, _png(img), "image/png")
        if rule.rotation or rule.mirror or (rule.bleed_mm is not None and role != "front"):
            ctx.log(f"{role}: panel rule applied (turn {rule.rotation}, mirror {rule.mirror}, bleed {rule.bleed_mm})", "audit")
        for issue in fin.issues:
            key = f"{issue.code}@{issue.field}"
            if key in acknowledged:
                issue = Issue(**{**issue.model_dump(), "severity": "warning"})
            issues.append(issue)
            if fin.preview_key:
                previews[role] = fin.preview_key

        masks: dict[str, str] = {}
        if wants_metal and not has_white:
            masks["metal"] = ctx.storage.put_bytes(f"{base}_metal.png", _png(_unprinted_mask(img)), "image/png")
        if wants_spot and p.source != "blank":  # (a blank's spot mask would need the same split; not done)
            spot = _spot_mask(pdf, trim, bleed, profile, turn)
            if spot is not None:
                masks["spot"] = ctx.storage.put_bytes(f"{base}_spot.png", _png(spot), "image/png")
        if window is not None:
            masks["window"] = ctx.storage.put_bytes(f"{base}_window.png", _png(window), "image/png")
            ctx.log(f"{role}: the unprinted area marked \"Window\" is clear film", "audit")
        web_key = ctx.storage.put_bytes(f"{base}_web.webp", _jpeg(img, WEB_MAX), "image/webp")
        svg = panel_svg(role, geo, img)
        prev = ctx.storage.put_bytes(f"{base}_keyline.svg", svg.encode(), "image/svg+xml")
        textures[role] = PanelTexture(role=role, source=p.source, finished_key=finished_key, web_key=web_key, width_mm=w, height_mm=h,
                                      px=img.size, masks=masks, preview_key=prev, technical_preview_key=fin.preview_key,
                                      raw_web_key=raw_web(base, raw if changed else None))
        ctx.log(f"{role}: finished {img.width}x{img.height} px = {fin.finished_mm[0]} x {fin.finished_mm[1]} mm", "audit",
                {"bleed": bleed.model_dump(), "technical_pixels": fin.technical_pixels})
        if role == "roll":
            # The formed sachet: one pouch blank cut from the repeat, split into the pillow's front and back.
            open_w = float(sheet.spec_table.pouch_open_width_mm.value or 0)
            front_img, back_img, where = roll_blank_faces(img, geo, open_w, sheet.measured_keyline, turn)
            ctx.log(f"sachet: blank {where}", "audit")
            for face, raw_face in (("front", front_img), ("back", back_img)):
                face_img, face_changed = baked(face, raw_face, geo.width_mm)
                fb = f"{ctx.prefix}/{ctx.job.item_code or 'item'}_{face}"
                ctx.storage.put_bytes(f"{fb}_finished.png", _png(face_img), "image/png")
                web_face = ctx.storage.put_bytes(f"{fb}_web.webp", _jpeg(face_img, WEB_MAX), "image/webp")
                svg_face = panel_svg(face, geo, face_img)
                prev_face = ctx.storage.put_bytes(f"{fb}_keyline.svg", svg_face.encode(), "image/svg+xml")
                textures[face] = PanelTexture(role=face, source="roll", finished_key=f"{fb}_finished.png", web_key=web_face,
                                              width_mm=geo.width_mm, height_mm=geo.height_mm, px=face_img.size, masks={}, preview_key=prev_face,
                                              raw_web_key=raw_web(fb, raw_face if face_changed else None))

    blocking = [i for i in issues if i.severity == "review"]
    if blocking:
        raise NeedsReview("technical_marks", "Keyline-coloured marks were found on the artwork and masked; check the highlighted previews", {
            "form": "texture",
            "issues": [i.model_dump() for i in blocking],
            "previews": previews,
        })
    if wants_metal and has_white:
        ctx.log("Metallised film with white ink: metal only where the separations show no white (none detected)", "info")
    return Output(textures=textures, issues=issues)


def _fit_to_operator_size(trim: trim_impl.TrimArtworkOutput, bleed: Sides, expected: tuple[float, float], turn: int, source: str,
                          operator_sized: set[str], tol: float, dim_tol: float = 0.0) -> tuple[float, float] | None:
    """The size the bleed cut really gives (trim minus bleed, in the PDF's orientation) when it differs
    from the expected panel size on an axis the operator set; None when the cut fits (or the mismatch
    is nobody's decision, so the finished-size check must still stop the job)."""
    fw = round(trim.trim_width_mm - bleed.left - bleed.right, 3)
    fh = round(trim.trim_height_mm - bleed.top - bleed.bottom, 3)
    width_field = "pouch_open_width_mm" if source == "blank" else "pouch_closed_width_mm"
    across, down = ("pouch_height_mm", width_field) if turn in (90, 270) else (width_field, "pouch_height_mm")
    off_w, off_h = abs(fw - expected[0]) > tol, abs(fh - expected[1]) > tol
    if not (off_w or off_h) or fw <= 0 or fh <= 0:
        return None
    within = abs(fw - expected[0]) <= dim_tol and abs(fh - expected[1]) <= dim_tol
    # (a drawing within the index's dimension tolerance of the table is fitted too: FGPO7002, 264 drawn for 265)
    if not within and ((off_w and across not in operator_sized) or (off_h and down not in operator_sized)):
        return None
    return fw, fh


def _cell_start(segments: list[float], size: float, tol: float = 0.6) -> float | None:
    """Offset of the first run of consecutive dieline segments that add up to `size` mm."""
    pos = 0.0
    for i in range(len(segments)):
        acc = 0.0
        for j in range(i, len(segments)):
            acc += segments[j]
            if abs(acc - size) <= tol:
                return pos
            if acc > size + tol:
                break
        pos += segments[i]
    return None


def roll_blank_faces(repeat: Image.Image, geo, open_w: float, measured, turn: int) -> tuple[Image.Image, Image.Image, str]:
    """Front and back of the pillow sachet formed from one pouch blank of the print repeat.

    The blank is `height x open width`; on the repeat it is found from the dieline's cells (the
    first run of segments adding up to each size), else taken from the repeat's corner. Turned so
    the pouch height is vertical. The pillow's front is the middle `closed width` of the blank; the
    back is what wraps round behind it, joined at the fin seal (fin = (open - 2 x closed) / 2).
    """
    w, h = geo.width_mm, geo.height_mm
    open_w = open_w or 2 * w
    img = repeat.rotate(-turn, expand=True) if turn else repeat  # back to the sheet's orientation
    rep_w_mm, rep_h_mm = (geo.roll.repeat_mm, geo.roll.web_width_mm) if turn in (0, 180) else (geo.roll.web_width_mm, geo.roll.repeat_mm)
    px = img.width / rep_w_mm
    xs, ys = list(measured.width_segments_mm.value), list(measured.height_segments_mm.value)
    off_x, off_y = float(measured.bleed_left_mm.value or 0), float(measured.bleed_top_mm.value or 0)
    # Which axis carries the pouch height? Try height along x (sheet width), then along y.
    if _cell_start(xs, h) is not None or abs(rep_w_mm - h) <= 0.6:
        cx, cy = _cell_start(xs, h), _cell_start(ys, open_w)
        cw, ch, height_along_x = h, open_w, True
    else:
        cx, cy = _cell_start(xs, open_w), _cell_start(ys, h)
        cw, ch, height_along_x = open_w, h, False
    where = "from the dieline cells" if cx is not None and cy is not None else "from the repeat's corner"
    x0 = (off_x + cx) if cx is not None else 0.0
    y0 = (off_y + cy) if cy is not None else 0.0
    x0, y0 = min(x0, max(0.0, rep_w_mm - cw)), min(y0, max(0.0, rep_h_mm - ch))
    blank = img.crop((round(x0 * px), round(y0 * px), round((x0 + cw) * px), round((y0 + ch) * px)))
    if height_along_x:
        blank = blank.rotate(-90, expand=True)  # height upright; reading top to bottom (adjustable on the job page)
    front, back = split_blank(blank, open_w, w)
    fin = max(0.0, (open_w - 2 * min(w, open_w / 2)) / 2)
    return front, back, f"{where}: {cw:g} x {ch:g} mm at {x0:g}, {y0:g} mm, fin {fin:g} mm"


def split_blank(blank: Image.Image, open_w: float, w: float) -> tuple[Image.Image, Image.Image]:
    """The pillow's faces from an upright flat blank (`open_w` wide, pouch height tall): the front is
    the middle `w` (closed width); the back is what wraps round behind it, the two outer strips
    joined at the fin seal (fin = (open - 2 x closed) / 2)."""
    bw = blank.width
    closed = min(w, open_w / 2)
    fin = max(0.0, (open_w - 2 * closed) / 2)
    k = bw / open_w
    front_px, half_px = round(closed * k), round(closed / 2 * k)  # exact widths first, then positions
    fx = round((open_w - closed) / 2 * k)
    front = blank.crop((fx, 0, fx + front_px, blank.height))
    rx = round((open_w - fin) * k) - half_px
    right = blank.crop((rx, 0, rx + half_px, blank.height))
    lx = round(fin * k)
    left = blank.crop((lx, 0, lx + half_px, blank.height))
    back = Image.new("RGB", (right.width + left.width, blank.height))
    back.paste(right, (0, 0))
    back.paste(left, (right.width, 0))
    return front, back


WINDOW_ALPHA = 34  # alpha of clear film in a window mask (the 3D viewer's operator windows use the same)


def window_rect(img: Image.Image, width_mm: float) -> Image.Image | None:
    """A window left unprinted in a side / gusset panel (FGPO7030 / FGPO7032: the 1 kg pouches' side
    gussets print the logo at the top and the base colour below, and leave the middle "Window" clear):
    the largest unprinted (paper-white) rectangle, at least a quarter of the panel and filling its box.
    Returns an alpha mask (255 film, WINDOW_ALPHA in the window) or None."""
    from collections import deque

    k = img.width / width_mm
    cell = max(1, round(k))  # 1 mm grid
    small = np.asarray(img.convert("RGB").reduce(cell)).astype(int)
    white = small.min(axis=2) >= 240  # (a corner an eyemark was filled in reads a hair off white)
    gh, gw = white.shape
    seen = np.zeros_like(white)
    best: list[tuple[int, int]] = []
    for sy, sx in zip(*np.nonzero(white)):  # the largest 4-connected white area
        if seen[sy, sx]:
            continue
        seen[sy, sx] = True
        q, cells = deque([(sy, sx)]), []
        while q:
            y, x = q.popleft()
            cells.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < gh and 0 <= nx < gw and white[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if len(cells) > len(best):
            best = cells
    if not best:
        return None
    comp = np.zeros_like(white)
    ys, xs = zip(*best)
    comp[list(ys), list(xs)] = True
    # the window's own box: rows / columns the area covers at least half as fully as its widest, so a few
    # stray near-white cells (a corner an eyemark was filled in) do not stretch it
    rows, cols = comp.sum(axis=1), comp.sum(axis=0)
    ry, cx = np.nonzero(rows >= 0.5 * rows.max())[0], np.nonzero(cols >= 0.5 * cols.max())[0]
    y0, y1, x0, x1 = ry.min(), ry.max() + 1, cx.min(), cx.max() + 1
    area = (y1 - y0) * (x1 - x0)
    if comp[y0:y1, x0:x1].sum() < 0.9 * area or area < 0.25 * white.size:
        return None
    mask = Image.new("L", img.size, 255)
    mask.paste(WINDOW_ALPHA, (x0 * cell, y0 * cell, min(img.width, x1 * cell), min(img.height, y1 * cell)))
    return mask


def window_marked(img: Image.Image, pdf: Path, box_pt: tuple[float, float, float, float], width_mm: float) -> tuple[Image.Image, Image.Image | None]:
    """A window drawn into a face's artwork (FGPO6813: a white leaf on the front labelled "Transparent
    Window"): the unprinted white area around a "Window" label in the text layer, whatever its shape,
    is clear film, and the label (a note to the printer) goes. Returns the image with the label painted
    out and an alpha mask (255 film, WINDOW_ALPHA in the window), or the image as it was and None.
    (A spec table's "Transparent Window:" field ends in a colon and lies outside the panel: never a label.)"""
    from collections import deque

    dpi = img.width / (width_mm / 25.4)
    words = [w for w in pdf_text.words(pdf, Box(*box_pt), round(dpi)) if 0 <= w.left < img.width and 0 <= w.top < img.height]
    labels = [w for w in words if w.text.lower().strip(".,()") == "window"]
    if not labels:
        return img, None
    # the whole note: the words beside or above the key word ("Transparent", "Clear")
    line = {id(w): w for h in labels for w in words
            if abs(w.top - h.top) <= 2 * h.height and abs((w.left + w.right) / 2 - (h.left + h.right) / 2) <= 6 * h.height}
    arr = np.asarray(img.convert("RGB")).copy()
    for w in line.values():
        pad = max(2, round(0.5 * w.height))
        arr[max(0, w.top - pad):w.top + w.height + pad, max(0, w.left - pad):w.right + pad] = 255
    cleaned = Image.fromarray(arr)
    k = img.width / width_mm
    cell = max(1, round(k / 2))  # 0.5 mm grid
    white = np.asarray(cleaned.reduce(cell)).astype(int).min(axis=2) >= 235
    gh, gw = white.shape
    seen = np.zeros_like(white)
    q = deque()
    for h in labels:
        y, x = min(gh - 1, (h.top + h.height // 2) // cell), min(gw - 1, ((h.left + h.right) // 2) // cell)
        if white[y, x] and not seen[y, x]:
            seen[y, x] = True
            q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < gh and 0 <= nx < gw and white[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    share = seen.sum() / seen.size
    if not 0.01 <= share <= 0.5:  # a label on a printed area, or a white pouch: no window shape to take
        return img, None
    mask = Image.fromarray(np.where(seen, WINDOW_ALPHA, 255).astype(np.uint8), "L").resize(img.size, Image.NEAREST)
    return cleaned, mask


def window_named(ctx: StepContext, pdf: Path, trim) -> bool:
    """The panel's PDF says "Window" (its text, or OCR when outlined)."""
    import pymupdf

    from app.ocr import tesseract
    from app.workflow.steps.link_panels import _window_label

    try:
        if _window_label(ctx, pdf, trim):
            return True
    except Exception:  # noqa: BLE001 - (a two-page approval file): the page itself is read below
        pass
    try:
        # the label drawn in a technical ink the artwork render leaves out (FGPO7030: an outlined blue
        # "Window" on each gusset): read the whole page as printed, every ink, turned each way
        doc = pymupdf.open(pdf)
        pix = doc[-1].get_pixmap(dpi=60)
        page = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("L")
        # (turned only: a gusset's label runs along the tall panel, while the spec table's
        # "Transparent Window:" field on the same page reads level and must not count)
        return any(w.text.strip().lower() == "window" for angle in (90, 270) for w in tesseract.words(page.rotate(angle, expand=True), psm=11))
    except Exception:  # noqa: BLE001 - unreadable: no window
        return False


LABEL_WORDS = {"notch", "v-notch", "vnotch", "spout", "hang", "euro"}  # a technical note's key word
LABEL_EDGE_MM = 15.0  # notes sit on the dieline at the panel edge; product text stays further in


def drop_labels(img: Image.Image, pdf: Path, box_pt: tuple[float, float, float, float], width_mm: float) -> tuple[Image.Image, list[str]]:
    """Technical notes written on the drawing in the artwork's own ink ("V NOTCH" on FGPO6813's top seal,
    "SPOUT" in FGPO5834's corner) out of a panel: text-layer words within LABEL_EDGE_MM of the panel edge
    whose line names a notch / spout / hang hole, filled from the colour around them. `box_pt` is the
    panel's box on the page (PDF points), the image that box upright."""
    from app.pdf.safety import mask_out

    dpi = img.width / (width_mm / 25.4)
    words = pdf_text.words(pdf, Box(*box_pt), round(dpi))
    k = img.width / width_mm
    edge = LABEL_EDGE_MM * k
    near = [w for w in words if w.left < edge or w.right > img.width - edge or w.top < edge or w.top + w.height > img.height - edge]
    hits = [w for w in near if w.text.lower().strip(".:,()") in LABEL_WORDS]
    # the rest of the note: words on the same line right beside a key word ("V", "TEAR", "HOLE", "SLOT")
    line = [w for w in near for h in hits if w is not h and abs(w.top - h.top) <= h.height and min(abs(w.left - h.right), abs(h.left - w.right)) <= 2 * h.height]
    marked = hits + [w for w in line if len(w.text) <= 6]
    if not marked:
        return img, []
    mask = np.zeros((img.height, img.width), bool)
    for w in marked:
        pad = max(2, round(0.6 * w.height))  # the glyph core grows back to the full letters
        # a note's pointer sits right above or below it (FGPO6813: the small triangle under "V NOTCH")
        vpad = max(pad, round(2.5 * w.height))  # (text-layer boxes are the glyph core: ~2 mm for an 8 pt note)
        mask[max(0, w.top - vpad):w.top + w.height + vpad, max(0, w.left - pad // 2):w.right + pad // 2] = True
    return mask_out(img, mask, radius=max(4, round(2 * k))), sorted({w.text for w in marked})


RULE_COVER = 0.85  # share of a face's width (height) a drawn rule's dark row (column) covers
RULE_MAX_MM = 0.6  # a rule is a hairline; a stripe in the design is thicker
POINTER_MAX_MM = 4.0


def drop_drawn_rules(img: Image.Image, width_mm: float, top: float, bottom: float) -> tuple[Image.Image, int]:
    """The dieline drawn into the artwork itself (files with no technical ink, FGPO6813): hairline rules
    across the whole face in the top and bottom seal bands (the cut edge and the seal lines), rules down
    the whole face (the back's fin line), and the small pointers drawn on them (the V-notch triangles),
    filled from the colour around them. Returns the image and the number of rules removed."""
    from collections import deque

    from app.pdf.safety import mask_out

    k = img.width / width_mm
    dark = np.asarray(img.convert("RGB")).max(axis=2) < 100
    h, w = dark.shape
    thin = max(1, round(RULE_MAX_MM * k))

    def rules(cover: np.ndarray, allowed: np.ndarray) -> list[tuple[int, int]]:
        flags, runs, start = (cover >= RULE_COVER) & allowed, [], None
        for i, f in enumerate([*flags, False]):
            if f and start is None:
                start = i
            elif not f and start is not None:
                if i - start <= thin:
                    runs.append((start, i))
                start = None
        return runs

    band = round((max(top, bottom) + 3) * k)
    rows_ok = np.zeros(h, bool)
    rows_ok[:band] = rows_ok[h - band:] = True
    rows = rules(dark.mean(axis=1), rows_ok)
    cols = rules(dark.mean(axis=0), np.ones(w, bool))
    if not rows and not cols:
        return img, 0
    mask = np.zeros_like(dark)
    near = np.zeros_like(dark)
    reach = round(3 * k)  # a pointer sits on its rule
    for a, b in rows:
        mask[max(0, a - 1):b + 1, :] = True
        near[max(0, a - reach):b + reach, :] = True
    for a, b in cols:
        mask[:, max(0, a - 1):b + 1] = True
    # pointers: small dark shapes touching a removed rule
    cand = dark & near & ~mask
    seen = np.zeros_like(cand)
    limit = POINTER_MAX_MM * k
    for y, x in zip(*np.nonzero(cand)):
        if seen[y, x]:
            continue
        q, cells = deque([(y, x)]), []
        seen[y, x] = True
        while q and len(cells) <= int(limit * limit):
            cy, cx = q.popleft()
            cells.append((cy, cx))
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and cand[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        cy, cx = zip(*cells)
        if not q and max(cy) - min(cy) <= limit and max(cx) - min(cx) <= limit:
            mask[max(0, min(cy) - 2):max(cy) + 3, max(0, min(cx) - 2):max(cx) + 3] = True
    return mask_out(img, mask, radius=max(4, round(1.5 * k))), len(rows) + len(cols)


def drop_eyemarks(img: Image.Image, width_mm: float, side: float, top: float, bottom: float) -> tuple[Image.Image, list[tuple[float, float]]]:
    """The print eyemark (the sensor mark the bag machine reads) out of a face: a solid near-black block
    lying in a seal and touching the panel edge (FGPO7150: 10 x 10 mm in the back's bottom corners).
    It is printed on the web, but not part of the pouch's look (PdfProfile.include_eyemarks; layered
    files keep it on its own layer). Filled from the seal colour around it. Returns the marks' sizes."""
    from app.pdf.safety import mask_out

    k = img.width / width_mm  # px per mm
    cell = max(1, round(k / 2))  # 0.5 mm grid
    small = np.asarray(img.convert("RGB").reduce(cell)).astype(int)
    gh, gw = small.shape[:2]
    mm = cell / k
    ys, xs = np.mgrid[0:gh, 0:gw] * mm
    hmm, wmm = gh * mm, gw * mm
    band = (xs < side + 1.5) | (xs > wmm - side - 1.5) | (ys < top + 1.5) | (ys > hmm - bottom - 1.5)
    marks: list[tuple[float, float]] = []
    mask = np.zeros((img.height, img.width), bool)
    # Two kinds: a near-black block on a light seal (FGPO7150), and a white block on a dark seal (FGPO7029's
    # back: white squares in the green bottom corners). (All dark / all white: a photo's area reaching into
    # a seal is one blob with it, and stays.)
    for dark, stands_out in ((small.max(axis=2) < 70, lambda med: med > 110), (small.min(axis=2) > 240, lambda med: med < 150)):
        _eyemark_blocks(small, dark, band, stands_out, mm, cell, mask, marks)
    if not marks:
        return img, []
    return mask_out(img, mask, radius=max(4, round(2 * k))), marks


def _eyemark_blocks(small, dark, band, stands_out, mm: float, cell: int, mask, marks) -> None:
    """Mark-sized blocks of `dark` (the candidate colour) in the seal `band`, touching the panel edge and
    standing out from the 2 mm around them (`stands_out(ring median brightness)`); adds them to `mask`."""
    from collections import deque

    gh, gw = dark.shape
    seen = np.zeros_like(dark)
    for y, x in zip(*np.nonzero(dark & band)):
        if seen[y, x]:
            continue
        q, cells = deque([(y, x)]), []
        seen[y, x] = True
        while q and len(cells) <= 2500:  # (25 x 25 mm at most: anything larger is artwork)
            cy, cx = q.popleft()
            cells.append((cy, cx))
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < gh and 0 <= nx < gw and dark[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if q:
            continue  # larger than any eyemark: artwork (a dark background)
        cy, cx = zip(*cells)
        y0, y1, x0, x1 = min(cy), max(cy) + 1, min(cx), max(cx) + 1
        bw, bh = (x1 - x0) * mm, (y1 - y0) * mm
        edge = min(x0, y0, gw - x1, gh - y1) * mm <= 1.0
        inside = band[y0:y1, x0:x1].all()
        r = 4  # the 2 mm around it: a mark stands out from the seal colour (a dark design's own corner does not)
        ring = small.max(axis=2)[max(0, y0 - r):y1 + r, max(0, x0 - r):x1 + r].astype(float)
        ring[y0 - max(0, y0 - r):y0 - max(0, y0 - r) + (y1 - y0), x0 - max(0, x0 - r):x0 - max(0, x0 - r) + (x1 - x0)] = np.nan
        contrast = bool(stands_out(np.nanmedian(ring))) if np.isfinite(ring).any() else False
        if 3 <= bw <= 25 and 3 <= bh <= 25 and edge and inside and contrast and len(cells) >= 0.6 * (x1 - x0) * (y1 - y0):
            g = cell  # (a little wider: the block's anti-aliased rim and the dieline drawn over it)
            mask[max(0, y0 * g - g):(y1 + 1) * g, max(0, x0 * g - g):(x1 + 1) * g] = True
            # a white box printed around the mark (FGPO7029: black squares in white squares on a green
            # seal) goes with it, so the seal colour fills the whole corner, not a white square
            e, e2 = 8, 12  # 4 mm around the mark; the seal colour read 4-6 mm out
            by0, by1, bx0, bx1 = max(0, y0 - e), min(gh, y1 + e), max(0, x0 - e), min(gw, x1 + e)
            outer = small.min(axis=2)[max(0, y0 - e2):y1 + e2, max(0, x0 - e2):x1 + e2].astype(float)
            outer[by0 - max(0, y0 - e2):by1 - max(0, y0 - e2), bx0 - max(0, x0 - e2):bx1 - max(0, x0 - e2)] = np.nan
            if np.isfinite(outer).any() and np.nanmedian(outer) < 225:
                box = small[by0:by1, bx0:bx1].min(axis=2) >= 235
                for yy, xx in zip(*np.nonzero(box)):
                    cy0, cx0 = (by0 + yy) * g, (bx0 + xx) * g
                    mask[max(0, cy0 - g):cy0 + 2 * g, max(0, cx0 - g):cx0 + 2 * g] = True
            marks.append((round(bw, 1), round(bh, 1)))


def _unprinted_mask(img: Image.Image) -> Image.Image:
    """White where there is no ink (near paper white): a metallised film shows through there."""
    small = img.convert("RGB")
    small.thumbnail((MASK_MAX, MASK_MAX), Image.BOX)
    a = np.asarray(small).astype(np.int16)
    unprinted = (a.min(axis=2) > 235) & (a.max(axis=2) - a.min(axis=2) < 12)
    return Image.fromarray((unprinted * 255).astype(np.uint8), "L")


def _spot_mask(pdf: Path, trim: trim_impl.TrimArtworkOutput, bleed: Sides, profile, turn: int) -> Image.Image | None:
    """Where a spot varnish separation (Gloss UV / Matt UV) prints, from the PDF itself."""
    varnish = set(trim.inks.get("varnish") or profile.varnish_inks)
    icc = output_intent_profile(pdf)
    box = Box(*trim.trim_box_pt)
    layers = trim.layers_rendered if trim.mode == "layers" else None
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        write_layer_copy(pdf, t / "off.pdf", layers, box, suppress=varnish)
        changed = write_layer_copy(pdf, t / "on.pdf", layers, box, suppress=set(), transform=lambda w: emphasize_inks(w, varnish))
        if not changed:
            return None
        a = np.asarray(pdftoppm_png(t / "off.pdf", t / "a.png", 100, icc)).astype(np.int16)
        b = np.asarray(pdftoppm_png(t / "on.pdf", t / "b.png", 100, icc)).astype(np.int16)
    mask = Image.fromarray(((np.abs(a - b).max(axis=2) > 20) * 255).astype(np.uint8), "L")
    mask = trim_impl.cut_bleed(mask, trim.trim_width_mm, trim.trim_height_mm, bleed)
    if turn:
        mask = mask.rotate(turn, expand=True)
    if not np.asarray(mask).any():
        return None
    return mask
