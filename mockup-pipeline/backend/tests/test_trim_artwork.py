import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.errors import NeedsReview
from app.pdf import safety
from app.pdf.layers import read_facts
from app.pdf.profile import PdfProfile, TechnicalColourCheck
from app.steps import trim_artwork
from app.steps.trim_artwork import Sides, TrimArtworkInput, cut_bleed
from app.storage import LocalStorage
from tests.conftest import NON_ARTPRO, SAMPLE, needs_poppler

BLEED = Sides(left=2.2375, right=2.2375, top=4, bottom=4)


def _run(tmp_path, profile=None, panel="front"):
    storage = LocalStorage(tmp_path)
    inp = TrimArtworkInput(pdf_path=SAMPLE, filename=SAMPLE.name, panel=panel, key_prefix="job")
    return trim_artwork.run(inp, profile or PdfProfile(), storage), storage


def test_sample_facts():
    facts = read_facts(SAMPLE)
    assert facts.creator.startswith("ArtPro+") and facts.producer == "Enfocus PDF"
    assert facts.layers == ["Artwork", "Dimensions and text", "Footer1", "Dynamic Marks"]
    assert facts.trim_box.width_mm == pytest.approx(244.475, abs=0.001)
    assert facts.trim_box.height_mm == pytest.approx(320.0, abs=0.001)


def test_non_artpro_pdf_held_to_layer_rules_when_forced(tmp_path):
    inp = TrimArtworkInput(pdf_path=NON_ARTPRO, filename=NON_ARTPRO.name, panel="front", key_prefix="x")
    with pytest.raises(NeedsReview) as exc:
        trim_artwork.run(inp, PdfProfile(layout_mode="layers"), LocalStorage(tmp_path))
    codes = {p["code"] for p in exc.value.details["problems"]}
    assert codes == {"trimbox_is_mediabox", "unexpected_producer", "layer_missing"}


@needs_poppler
def test_file_without_layers_uses_the_dieline(tmp_path):
    """Illustrator export: no layers, TrimBox = page; the artwork area is the dieline's outer rectangle."""
    storage = LocalStorage(tmp_path)
    inp = TrimArtworkInput(pdf_path=NON_ARTPRO, filename=NON_ARTPRO.name, panel="front", key_prefix="x")
    out = trim_artwork.run(inp, PdfProfile(), storage)
    assert out.mode == "separation" and out.layers == [] and out.bleed_key == "x/FGPO6862_sheet_bleed.png"
    assert (out.trim_width_mm, out.trim_height_mm) == pytest.approx((165.1, 248.0), abs=0.01)  # 2.55 + 160 + 2.55, 4 + 240 + 4
    assert any("Dimensions and text" in c for c in out.suppressed_colour_spaces)
    image = np.asarray(Image.open(storage.path(out.bleed_key)).convert("RGB")).astype(int)
    blue = (image[..., 2] > 180) & (image[..., 0] < 80) & (image[..., 1] < 80)
    assert blue.sum() < 50  # the dieline painted over the artwork is gone, not whitened or kept
    fin = trim_artwork.finish(out, NON_ARTPRO, Sides(left=2.55, right=2.55, top=4, bottom=4), 160, 240, "x", PdfProfile(), storage)
    assert fin.finished_mm == pytest.approx((160, 240), abs=0.05) and fin.issues == []


def test_cover_page_is_skipped(tmp_path):
    """A printer's 'STOP! read carefully' cover page in front of the sheet: the artwork page is used."""
    from pypdf import PdfWriter

    from app.pdf.sheet import artwork_page, single_page_copy

    w = PdfWriter(clone_from=SAMPLE)
    w.insert_blank_page(842, 595, 0)  # the cover in front of the sheet
    two = tmp_path / "two.pdf"
    with two.open("wb") as fh:
        w.write(fh)
    assert artwork_page(two) == 1
    one = single_page_copy(two, tmp_path / "one.pdf", 1)
    facts = read_facts(one)
    assert facts.page_count == 1 and facts.layers == ["Artwork", "Dimensions and text", "Footer1", "Dynamic Marks"]
    assert facts.trim_box.width_mm == pytest.approx(244.475, abs=0.001)


