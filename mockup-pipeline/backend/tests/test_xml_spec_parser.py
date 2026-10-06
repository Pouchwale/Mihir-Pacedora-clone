from app.ocr import assemble
from app.ocr.table import FieldRead, read_fields
from app.ocr.template import SpecTemplate
from app.services.xml_spec_parser import parse_xml_specs
from app.specs.schema import GussetType
from app.steps.extract_specs import apply_xml
from tests.conftest import needs_poppler, needs_tesseract
from tests.test_workflow import app_client  # noqa: F401 - fixture re-export

SAP_B1_XML = """
This XML file does not appear to have any style information associated with it. The document tree is shown below.
<Form Title="Item Master to XML">
<SystemItems>
<Signature String="Item[3];Grid[7];Column[0];Column[ItemCode];Column[ItemName];Column[A-Layer-1];Column[A-Layer-2];Column[A-Layer-3];Column[A-Layer-4];Column[U_PouchHeight];Column[U_PouchCloseWidth];Column[U_PouchOpenWidth];Column[U_PCylinTeeth];Column[U_PrintCylinCircum];Column[U_SL_CutReelWidth];Column[U_InsideB2BWidth];Column[U_AcrossUps];Column[U_Aroundups];Column[U_AcrossGap];Column[U_AroundGap];Column[V_0];Column[V_1];Column[E-Distortion];Column[E-Bleed];Column[F-Gusset];Column[F-Pouch/Roll-Form];Column[F-Round-Corner];Column[U_PouchStyle];Column[U_Zipper];Column[G-Butterfly-Notch];Column[G-Gusset-Full-Width];Column[G-Sealing-Width];Column[G-Tear-Notch];Column[G-Transparent-Window];Column[V_2];Item[13];Item[540000108];Item[1320000117];"/>
<Data>
<Item Uid="3" Data="SELECT T0.ItemCode, T0.ItemName, ISNULL(CAST(t0.U_LaminateLayer1Thickness AS VARCHAR(20)), '') + ' ' + ISNULL(t0.U_LaminateLayer1, '') AS 'A-Layer-1', ISNULL(CAST(t0.U_LaminateLayer2Thickness AS VARCHAR(20)), '') + ' ' + ISNULL(t0.U_LaminateLayer2, '') as 'A-Layer-2', ISNULL(CAST(t0.U_LaminateLayer3Thickness AS VARCHAR(20)), '') + ' ' + ISNULL(t0.U_LaminateLayer3, '') as 'A-Layer-3', ISNULL(CAST(t0.U_LaminateLayer4Thickness AS VARCHAR(20)), '') + ' ' + ISNULL(t0.U_LaminateLayer4, '') as 'A-Layer-4', t0.U_PouchHeight as 'B-Pouch-Height', t0.U_PouchCloseWidth as 'B-Pouch-Closed-Width', t0.U_PouchOpenWidth as 'B-Pouch-Width-Open', t0.U_PCylinTeeth AS 'C-Teeth', T0.U_PrintCylinCircum AS 'C-Circumference', T0.U_SL_CutReelWidth AS 'C-B2B-Width', t0.U_InsideB2BWidth as 'C-In-B2B-Width', T0.U_AcrossUps AS 'C-AC-Ups', T0.U_Aroundups AS 'C-AR-Ups', T0.U_AcrossGap AS 'D-Gap-Across', T0.U_AroundGap AS 'D-Gap-Around', t0.U_InsideB2BWidth as 'D-Label-H', T0.U_PrintCylinCircum AS 'D-Label-W', '' as 'E-Distortion', 1.5 as 'E-Bleed', case when t0.U_PouchStyle in ('Standy','Standy+Zipper') then 'Bottom Gusset' when t0.U_PouchStyle in ('SideGazette') then 'Side Gusset' else ' ' end AS 'F-Gusset', case when t0.U_PouchStyle='RollForm' then 'Roll Form' else 'Pouch Form' end as 'F-Pouch/Roll-Form', case when t0.U_PouchStyle in ('Standy','Standy+Zipper','3SideSeal','3SideSeal+Zipper', 'Top(center) Spout Pouch','Side Spout Pouch') then 'Yes' else 'No' end as 'F-Round-Corner', t0.U_PouchStyle AS 'F-Sealing-Type', t0.U_Zipper as 'F-Zipper', '' as 'G-Butterfly-Notch', (isnull(t0.u_PouchD,0)*2) as 'G-Gusset-Full-Width', ISNULL(T0.U_SealingWidth,0) AS 'G-Sealing-Width', case when t0.U_PouchStyle='RollForm' then 'No' else 'V Notch' end as 'G-Tear-Notch', case when (t0.u_LaminateLayer2 in ('METPET','Allu Foil') or t0.U_LaminateLayer3 in ('LDPE(MilkyWhite)')) then 'No' else 'Yes' end as 'G-Transparent-Window' FROM OITM T0 WHERE T0.ItemCode LIKE 'FG%' AND T0.validFor='Y' and (t0.ItemCode='[%0]' or '[%0]'=' ')"/>
<Grid>
<Row Num="1">
<Column Uid="0" Title="#" Data="1"/>
<Column Uid="ItemCode" Title="Item No." Data="FGPO6962"/>
<Column Uid="ItemName" Title="Item Description" Data="FGPO6962"/>
<Column Uid="A-Layer-1" Title="A-Layer-1" Data="25 Matte BOPP"/>
<Column Uid="A-Layer-2" Title="A-Layer-2" Data="12 METPET"/>
<Column Uid="A-Layer-3" Title="A-Layer-3" Data="75 LDPE(NaturalGeneral)"/>
<Column Uid="A-Layer-4" Title="A-Layer-4" Data="0 None"/>
<Column Uid="U_PouchHeight" Title="B-Pouch-Height" Data="260"/>
<Column Uid="U_PouchCloseWidth" Title="B-Pouch-Closed-Width" Data="185"/>
<Column Uid="U_PouchOpenWidth" Title="B-Pouch-Width-Open" Data="370"/>
<Column Uid="U_PCylinTeeth" Title="C-Teeth" Data="84"/>
<Column Uid="U_PrintCylinCircum" Title="C-Circumference" Data="266.700"/>
<Column Uid="U_SL_CutReelWidth" Title="C-B2B-Width" Data="325"/>
<Column Uid="U_InsideB2BWidth" Title="C-In-B2B-Width" Data="1"/>
<Column Uid="U_AcrossUps" Title="C-AC-Ups" Data="1"/>
<Column Uid="U_Aroundups" Title="C-AR-Ups" Data="1"/>
<Column Uid="U_AcrossGap" Title="D-Gap-Across" Data="0.0000"/>
<Column Uid="U_AroundGap" Title="D-Gap-Around" Data="0.0000"/>
<Column Uid="V_0" Title="D-Label-H" Data="1"/>
<Column Uid="V_1" Title="D-Label-W" Data="266.700"/>
<Column Uid="E-Distortion" Title="E-Distortion" Data=""/>
<Column Uid="E-Bleed" Title="E-Bleed" Data="1.500"/>
<Column Uid="F-Gusset" Title="F-Gusset" Data="Bottom Gusset"/>
<Column Uid="F-Pouch/Roll-Form" Title="F-Pouch/Roll-Form" Data="Pouch Form"/>
<Column Uid="F-Round-Corner" Title="F-Round-Corner" Data="Yes"/>
<Column Uid="U_PouchStyle" Title="F-Sealing-Type" Data="Standy+Zipper"/>
<Column Uid="U_Zipper" Title="F-Zipper" Data="Yes"/>
<Column Uid="G-Butterfly-Notch" Title="G-Butterfly-Notch" Data=""/>
<Column Uid="G-Gusset-Full-Width" Title="G-Gusset-Full-Width" Data="110"/>
<Column Uid="G-Sealing-Width" Title="G-Sealing-Width" Data="0"/>
<Column Uid="G-Tear-Notch" Title="G-Tear-Notch" Data="V Notch"/>
<Column Uid="G-Transparent-Window" Title="G-Transparent-Window" Data="No"/>
<Column Uid="V_2" Title="" Data="Y"/>
</Row>
</Grid>
<Item Uid="13" Data="Display Query Structure"/>
<Item Uid="540000108" Data=""/>
<Item Uid="1320000117" Data="Display Query Results"/>
</Data>
</SystemItems>
</Form>
"""


