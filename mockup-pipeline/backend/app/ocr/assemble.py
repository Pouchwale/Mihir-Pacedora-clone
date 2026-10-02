"""Turn per-field OCR reads into the typed SpecTable."""

from app.ocr.inks import InkRead
from app.ocr.table import FieldRead
from app.ocr.template import SpecTemplate
from app.specs.schema import (
    Bool, FilmLayer, FilmLayers, Finish, FinishField, GussetType, GussetTypeField, Num, SpecTable, Str, StrList,
)

_GUSSET = {"Bottom": GussetType.bottom, "Bottom Gusset": GussetType.bottom, "Side": GussetType.side, "Side Gusset": GussetType.side,
           "None": GussetType.none, "No": GussetType.none, "NA": GussetType.none, "Yes": GussetType.yes}


def _str(r: FieldRead) -> Str:
    return Str(value=None if r.value is None else str(r.value), confidence=r.confidence)


def _num(r: FieldRead) -> Num:
    return Num(value=r.value if isinstance(r.value, (int, float)) and not isinstance(r.value, bool) else None, confidence=r.confidence)


def _bool(r: FieldRead) -> Bool:
    return Bool(value=r.value if isinstance(r.value, bool) else None, confidence=r.confidence)


def finish_from_text(text: str, tpl: SpecTemplate) -> Finish | None:
    low = " ".join(text.lower().split())
    for keyword, finish in tpl.finish_keywords.items():
        if keyword in low:
            return Finish(finish)
    return None


def spec_table(reads: dict[str, FieldRead], inks: list[InkRead], tpl: SpecTemplate) -> SpecTable:
    layer_reads = [reads[k] for k in ("layer_1", "layer_2", "layer_3", "layer_4") if k in reads]
    present = [r for r in layer_reads if isinstance(r.value, dict)]
    layers = FilmLayers(
        value=[FilmLayer(**r.value) for r in present],
        confidence=min((r.confidence for r in layer_reads if r.value is not None or r.field == "layer_1"), default=0.0),
    )
    gusset = reads["gusset_type"]
    remarks, additions = reads["raw_remarks"], reads["value_additions"]
    finish_text = " ".join(str(r.value) for r in (remarks, additions) if r.value)
    finish = finish_from_text(finish_text, tpl)
    finish_conf = min((r.confidence for r in (remarks, additions) if r.value), default=0.9) if finish_text else 0.9
    outer = reads.get("layer_1")
    if finish is None and tpl.finish_from_outer_layer and outer is not None and isinstance(outer.value, dict):
        finish = finish_from_text(str(outer.value.get("material", "")), tpl)
        if finish is not None:
            finish_conf = outer.confidence
    return SpecTable(
        client_name=_str(reads["client_name"]),
        item_name=_str(reads["item_name"]),
        item_no=_str(reads["item_no"]),
        date_of_approval=_str(reads["date_of_approval"]),
        teeth=_num(reads["teeth"]),
        circumference_mm=_num(reads["circumference_mm"]),
        inside_b2b_width_mm=_num(reads["inside_b2b_width_mm"]),
        b2b_width_mm=_num(reads["b2b_width_mm"]),
        colour_count=_num(reads["colour_count"]),
        ar_ups=_num(reads["ar_ups"]),
        ac_ups=_num(reads["ac_ups"]),
        inks=StrList(value=[i.name for i in inks if i.name], confidence=min((i.confidence for i in inks), default=0.0)),
        value_additions=_str(additions),
        pouch_height_mm=_num(reads["pouch_height_mm"]),
        pouch_closed_width_mm=_num(reads["pouch_closed_width_mm"]),
        pouch_open_width_mm=_num(reads["pouch_open_width_mm"]),
        layers=layers,
        pouch_or_roll_form=_str(reads["pouch_or_roll_form"]),
        sealing_type=_str(reads["sealing_type"]),
        gusset_type=GussetTypeField(value=_GUSSET.get(gusset.value) if gusset.format_ok else None, confidence=gusset.confidence),
        gusset_full_width_mm=_num(reads["gusset_full_width_mm"]),
        zipper=_bool(reads["zipper"]),
        round_corner=_bool(reads["round_corner"]),
        transparent_window=_bool(reads["transparent_window"]),
        sealing_width_mm=_num(reads["sealing_width_mm"]),
        tear_notch=_str(reads["tear_notch"]),
        butterfly_notch=_bool(reads["butterfly_notch"]),
        finish=FinishField(value=finish, confidence=finish_conf),
        raw_remarks=_str(remarks),
    )