@needs_poppler
def test_renamed_artwork_layer_is_taken_from_the_other_layers(tmp_path):
    """An export whose artwork layer is not called 'Artwork' (Illustrator: 'Layer 1'): the layers that
    are not spec / dimension / eyemark layers carry the artwork; the difference is a warning, not a stop."""
    out, _ = _run(tmp_path, PdfProfile(artwork_layers=["Artwork v2"]))
    assert out.mode == "layers" and out.layers_rendered == ["Artwork"]
    assert any("artwork taken from Artwork" in w for w in out.warnings)
    # forcing the layered rules keeps them strict
    with pytest.raises(NeedsReview) as exc:
        _run(tmp_path, PdfProfile(artwork_layers=["Artwork v2"], layout_mode="layers"))
    assert exc.value.code == "layer_missing"


def test_layered_file_without_the_dimension_layer_is_read_as_a_flat_file():
    from app.pdf.layers import read_facts
    from app.pdf.sheet import mode_for

    facts = read_facts(SAMPLE)
    assert mode_for(facts, PdfProfile()) == "layers"
    assert mode_for(facts, PdfProfile(dimension_layers=["Keyline"])) == "separation"  # a designer's own layers


def test_texture_layers_with_eyemarks():
    assert PdfProfile().texture_layers() == ["Artwork"]
    assert PdfProfile(include_eyemarks=True).texture_layers() == ["Artwork", *PdfProfile().eyemark_layers]


def test_cut_bleed_per_side():
    # 244.475 x 320 mm at ~10 px/mm; bleed 2.2375 L/R and 4 T/B leaves 240 x 312 mm.
    out = cut_bleed(Image.new("RGB", (2445, 3200)), 244.475, 320, BLEED)
    assert out.size == (2400, 3120)


def test_cut_bleed_rejects_impossible_bleed():
    with pytest.raises(NeedsReview):
        cut_bleed(Image.new("RGB", (100, 100)), 10, 10, Sides.uniform(6))


def test_colour_mask_finds_keyline_blue_not_navy():
    image = Image.new("RGB", (200, 200), (41, 35, 80))  # the sample's navy background
    ImageDraw.Draw(image).line((10, 100, 190, 100), fill=(40, 65, 147), width=3)
    mask = safety.colour_mask(image, (40, 65, 147), 6.0)
    assert 400 <= mask.sum() <= 700
    assert not mask[50].any()


def test_mask_out_removes_mark():
    image = Image.new("RGB", (100, 100), (200, 30, 30))
    ImageDraw.Draw(image).line((0, 50, 99, 50), fill=(40, 65, 147), width=2)
    mask = np.asarray(safety.colour_mask(image, (40, 65, 147), 6.0))
    cleaned = np.asarray(safety.mask_out(image, mask)).astype(int)
    assert np.abs(cleaned[50, 50] - (200, 30, 30)).max() < 10


def test_technical_colour_auto_uses_output_intent():
    r, g, b = safety.technical_rgb(SAMPLE, ["Dimensions and text"], TechnicalColourCheck())
    assert b > 120 and r < 80  # a blue, converted through FOGRA39
    assert safety.technical_rgb(SAMPLE, ["x"], TechnicalColourCheck(colour="#102030")) == (16, 32, 48)


@needs_poppler
def test_render_sample(tmp_path):
    out, storage = _run(tmp_path)
    assert out.item_code == "FGPO7215"
    assert out.bleed_key == "job/FGPO7215_front_bleed.png"
    assert out.colour_profile == "output_intent"
    assert out.bleed_px == (2888, 3780)  # 300 dpi over 244.475 x 320 mm
    image = np.asarray(Image.open(storage.path(out.bleed_key)))
    r, g, b = image[1800, 150]
    assert b > r and b > g and max(r, g, b) < 110  # the design's navy, not paper or keylines
    again, _ = _run(tmp_path)  # idempotent
    assert np.array_equal(image, np.asarray(Image.open(storage.path(again.bleed_key))))