def test_item_master_row_becomes_spec_table_text():
    items = parse_xml_specs(SAP_B1_XML)
    assert list(items) == ["FGPO6962"]
    f = items["FGPO6962"]
    assert (f["pouch_height_mm"], f["pouch_closed_width_mm"], f["pouch_open_width_mm"], f["gusset_full_width_mm"]) == ("260", "185", "370", "110")
    assert (f["sealing_type"], f["gusset_type"], f["pouch_or_roll_form"]) == ("Standy+Zipper", "Bottom Gusset", "Pouch Form")
    assert (f["zipper"], f["round_corner"], f["tear_notch"], f["transparent_window"]) == ("Yes", "Yes", "V Notch", "No")
    assert (f["layer_1"], f["layer_2"], f["layer_3"]) == ("25 Matte BOPP", "12 METPET", "75 LDPE(NaturalGeneral)")
    assert (f["teeth"], f["circumference_mm"], f["b2b_width_mm"], f["ac_ups"], f["ar_ups"]) == ("84", "266.700", "325", "1", "1")
    # SAP's own columns, the query's constants and unset values are not specs
    assert "layer_4" not in f and "sealing_width_mm" not in f and not any("SELECT" in v for v in f.values())
    assert set(f) <= {"item_no", "item_name", "layer_1", "layer_2", "layer_3", "pouch_height_mm", "pouch_closed_width_mm",
                      "pouch_open_width_mm", "teeth", "circumference_mm", "b2b_width_mm", "inside_b2b_width_mm", "ac_ups", "ar_ups",
                      "gusset_type", "pouch_or_roll_form", "round_corner", "sealing_type", "zipper", "gusset_full_width_mm",
                      "tear_notch", "transparent_window"}


