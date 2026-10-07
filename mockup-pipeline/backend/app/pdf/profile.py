"""PDF profile (index section 3.4): what an ArtPro+ approval PDF is expected to look like.

The defaults describe the current Gujarat Print Pack template. In production the active profile
is loaded from the index so admins can follow template changes without a deploy.
"""

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.ocr.template import SpecTemplate


class TechnicalColourCheck(BaseModel):
    """Safety scan of the finished texture for the keyline colour (spec 2.1 e)."""

    # sRGB hex of the technical (keyline) colour; "auto" converts the technical ink's CMYK
    # alternate through the PDF's own OutputIntent profile.
    colour: str = "auto"
    fallback_colour: str = "#2a4b97"
    max_delta_e: float = 6.0  # CIE76 distance counted as "the keyline colour"
    min_pixels: int = 40  # fewer matching pixels than this is anti-aliasing noise, not a mark


class InkClasses(BaseModel):
    white: set[str] = set()
    varnish: dict[str, str] = {}  # colorant -> gloss / matt
    technical: set[str] = set()

    def hidden(self) -> set[str]:
        """Everything that is not visible colour."""
        return {*self.white, *self.varnish, *self.technical}


class PanelRule(BaseModel):
    """Panels & artwork rules for one panel role (index, PDF profile): how its PDF is named in the
    Remarks, and how its artwork is placed on the 3D panel."""

    remark_labels: list[str] = Field([], description="words before 'Code :' that name this panel, e.g. ['back', 'rear']")
    bleed_mm: float | None = Field(None, ge=0, le=30, description="fixed bleed for linked PDFs of this role; empty = measured / TrimBox")
    rotation: int = Field(0, description="extra turn of the artwork in degrees (0, 90, 180, 270)")
    mirror: bool = Field(False, description="mirror the artwork left-right (a panel printed from the inside)")

    @field_validator("rotation")
    @classmethod
    def _quarter(cls, v: int) -> int:
        if v % 90:
            raise ValueError("rotation must be 0, 90, 180 or 270")
        return v % 360