@needs_poppler
def test_cutting_panels_from_a_layered_sheet_leaves_the_sheet_render_alone(tmp_path):
    """FGPO5149: a layered file whose TrimBox holds a front + back web. The sheet render is named
    <item>_front_bleed.png; cutting the front out under that name made the back (and any rerun) cut
    from the cut-out: half the height, 'Finished artwork is 180.97 x 120.59 mm, expected 245'."""
    from app.pdf.layers import Box

    out, storage = _run(tmp_path)
    t = Box(*out.trim_box_pt)
    mid = (t.y0 + t.y1) / 2
    top, bottom = Box(t.x0, mid, t.x1, t.y1), Box(t.x0, t.y0, t.x1, mid)
    sheet_before = storage.get_bytes(out.bleed_key)
    for _ in range(2):  # a rerun of link_panels cuts again
        front = trim_artwork.crop_panel(out, "front", top, storage)
        back = trim_artwork.crop_panel(out, "back", bottom, storage)
        assert front.bleed_key != out.bleed_key and back.bleed_key != out.bleed_key
        assert front.trim_height_mm == pytest.approx(160, abs=0.01) and back.trim_height_mm == pytest.approx(160, abs=0.01)
        assert front.bleed_px[1] == pytest.approx(out.bleed_px[1] / 2, abs=1) and back.bleed_px[1] == pytest.approx(out.bleed_px[1] / 2, abs=1)
    assert storage.get_bytes(out.bleed_key) == sheet_before
    # a render that does not match its box is refused, not cut to a wrong size
    with pytest.raises(RuntimeError, match="rerun the job from trim_artwork"):
        trim_artwork.crop_panel(front.model_copy(update={"trim_box_pt": out.trim_box_pt}), "back", bottom, storage)


@needs_poppler
def test_finish_sample(tmp_path):
    out, storage = _run(tmp_path)
    fin = trim_artwork.finish(out, SAMPLE, BLEED, 240, 312, "job", PdfProfile(), storage)
    assert fin.finished_key == "job/FGPO7215_front_finished.png"
    assert fin.finished_px == (2835, 3686)
    assert fin.finished_mm == pytest.approx((240, 312), abs=0.05)
    assert fin.issues == [] and fin.technical_pixels == {"colour": 0, "separation": 0}


@needs_poppler
def test_keyline_coloured_artwork_without_technical_ink_is_kept(tmp_path):
    """FGSL4074: the keyline's look-alike blue is all over the design (drips, badge figures, ruled boxes).
    With no technical ink on the rendered layers, none of it is a keyline: nothing is masked."""
    out, storage = _run(tmp_path)
    plain = trim_artwork.finish(out, SAMPLE, BLEED, 240, 312, "job", PdfProfile(), storage)
    a = np.asarray(Image.open(storage.path(plain.finished_key)).convert("RGB")).reshape(-1, 3)
    colours, counts = np.unique(a[(a.max(axis=1) - a.min(axis=1)) > 40], axis=0, return_counts=True)
    r, g, b = colours[counts.argmax()]  # the design's commonest strong colour as "the keyline colour"
    profile = PdfProfile()
    profile.technical_colour.colour = f"#{r:02x}{g:02x}{b:02x}"
    fin = trim_artwork.finish(out, SAMPLE, BLEED, 240, 312, "job2", profile, storage)
    assert fin.technical_pixels == {"colour": 0, "separation": 0} and "technical_marks" not in [i.code for i in fin.issues]


@needs_poppler
def test_finish_wrong_size_needs_review(tmp_path):
    out, storage = _run(tmp_path)
    with pytest.raises(NeedsReview) as exc:
        trim_artwork.finish(out, SAMPLE, Sides.uniform(4), 240, 312, "job", PdfProfile(), storage)
    assert exc.value.code == "finished_size"  # uniform 4 mm gives 236.475 mm wide


