"""Text recognition, fully local. Swap the engine by passing another callable to specs.extract_specs:
any function image(ndarray RGB) -> list[OcrBox] works (e.g. Tesseract, or a vision model later)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class OcrBox:
    text: str
    conf: float
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def yc(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def h(self) -> float:
        return self.y1 - self.y0


_engine = None


def rapidocr_engine(image: np.ndarray) -> list[OcrBox]:
    """RapidOCR (ONNX models bundled with the package, runs on CPU, no network)."""
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR

        _engine = RapidOCR()
    result, _ = _engine(image)
    boxes = []
    for quad, text, conf in result or []:
        xs = [p[0] for p in quad]
        ys = [p[1] for p in quad]
        boxes.append(OcrBox(text.strip(), float(conf), min(xs), min(ys), max(xs), max(ys)))
    return boxes
