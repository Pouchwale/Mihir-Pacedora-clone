"""Tunable values in one place."""
import re

ITEM_NO_RE = re.compile(r"(FGPO\d+)", re.IGNORECASE)

SPEC_DPI = 200
ARTWORK_DPI = 300

# Layers / spot inks that carry technical marks (dimension guides, zipper marking, eyemarks,
# V-notch marks, the spec table). Matched case-insensitively as substrings.
TECHNICAL_LAYER_HINTS = ("dimension", "dynamic mark", "footer", "mark", "keyline", "die")
TECHNICAL_INK_HINTS = ("dimension", "keyline", "die", "cut")

# Bleed the approval sheets are built with (mm per side). The TrimBox must equal the pouch size
# plus this bleed within TRIMBOX_TOLERANCE_MM, otherwise the specs go to the user for review.
EXPECTED_BLEED_MM = {"horizontal": 2.2375, "vertical": 4.0}
TRIMBOX_TOLERANCE_MM = 2.0

# Below this OCR confidence a field is never trusted silently.
MIN_FIELD_CONFIDENCE = 0.85

SANE_RANGES_MM = {
    "pouch_height_mm": (40, 1200),
    "pouch_closed_width_mm": (30, 1000),
    "pouch_open_width_mm": (30, 1000),
    "gusset_full_width_mm": (10, 400),
    "sealing_width_mm": (2, 40),
}