@needs_poppler
def test_marks_on_texture_layer_are_masked_and_flagged(tmp_path):
    """Treat the dimension layer as artwork: its keylines are stripped from the PDF before rendering (not
    blurred over afterwards, which smeared the print they crossed: FGSL4089), so none reach the texture."""
    profile = PdfProfile(artwork_layers=["Artwork", "Dimensions and text"])
    out, storage = _run(tmp_path, profile)
    assert any(c.startswith("strip:") for c in out.suppressed_colour_spaces)
    fin = trim_artwork.finish(out, SAMPLE, BLEED, 240, 312, "job", profile, storage)
    assert fin.issues == [] and fin.technical_pixels["separation"] == 0  # nothing left to mask or blur
    finished = np.asarray(Image.open(storage.path(fin.finished_key)))
    assert safety.colour_mask(Image.fromarray(finished), fin.technical_rgb, 6.0).sum() < 200


@needs_poppler
def test_sp_white_suppressed(tmp_path):
    """The Sp White swatch on the spec table turns from preview grey to white when suppressed."""
    from app.pdf.layers import output_intent_profile, write_layer_copy
    from app.pdf.render import pdftoppm_png

    facts = read_facts(SAMPLE)
    icc = output_intent_profile(SAMPLE)
    write_layer_copy(SAMPLE, tmp_path / "a.pdf", ["Dynamic Marks"], facts.media_box)
    changed = write_layer_copy(SAMPLE, tmp_path / "b.pdf", ["Dynamic Marks"], facts.media_box, {"Sp White"})
    assert any("Sp White" in c for c in changed)
    a = np.asarray(pdftoppm_png(tmp_path / "a.pdf", tmp_path / "a.png", 30, icc)).astype(int)
    b = np.asarray(pdftoppm_png(tmp_path / "b.pdf", tmp_path / "b.png", 30, icc)).astype(int)
    diff = np.abs(a - b).max(axis=2) > 8
    assert diff.sum() > 100
    assert (b[diff] >= 250).all()


def test_eyemark_in_the_seal_is_removed_but_dark_artwork_stays():
    """A solid black block in a seal corner is the print eyemark; a dark area reaching into the seal is artwork."""
    from app.workflow.steps.texture import drop_eyemarks

    k = 10  # px per mm: a 100 x 150 mm face with 10 mm seals
    a = np.full((1500, 1000, 3), (112, 163, 43), np.uint8)
    a[1400:1500, 0:100] = 0  # 10 x 10 mm black block in the bottom-left seal corner
    a[1300:1500, 600:800] = 20  # a dark photo touching the bottom edge, 20 mm tall: beyond the seal
    out, marks = drop_eyemarks(Image.fromarray(a), 100, 10, 10, 10)
    b = np.asarray(out)
    assert len(marks) == 1 and 9 <= marks[0][0] <= 11
    assert b[1450, 50].min() > 40  # filled with the seal colour
    assert b[1450, 700].max() < 40  # the photo is untouched


def test_eyemark_in_a_white_box_leaves_no_white_square():
    """FGPO7029: a black square inside a white square in the green bottom seal; the whole corner turns green."""
    import numpy as np
    from PIL import Image, ImageDraw

    from app.workflow.steps.texture import drop_eyemarks

    k = 10  # px per mm
    img = Image.new("RGB", (160 * k, 120 * k), (240, 240, 240))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 80 * k, 160 * k, 120 * k), fill=(20, 80, 30))  # green base and bottom seal
    d.rectangle((0, 108 * k, 12 * k, 120 * k), fill=(255, 255, 255))  # the white box in the corner...
    d.rectangle((0, 110 * k, 10 * k, 120 * k), fill=(0, 0, 0))  # ...holding the black eyemark
    out, marks = drop_eyemarks(img, 160, 10, 10, 10)
    assert marks
    corner = np.asarray(out)[109 * k:120 * k, 0:12 * k].astype(int)
    assert corner.min(axis=2).max() < 200  # no white left in the corner