def test_several_rows_are_several_items_and_sap_styles_are_mapped():
    row = """<Row><Column Uid="ItemCode" Title="Item No." Data="{code}"/><Column Uid="U_PouchHeight" Title="B-Pouch-Height" Data="200"/>
             <Column Uid="U_PouchStyle" Title="F-Sealing-Type" Data="{style}"/><Column Uid="F-Gusset" Title="F-Gusset" Data=" "/></Row>"""
    xml = "<Form><Grid>" + row.format(code="FGPO1", style="3SideSeal+Zipper") + row.format(code="FGPO2", style="SideGazette") + "</Grid></Form>"
    items = parse_xml_specs(xml.encode())
    assert items["FGPO1"]["sealing_type"] == "3 Side Seal" and items["FGPO2"]["sealing_type"] == "Side Gusset"
    assert items["FGPO1"]["pouch_height_mm"] == "200"


def test_not_an_item_master():
    assert parse_xml_specs("not xml") == {}
    assert parse_xml_specs('<!DOCTYPE x [<!ENTITY a "aaaa">]><Form>&a;</Form>') == {}  # no entity expansion from uploads


def test_xml_values_win_over_the_table_read():
    tpl = SpecTemplate()
    reads = read_fields([], tpl, 1000)  # an unreadable table (outlined text, OCR off)
    reads["pouch_height_mm"] = FieldRead("pouch_height_mm", "26O", None, 0.3, False, (1, 2, 3, 4), "", "ocr")
    apply_xml(reads, parse_xml_specs(SAP_B1_XML)["FGPO6962"], tpl)
    assert reads["pouch_height_mm"].value == 260 and reads["pouch_height_mm"].source == "xml" and reads["pouch_height_mm"].bbox == (1, 2, 3, 4)
    assert reads["zipper"].value is True and reads["transparent_window"].value is False
    table = assemble.spec_table(reads, [], tpl)
    assert table.gusset_type.value == GussetType.bottom and table.sealing_type.value == "Standy+Zipper"
    assert [(l.micron, l.material) for l in table.layers.value] == [(25, "Matte BOPP"), (12, "METPET"), (75, "LDPE(NaturalGeneral)")]