class PdfProfile(BaseModel):
    # How artwork and technical drawing are told apart (app.pdf.sheet):
    #   layers     - ArtPro+ exports: separate layers, TrimBox = artwork + bleed (strict checks below)
    #   separation - files without layers (Adobe Illustrator): one page, dieline and dimension labels
    #                painted in a technical ink; the artwork area is the dieline's outer rectangle
    #   auto       - layers when the file has layers, otherwise separation
    layout_mode: Literal["auto", "layers", "separation"] = "auto"
    # How the spec table and dimension labels are read. The PDF's own text layer (PyMuPDF: words and
    # table cells) is exact and always tried first; OCR (Tesseract) reads outlined text and scans.
    #   auto   - text layer, OCR only where the text layer gives nothing (no words, or a weak cell)
    #   off    - never OCR: a file without a text layer pauses for the pouch details
    #   always - OCR even when the text layer is usable (diagnostics, a broken text layer)
    ocr: Literal["auto", "off", "always"] = "auto"
    # A sheet can carry several panels (e.g. front + bottom gusset + back of a stand-up pouch on one
    # web). Panels are found on the dieline by the spec table's sizes; unprinted strips or seal
    # bands between them (about 13 mm between the front and back of an F+B web) up to this width
    # are allowed.
    sheet_panel_gap_max_mm: float = Field(30.0, ge=0, le=50)  # FGPO7492: 13.5 mm seal band; FGPO7165: 28 mm fold band
    # Which of two front/back-sized panels on one sheet is the front: "auto" picks the one with less
    # small print (backs carry nutrition tables, addresses, barcodes); "first"/"last" in sheet order.
    sheet_front: Literal["auto", "first", "last"] = "auto"
    # auto: the other panel must carry at least this many times the words, else sheet order decides.
    sheet_front_text_ratio: float = Field(1.5, ge=1)
    artwork_layers: list[str] = ["Artwork"]
    # Printed-look option (admin, per client): also render eyemarks and other print marks.
    # (other exports name the eye / sensor mark layer themselves: FGPO5452 "sensor mark", FGPO7445 "Eyemark")
    eyemark_layers: list[str] = ["Dynamic Marks", "sensor mark", "Sensor Mark", "Eyemark", "Eye Mark"]
    include_eyemarks: bool = False
    # Verified on FGPO7215: the spec table grid and most values are on "Dynamic Marks"; item name,
    # approval date, in-side B2B width, colour count and the Remarks text are on "Footer1".
    # Spec OCR renders every layer except the artwork layers.
    spec_layers: list[str] = ["Dynamic Marks", "Footer1"]
    # Dieline and dimension labels around the artwork.
    dimension_layers: list[str] = ["Dimensions and text"]
    # Designer annotation layers that are never artwork (FGPO4002's "KLD" holds the red "Metalic
    # Effect" callout lines drawn across the front).
    ignore_layers: list[str] = ["KLD"]
    # Thin paint in C0 M100 Y100 (K 0-70) is the studio's annotation colour (callout lines, "Coffee Valve"
    # labels), not print: it is removed from the artwork. Switch off for a client whose design uses it.
    strip_annotation_red: bool = True
    # Margin around the TrimBox to include when rendering dimension labels, in mm. The spec table
    # region is everything left of (TrimBox left edge - this margin).
    dimension_margin_mm: float = 30.0
    technical_colour: TechnicalColourCheck = TechnicalColourCheck()
    # A gusset / side / bottom panel with no artwork anywhere (no PDF linked or uploaded, nothing on the
    # sheet) is unprinted film in the front's colour instead of a question to the operator (FGPO7002).
    plain_missing_gussets: bool = True
    # A measured dieline segment this close to a printed dimension label is that label's value and
    # counts as confirmed (FGPO6292: lines read from raster tiles measure 10.08 for a printed "10").
    label_tolerance_mm: float = Field(0.15, ge=0.01, le=1.0)
    # Finished texture must equal the pouch size within this tolerance (spec 2.1 c).
    finished_size_tolerance_mm: float = 0.5

    # Separations that are not visible colour. They are hidden in the colour texture and
    # rendered separately as masks for the material system (white underlay, spot varnish).
    # Also what the ink row calls a white plate: a job printing white has no bare metallised film showing.
    white_inks: list[str] = ["Sp White", "White"]
    varnish_inks: dict[str, str] = {"Gloss UV": "gloss", "Matt UV": "matt"}
    technical_inks: list[str] = ["Dimensions and text"]
    # Files name their plates freely ("White-1", "Opaque White", "Spot Gloss UV", "Dieline"): a
    # colorant whose name matches one of these regexes (case-insensitive) is classed the same way.
    # (plates are named "White_", "White-_", "white.", "Uv White.", "W-": \b would miss "White_")
    white_ink_patterns: list[str] = [r"white", r"\bopaque\b", r"^w[\W_]*$"]
    varnish_ink_patterns: dict[str, str] = {r"gloss": "gloss", r"\bmatt?e?\b.*\b(uv|varnish)\b|\b(uv|varnish)\b.*\bmatt?e?\b": "matt", r"\buv\b|varnish": "gloss"}
    technical_ink_patterns: list[str] = [r"dimension", r"die\s*line", r"key\s*line", r"\bcutter\b", r"\btechnical\b"]
    # A PDF with no dieline and no spec table (plain artwork): pause for the pouch details instead of
    # rejecting it; the whole page is the front artwork.
    page_fallback: bool = True

    # "<Label> Code : FGPO1234" in Remarks. Label (case-insensitive) -> panel role.
    panel_code_labels: dict[str, str] = {
        "front": "front",
        "back": "back",
        "gusset": "gusset",
        "bottom": "bottom",
        "top": "top",
        "side": "side",
        "left side": "side_left",
        "side left": "side_left",
        "right side": "side_right",
        "side right": "side_right",
    }
    # Panels & artwork rules per role: more Remarks labels, fixed bleed, rotation, mirror.
    panel_rules: dict[str, PanelRule] = {}
    # A code whose label contains one of these words refers to another job (e.g. "Color match as per
    # old code : FGPO3728"); it is kept as a reference and is not a panel of this pouch.
    reference_code_words: list[str] = ["old", "reference", "ref", "previous", "same as", "as per", "similar", "match"]
    item_code_pattern: str = r"FGPO\d+"
    filename_code_pattern: str = r"^(FGPO\d+)"
    expected_producer: str = "Enfocus PDF"
    expected_creator_prefix: str = "ArtPro+"

    texture_dpi: int = Field(300, ge=72, le=1200)
    spec_dpi: int = Field(300, ge=150, le=600)
    spec_template: SpecTemplate = Field(default_factory=SpecTemplate)

    def non_visible_inks(self) -> list[str]:
        return [*self.white_inks, *self.varnish_inks, *self.technical_inks]

    def classify_inks(self, names) -> "InkClasses":
        """Sort the colorant names a file actually uses into white / varnish / technical."""
        white, varnish, technical = set(), {}, set()
        for name in names:
            low = name.lower()
            if name in self.technical_inks or any(re.search(p, low) for p in self.technical_ink_patterns):
                technical.add(name)
            elif name in self.varnish_inks:
                varnish[name] = self.varnish_inks[name]
            elif name in self.white_inks or any(re.search(p, low) for p in self.white_ink_patterns):
                white.add(name)
            else:
                for pattern, kind in self.varnish_ink_patterns.items():
                    if re.search(pattern, low):
                        varnish[name] = kind
                        break
        return InkClasses(white=white, varnish=varnish, technical=technical)

    def texture_layers(self) -> list[str]:
        return [*self.artwork_layers, *(self.eyemark_layers if self.include_eyemarks else [])]

    def item_code_from_filename(self, filename: str) -> str | None:
        m = re.search(self.filename_code_pattern, filename, re.IGNORECASE)
        return m.group(1).upper() if m else None

    def code_labels(self) -> dict[str, str]:
        """Remarks label -> panel role, the built-in table plus the panel rules' labels."""
        out = dict(self.panel_code_labels)
        for role, rule in self.panel_rules.items():
            for label in rule.remark_labels:
                out.setdefault(" ".join(label.lower().split()), role)
        return out

    def panel_rule(self, role: str) -> PanelRule:
        return self.panel_rules.get(role) or PanelRule()

    def _code_pairs(self, remarks: str) -> list[tuple[list[str], str]]:
        # The ":" is optional: OCR often drops punctuation-only words.
        # "Gusset Code : FGPO7429", and "Gusset Use FGPO4357" (FGPO6828), "Back Use Code FGPO..."
        pattern = rf"([A-Za-z][A-Za-z ]*?)\s*(?:Use\s+Code|Code\s+Use|Code|Use)\s*[:\-]?\s*({self.item_code_pattern})"
        pairs = []
        for label, code in re.findall(pattern, remarks, re.IGNORECASE):
            # Remarks are joined with separators like "Matt Finish Pouch | Back Code"; keep the last words.
            label = re.split(r"[|/,;]", label)[-1].strip().lower()
            pairs.append((label.split(), code.upper()))
        return pairs

    def _is_reference(self, words: list[str]) -> bool:
        text = f" {' '.join(words)} "
        return any(f" {w} " in text for w in self.reference_code_words)

    def parse_linked_codes(self, remarks: str) -> dict[str, str]:
        """Every '<Panel> Code : FGPOxxxx' pair in the remarks, keyed by panel role.

        Unknown labels are kept (slugified) so a new panel name is reported instead of dropped.
        References to other jobs ("... as per old code : FGPO3728") are not panels (see
        parse_reference_codes).
        """
        found: dict[str, str] = {}
        labels = self.code_labels()
        for words, code in self._code_pairs(remarks):
            role = None
            for n in range(len(words), 0, -1):
                role = labels.get(" ".join(words[-n:]))
                if role:
                    break
            if role is None and self._is_reference(words):
                continue
            found[role or "_".join(words[-2:])] = code
        return found

    def parse_reference_codes(self, remarks: str) -> dict[str, str]:
        """Codes of other jobs mentioned in the remarks: label text -> code."""
        out: dict[str, str] = {}
        labels = self.code_labels()
        for words, code in self._code_pairs(remarks):
            if not any(labels.get(" ".join(words[-n:])) for n in range(len(words), 0, -1)) and self._is_reference(words):
                out[" ".join(words)] = code
        return out