def test_window_left_unprinted_in_a_gusset():
    """FGPO7032: logo at the top, colour at the bottom, the middle left unprinted for the "Window"."""
    import numpy as np
    from PIL import Image, ImageDraw

    from app.workflow.steps.texture import WINDOW_ALPHA, window_rect

    k = 5
    img = Image.new("RGB", (90 * k, 320 * k), (220, 240, 225))
    ImageDraw.Draw(img).rectangle((5 * k, 70 * k, 85 * k, 290 * k), fill=(255, 255, 255))
    mask = np.asarray(window_rect(img, 90))
    assert mask[150 * k, 45 * k] == WINDOW_ALPHA and mask[30 * k, 45 * k] == 255 and mask[300 * k, 45 * k] == 255
    assert window_rect(Image.new("RGB", (90 * k, 320 * k), (220, 240, 225)), 90) is None  # nothing unprinted


def test_white_eyemark_block_on_a_dark_seal():
    """FGPO7029's back: plain white squares in the green bottom corners (no black mark in them)."""
    import numpy as np
    from PIL import Image, ImageDraw

    from app.workflow.steps.texture import drop_eyemarks

    k = 10
    img = Image.new("RGB", (160 * k, 120 * k), (240, 240, 240))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 80 * k, 160 * k, 120 * k), fill=(20, 80, 30))
    d.rectangle((150 * k, 110 * k, 160 * k, 120 * k), fill=(255, 255, 255))  # bottom-right corner
    out, marks = drop_eyemarks(img, 160, 10, 10, 10)
    assert marks
    assert np.asarray(out)[111 * k:120 * k, 151 * k:160 * k].astype(int).min(axis=2).max() < 200


def test_window_drawn_in_the_artwork_becomes_clear_film(tmp_path):
    """FGPO6813: a white leaf on the green front labelled "Transparent Window" is a window of that shape;
    the label goes. A spec table field "Transparent Window:" (with its colon) is no label."""
    import pymupdf

    from app.workflow.steps.texture import WINDOW_ALPHA, window_marked

    w_mm, h_mm = 100.0, 150.0
    pt = 72 / 25.4
    doc = pymupdf.open()
    page = doc.new_page(width=w_mm * pt, height=h_mm * pt)
    page.draw_rect(page.rect, fill=(0.4, 0.7, 0.2), color=None)
    page.draw_circle(pymupdf.Point(50 * pt, 100 * pt), 25 * pt, fill=(1, 1, 1), color=None)  # the unprinted shape
    page.insert_text(pymupdf.Point(38 * pt, 98 * pt), "Transparent", fontsize=8)
    page.insert_text(pymupdf.Point(42 * pt, 102 * pt), "Window", fontsize=8)
    page.insert_text(pymupdf.Point(5 * pt, 10 * pt), "Transparent Window:", fontsize=8)  # a field, not a label
    pdf = tmp_path / "leaf.pdf"
    doc.save(pdf)
    pix = doc[0].get_pixmap(dpi=100)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

    cleaned, mask = window_marked(img, pdf, (0, 0, w_mm * pt, h_mm * pt), w_mm)
    assert mask is not None and mask.size == img.size
    k = img.width / w_mm
    m = np.asarray(mask)
    assert m[int(100 * k), int(50 * k)] == WINDOW_ALPHA and m[int(120 * k), int(50 * k)] == WINDOW_ALPHA  # the circle
    assert m[int(40 * k), int(50 * k)] == 255 and m[int(10 * k), int(10 * k)] == 255  # the print and the field
    label = np.asarray(cleaned)[int(96 * k):int(103 * k), int(40 * k):int(60 * k)]
    assert label.min() >= 235  # "Transparent Window" painted out
    # no label at all: nothing changes
    page2 = pymupdf.open()
    page2.new_page(width=w_mm * pt, height=h_mm * pt).draw_circle(pymupdf.Point(50 * pt, 100 * pt), 25 * pt, fill=(1, 1, 1))
    plain = tmp_path / "plain.pdf"
    page2.save(plain)
    assert window_marked(img, plain, (0, 0, w_mm * pt, h_mm * pt), w_mm)[1] is None