def test_upload_with_item_master_gives_each_job_its_own_item(app_client, monkeypatch):
    from sqlalchemy import select

    from app import db as app_db
    from app.models import Job, UploadedFile
    from app.workflow import queue
    from app.workflow.steps import link_panels
    from tests.conftest import SAMPLE
    from tests.test_workflow import H

    monkeypatch.setattr(queue, "enqueue", lambda *a, **k: None)
    xml = SAP_B1_XML.replace("FGPO6962", "FGPO7215") + "\n"
    other = SAP_B1_XML  # FGPO6962: not this job's item
    files = [("files", (SAMPLE.name, SAMPLE.read_bytes(), "application/pdf")),
             ("files", ("items.xml", xml.encode(), "application/xml")), ("files", ("other.xml", other.encode(), "application/xml"))]
    r = app_client.post("/api/uploads", files=files, headers=H)
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d["xml_specs"]) == {"FGPO7215", "FGPO6962"} and len(d["jobs"]) == 1
    with app_db._factory()() as s:
        job = s.get(Job, d["jobs"][0])
        assert job.inputs["xml_fields"]["item_no"] == "FGPO7215" and job.inputs["xml_fields"]["pouch_height_mm"] == "260"
        # the XML is registered under its item codes, but a panel lookup by code still finds the PDF
        assert s.scalar(select(UploadedFile).where(UploadedFile.item_code == "FGPO7215", link_panels._NOT_XML)).filename == SAMPLE.name

    bad = app_client.post("/api/uploads", files=[("files", ("x.xml", b"<a/>", "application/xml"))], headers=H)
    assert bad.status_code == 422


@needs_poppler
@needs_tesseract
def test_job_with_item_master_reads_the_xml_not_the_table(app_client, monkeypatch):
    """FGPO7215 with its item master: specs from the XML in a couple of seconds; the PDF still links the
    back and gusset named in its Remarks and gives the drawing."""
    from app.render import headless
    from tests.conftest import SAMPLE
    from tests.test_workflow import H, fake_render

    monkeypatch.setattr(headless, "render", fake_render)
    xml = (SAP_B1_XML.replace("FGPO6962", "FGPO7215").replace('Data="260"', 'Data="312"').replace('Data="185"', 'Data="240"')
           .replace('Data="370"', 'Data="240"').replace('Data="110"', 'Data="120"').replace('G-Sealing-Width" Data="0"', 'G-Sealing-Width" Data="10"'))
    files = [("files", (SAMPLE.name, SAMPLE.read_bytes(), "application/pdf")), ("files", ("items.xml", xml.encode(), "application/xml"))]
    job_id = app_client.post("/api/uploads", files=files, headers=H).json()["jobs"][0]
    d = app_client.get(f"/api/jobs/{job_id}").json()
    ex = d["outputs"]["extract_specs"]
    t = ex["sheet"]["spec_table"]
    assert ex["text_source"] == "xml"
    assert (t["pouch_height_mm"]["value"], t["pouch_closed_width_mm"]["value"], t["gusset_full_width_mm"]["value"]) == (312, 240, 120)
    assert t["client_name"]["value"] == "Crystal Enterprises" and t["inks"]["value"][:4] == ["Cyan", "Magenta", "Yellow", "Black"]
    assert ex["sheet"]["linked_codes"]["back"] == "FGPO7216"
    steps = {s["step"]: s for s in d["steps"]}
    from datetime import datetime

    took = datetime.fromisoformat(steps["extract_specs"]["finished_at"]) - datetime.fromisoformat(steps["extract_specs"]["started_at"])
    assert took.total_seconds() < 10  # (reading the table took 10-25 s)
    assert d["review"]["code"] == "missing_panels"  # the back PDF was not uploaded
