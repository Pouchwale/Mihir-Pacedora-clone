"""Item specs from an SAP Business One "Item Master to XML" export (the user-defined OITM fields).

Each <Grid><Row> is one item: its <Column Uid=... Title=... Data=...> cells are mapped to the spec
table's fields as the text the table would print (app.ocr.template), so the extract step reads them
like any other text source (app.ocr.table.parse_value). What the export carries besides the item -
the SQL behind the form, grid signatures, SAP's own V_n columns, the constant "E-Bleed 1.5" and the
label / gap / distortion columns the dieline does not use - is left out.

A plain key-value XML (<U_PouchHeight>260</U_PouchHeight> ...) is read as one item.
"""

import xml.etree.ElementTree as ET

# SAP column (Uid or Title, case-insensitive) -> spec table field
COLUMNS: dict[str, str] = {
    "itemcode": "item_no", "item no.": "item_no",
    "itemname": "item_name", "item description": "item_name",
    "a-layer-1": "layer_1", "a-layer-2": "layer_2", "a-layer-3": "layer_3", "a-layer-4": "layer_4",
    "u_pouchheight": "pouch_height_mm", "b-pouch-height": "pouch_height_mm",
    "u_pouchclosewidth": "pouch_closed_width_mm", "b-pouch-closed-width": "pouch_closed_width_mm",
    "u_pouchopenwidth": "pouch_open_width_mm", "b-pouch-width-open": "pouch_open_width_mm",
    "u_pcylinteeth": "teeth", "c-teeth": "teeth",
    "u_printcylincircum": "circumference_mm", "c-circumference": "circumference_mm",
    "u_sl_cutreelwidth": "b2b_width_mm", "c-b2b-width": "b2b_width_mm",
    "u_insideb2bwidth": "inside_b2b_width_mm", "c-in-b2b-width": "inside_b2b_width_mm",
    "u_acrossups": "ac_ups", "c-ac-ups": "ac_ups",
    "u_aroundups": "ar_ups", "c-ar-ups": "ar_ups",
    "f-gusset": "gusset_type",
    "f-pouch/roll-form": "pouch_or_roll_form",
    "f-round-corner": "round_corner",
    "u_pouchstyle": "sealing_type", "f-sealing-type": "sealing_type",
    "u_zipper": "zipper", "f-zipper": "zipper",
    "g-butterfly-notch": "butterfly_notch",
    "g-gusset-full-width": "gusset_full_width_mm",
    "g-sealing-width": "sealing_width_mm",
    "g-tear-notch": "tear_notch",
    "g-transparent-window": "transparent_window",
}

# U_PouchStyle values the spec table does not print as such -> its sealing type
STYLES = {
    "3sideseal": "3 Side Seal", "3sideseal+zipper": "3 Side Seal",
    "sidegazette": "Side Gusset", "rollform": "NA",
    "top(center) spout pouch": "Spout", "side spout pouch": "Spout",
}

# Zero means "not set" in these SAP fields (G-Sealing-Width 0, G-Gusset-Full-Width 0 for a flat pouch)
UNSET_IF_ZERO = {"pouch_height_mm", "pouch_closed_width_mm", "pouch_open_width_mm", "teeth", "circumference_mm",
                 "b2b_width_mm", "inside_b2b_width_mm", "ac_ups", "ar_ups", "gusset_full_width_mm", "sealing_width_mm"}


def _clean(field: str, text: str) -> str | None:
    text = " ".join(text.split())
    if not text or text.lower() in ("0 none", "none") and field.startswith("layer_"):
        return None
    if field in UNSET_IF_ZERO:
        try:
            if float(text) == 0:
                return None
        except ValueError:
            return None
    if field == "sealing_type":
        return STYLES.get(text.lower(), text)
    return text


def _item(cells: list[tuple[str, str, str]]) -> dict[str, str]:
    """{field: text} from (uid, title, data) cells; a field named twice keeps its first value."""
    out: dict[str, str] = {}
    for uid, title, data in cells:
        field = COLUMNS.get(uid.lower()) or COLUMNS.get(title.lower())
        if field and field not in out:
            text = _clean(field, data)
            if text is not None:
                out[field] = text
    if "pouch_or_roll_form" in out and "gusset_type" not in out and any(c[0].lower() == "f-gusset" for c in cells):
        out["gusset_type"] = "None"  # (the export leaves F-Gusset blank for a pouch without one)
    return out


def parse_xml_specs(content: bytes | str) -> dict[str, dict[str, str]]:
    """Item code -> {spec table field: text} for every item in the export; {} when it is not one."""
    text = content.decode("utf-8", errors="replace") if isinstance(content, bytes) else content
    text = text[max(0, text.find("<")):]  # (a browser's "This XML file does not appear..." banner)
    if "<!DOCTYPE" in text or "<!ENTITY" in text:
        return {}  # untrusted upload: no DTDs (entity expansion)
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return {}
    rows = [[(c.get("Uid", ""), c.get("Title", ""), c.get("Data", "")) for c in row.iter("Column")] for row in root.iter("Row")]
    if not rows:  # key-value XML: leaf tags are the columns
        rows = [[(e.tag, e.tag, e.text or "") for e in root.iter() if len(e) == 0 and (e.text or "").strip()]]
    items: dict[str, dict[str, str]] = {}
    for cells in rows:
        fields = _item(cells)
        code = fields.get("item_no", "").upper()
        if code and len(fields) > 1:
            items[code] = fields
    return items
