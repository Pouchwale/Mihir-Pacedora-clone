"""Splitting a flat pillow blank into the front and the back (pure image geometry)."""

from PIL import Image

from app.workflow.steps.texture import split_blank


def _blank(open_w: int, h: int, closed: int) -> Image.Image:
    """fin | left half-back | front | right half-back | fin, each strip its own colour."""
    fin = (open_w - 2 * closed) // 2
    img = Image.new("RGB", (open_w, h))
    strips = [(0, fin, (200, 200, 200)), (fin, fin + closed // 2, (255, 0, 0)), (fin + closed // 2, fin + closed // 2 + closed, (0, 255, 0)),
              (fin + closed // 2 + closed, open_w - fin, (0, 0, 255)), (open_w - fin, open_w, (200, 200, 200))]
    for x0, x1, colour in strips:
        img.paste(colour, (x0, 0, x1, h))
    return img


def test_front_is_the_middle_and_back_joins_the_outer_strips():
    # 1 px = 1 mm: open 170 = fin 9 | half back 38 | front 76 | half back 38 | fin 9
    front, back = split_blank(_blank(170, 108, 76), 170, 76)
    assert front.size == (76, 108) and back.size == (76, 108)
    assert front.getpixel((0, 0)) == (0, 255, 0) == front.getpixel((75, 0))
    # the back reads: right half-back (blue) then left half-back (red), joined at the fin seal
    assert back.getpixel((0, 0)) == (0, 0, 255) == back.getpixel((37, 0)) and back.getpixel((38, 0)) == (255, 0, 0) == back.getpixel((75, 0))


def test_fin_seal_is_the_leftover_and_never_negative():
    front, back = split_blank(_blank(160, 100, 76), 160, 76)  # fin 4
    assert front.size == (76, 100) and back.size == (76, 100)
    front, back = split_blank(_blank(150, 100, 75), 150, 75)  # no fin at all
    assert front.size == (75, 100) and back.size == (76, 100)
