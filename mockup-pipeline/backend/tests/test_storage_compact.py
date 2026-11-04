"""The storage rules never lose a pixel: a recompressed PNG decodes to exactly the same image."""

import random

from PIL import Image

from app import storage_compact
from app.index.schemas import StorageRules


def _noisy(mode: str, size=(240, 160)) -> Image.Image:
    rnd = random.Random(7)
    im = Image.new(mode, size)
    im.putdata([tuple(rnd.randrange(256) for _ in range(len(mode))) if len(mode) > 1 else rnd.randrange(256) for _ in range(size[0] * size[1])])
    return im


def test_recompress_keeps_every_pixel(tmp_path):
    for mode in ("RGB", "RGBA", "L"):
        path = tmp_path / f"{mode}.png"
        im = _noisy(mode)
        im.save(path, "PNG", compress_level=1, dpi=(300, 300))  # as the renderer's quick encode leaves them
        before = path.stat().st_size
        saved = storage_compact.recompress_png(path)
        with Image.open(path) as back:
            assert back.mode == mode and back.tobytes() == im.tobytes()
            assert round(back.info.get("dpi", (300, 300))[0]) == 300  # (PNG keeps pixels per metre: 299.9994)
        assert saved == before - path.stat().st_size


def test_recompress_leaves_a_file_it_cannot_shrink(tmp_path):
    path = tmp_path / "small.png"
    _noisy("RGB", (8, 8)).save(path, "PNG", optimize=True)
    raw = path.read_bytes()
    assert storage_compact.recompress_png(path) == 0
    assert path.read_bytes() == raw


def test_rules_default_is_off_for_compaction():
    assert StorageRules().compact_after_days == 0 and StorageRules().pdf_cache_days == 7
