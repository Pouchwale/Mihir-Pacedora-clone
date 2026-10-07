import pytest

from app.pdf.profile import PdfProfile


@pytest.mark.parametrize(
    "remarks, expected",
    [
        ("Matt Finish Pouch I Back Code : FGPO7216 | Gusset Code : FGPO7233", {"back": "FGPO7216", "gusset": "FGPO7233"}),
        ("Matt Finish Pouch | Back Code : FGPO7216 Gusset Code : FGPO7233", {"back": "FGPO7216", "gusset": "FGPO7233"}),
        ("Back Code: fgpo1 | Side Code - FGPO2 | Bottom Code : FGPO3", {"back": "FGPO1", "side": "FGPO2", "bottom": "FGPO3"}),
        ("Left Side Code : FGPO10 / Right Side Code : FGPO11", {"side_left": "FGPO10", "side_right": "FGPO11"}),
        ("Top Code : FGPO5", {"top": "FGPO5"}),
        ("Handle Code : FGPO9", {"handle": "FGPO9"}),  # unknown label kept, not dropped
        ("Gloss finish", {}),
    ],
)
def test_parse_linked_codes(remarks, expected):
    assert PdfProfile().parse_linked_codes(remarks) == expected


def test_labels_are_configurable():
    profile = PdfProfile(panel_code_labels={"rueckseite": "back"})
    assert profile.parse_linked_codes("Rueckseite Code : FGPO42") == {"back": "FGPO42"}


def test_item_code_from_filename():
    p = PdfProfile()
    assert p.item_code_from_filename("FGPO7215_Dog_Food_Front_App (exported).pdf") == "FGPO7215"
    assert p.item_code_from_filename("fgpo6862-Korean.pdf") == "FGPO6862"
    assert p.item_code_from_filename("Dog_Food.pdf") is None


def test_linked_code_written_with_use():
    """FGPO6828: "Color match as per old code FGPO4356 Gusset Use FGPO4357" links the gusset, not the old code."""
    from app.pdf.profile import PdfProfile

    p = PdfProfile()
    assert p.parse_linked_codes("Color match as per old code FGPO4356 Gusset Use FGPO4357") == {"gusset": "FGPO4357"}
    assert p.parse_linked_codes("Glossy Finish Pouch | Gusset Code : FGPO7429 | Color Match with : FGPO6195") == {"gusset": "FGPO7429"}
    assert p.parse_linked_codes("Back Use Code FGPO7003") == {"back": "FGPO7003"}