def test_dieline_drawn_in_the_artwork_is_removed():
    """FGPO6813 (no technical ink): hairline cut / seal lines across the face, the back's fin line down
    it and the V-notch pointer on the top line go; a thick stripe of the design stays."""
    from app.workflow.steps.texture import drop_drawn_rules

    k = 10  # px per mm
    img = Image.new("RGB", (100 * k, 150 * k), (150, 200, 60))
    d = ImageDraw.Draw(img)
    for y in (2, 12, 138, 148):  # cut edge and seal lines, 0.3 mm
        d.rectangle([0, y * k, 100 * k, y * k + 2], fill=(20, 20, 20))
    d.rectangle([50 * k, 0, 50 * k + 2, 150 * k], fill=(20, 20, 20))  # fin line
    d.polygon([(30 * k, 2 * k), (31 * k, 2 * k), (30.5 * k, 4 * k)], fill=(20, 20, 20))  # pointer on the top line
    d.rectangle([0, 60 * k, 100 * k, 63 * k], fill=(10, 10, 10))  # a 3 mm stripe in the design
    out, n = drop_drawn_rules(img, 100, 10, 10)
    a = np.asarray(out).max(axis=2)
    assert n == 5
    for y in (2, 12, 138, 148):
        assert a[y * k + 1, 20 * k] > 120, y
    assert a[100 * k, 50 * k + 1] > 120 and a[int(3 * k), int(30.5 * k)] > 120  # fin line, pointer
    assert a[61 * k, 20 * k] < 40  # the stripe stays
    assert drop_drawn_rules(Image.new("RGB", (500, 700), (150, 200, 60)), 50, 10, 10)[1] == 0
    # a dark design (FGSL4047): the thin dark strips between lines of light text are not rules
    dark = Image.new("RGB", (100 * k, 150 * k), (25, 30, 40))
    d = ImageDraw.Draw(dark)
    for y in range(5, 145, 3):  # 2.7 mm text lines with 0.3 mm dark gaps
        d.rectangle([5 * k, y * k, 45 * k, y * k + 26], fill=(240, 240, 240))  # (text leaves most of a line dark)
    assert drop_drawn_rules(dark, 100, 75, 75)[1] == 0


def test_knocked_out_line_is_bridged_sharp():
    """A fold line knocked out of the print (FGSL4089) is filled straight across: a stroke it cut through
    carries on at full strength (a blur left it grey and smeared), the colour round it is untouched."""
    img = Image.new("RGB", (200, 100), (240, 140, 80))
    d = ImageDraw.Draw(img)
    d.rectangle([20, 40, 180, 46], fill=(20, 20, 20))  # a text stroke / table rule crossing the line
    d.rectangle([99, 0, 101, 99], fill="white")  # the knocked-out fold line
    mask = np.zeros((100, 200), bool)
    mask[:, 99:102] = True
    a = np.asarray(safety.bridge(img, mask)).astype(int)
    assert a[43, 100].max() < 40 and abs(a[10, 100] - [240, 140, 80]).sum() < 6 and (a[:, 50] == np.asarray(img)[:, 50]).all()


def test_sleeve_unprinted_edge_bands_are_clear():
    """FGSL3991: a black print inset 1.4 mm in the cut size, a fold tick in the bottom band; white inside
    the design (text) is ink, not film."""
    from app.workflow.steps.texture import WINDOW_ALPHA, sleeve_clear_edges

    img = Image.new("RGB", (1000, 600), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 15, 999, 584], fill=(20, 20, 20))  # the print; 15 px bands above and below
    d.rectangle([400, 590, 402, 599], fill=(0, 0, 0))  # a fold tick in the bottom band
    d.rectangle([300, 200, 700, 260], fill="white")  # white text in the design
    d.line([0, 0, 999, 0], fill=(30, 30, 30))  # a cut-edge hairline along the very top
    a = np.asarray(sleeve_clear_edges(img))
    assert a[5, 500] == a[595, 401] == WINDOW_ALPHA and a[30, 500] == a[230, 500] == 255
    assert sleeve_clear_edges(Image.new("RGB", (100, 60), (20, 20, 20))) is None
