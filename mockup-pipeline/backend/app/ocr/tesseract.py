"""Thin wrapper over pytesseract returning positioned words."""

from dataclasses import dataclass

import pytesseract
from PIL import Image

from app.config import get_settings


@dataclass(frozen=True)
class Word:
    text: str
    conf: float  # 0-1
    left: int
    top: int
    width: int
    height: int

    @property
    def right(self) -> int:
        return self.left + self.width

    @property
    def bottom(self) -> int:
        return self.top + self.height

    @property
    def cy(self) -> float:
        return self.top + self.height / 2


def _configure() -> None:
    cmd = get_settings().tesseract_cmd
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd


def words(image: Image.Image, psm: int, lang: str = "eng", whitelist: str | None = None) -> list[Word]:
    _configure()
    config = f"--psm {psm}" + (f" -c tessedit_char_whitelist={whitelist}" if whitelist else "")
    data = pytesseract.image_to_data(image, lang=lang, config=config, output_type=pytesseract.Output.DICT)
    out = []
    for i, text in enumerate(data["text"]):
        text = text.strip()
        conf = float(data["conf"][i])
        if text and conf >= 0:
            out.append(Word(text, conf / 100, data["left"][i], data["top"][i], data["width"][i], data["height"][i]))
    return out


def version() -> str:
    _configure()
    return str(pytesseract.get_tesseract_version())
