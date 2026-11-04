"""A file with no dieline but a dimension layer: the area its arrows measure is the artwork, not the page.

FGPO0928 (layers Artwork / Dimensions / KLD, TrimBox = the whole page) was read as plain artwork, and
the spec table went onto the roll with the four sachet repeats.
"""

import pytest

from app.pdf import sheet
from app.pdf.profile import PdfProfile
from tests.conftest import FIXTURES

ROLL = FIXTURES / "FGPO0928_Classic_Masala_Chai_Roll_App.pdf"
SLEEVE = FIXTURES / "FGSL3423_Tropical_Rush_Sleeve_App.pdf"


@pytest.mark.skipif(not ROLL.exists(), reason="sample PDF not present")
def test_roll_without_dieline_is_cut_at_its_dimension_arrows():
    sheet._SHEETS.clear()
    s = sheet.analyse(ROLL, PdfProfile())
    assert s.mode == "separation"
    assert round(s.trim.width_mm) == 360 and round(s.trim.height_mm) == 90  # four 90 mm repeats, no table


@pytest.mark.skipif(not SLEEVE.exists(), reason="sample PDF not present")
def test_arrows_measuring_several_drawings_are_not_merged():
    # artwork + white plate + matt plate, each measured on its own: no one area, so no guess
    sheet._SHEETS.clear()
    s = sheet.analyse(SLEEVE, PdfProfile())
    assert s.mode == "page"
