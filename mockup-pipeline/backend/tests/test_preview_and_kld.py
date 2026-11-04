"""Two ways a sheet was read wrong (error reports #8 and #9, 2026-11-04).

FGPO7876: the only closed dieline grid was round the pink white-plate preview (the artwork copy's outline
is not in the technical ink), so both faces came out one flat pink. FGPO3719: the dieline is in a spot ink
named "KLD" (key line drawing), unread, so the whole sheet, spec table included, became the roll.
"""

import pytest

from app.pdf import sheet
from app.pdf.profile import PdfProfile
from app.pdf.sheet import artwork_page, single_page_copy
from app.services.sleeve import _variety
from tests.conftest import FIXTURES

PINK = FIXTURES / "FGPO7876_Weedplus_Pink_Preview_App.pdf"
KLD = FIXTURES / "FGPO3719_Thai_Green_Chips_Roll_KLD_App.pdf"


@pytest.mark.skipif(not PINK.exists(), reason="sample PDF not present")
def test_a_pink_preview_gives_way_to_the_printed_copy(tmp_path):
    one = tmp_path / "page.pdf"
    single_page_copy(PINK, one, artwork_page(PINK))
    sheet._SHEETS.clear()
    s = sheet.analyse(one, PdfProfile())
    assert round(s.trim.width_mm) == 476 and round(s.trim.height_mm) == 337  # front + back, as before
    assert _variety(one, s.trim) > 20  # the green artwork, not the six-colour pink preview
    assert any("separation preview" in w for w in s.warnings)


@pytest.mark.skipif(not KLD.exists(), reason="sample PDF not present")
def test_a_kld_ink_is_the_dieline():
    assert PdfProfile().classify_inks(["KLD", "CALLOUT", "PANTONE 349 C"]).technical == {"KLD"}
    sheet._SHEETS.clear()
    s = sheet.analyse(KLD, PdfProfile())
    assert s.mode == "separation"
    assert round(s.trim.width_mm) == 380 and round(s.trim.height_mm) == 254  # one roll repeat, no spec table
