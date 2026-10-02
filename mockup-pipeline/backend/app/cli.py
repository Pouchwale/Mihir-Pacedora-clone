"""Developer CLI.

    python -m app.cli phase1 tests/fixtures/FGPO7215_Dog_Food_Front_App.pdf --out .work/phase1
"""

import argparse
import json
import sys
import time
from pathlib import Path

from app.errors import NeedsReview
from app.pdf.profile import PdfProfile
from app.specs.validate import ValidationRules
from app.steps import extract_specs, trim_artwork
from app.steps.trim_artwork import Sides
from app.storage import LocalStorage


def phase1(pdf: Path, out: Path, panel: str, eyemarks: bool) -> int:
    started = time.time()
    profile = PdfProfile(include_eyemarks=eyemarks)
    rules, storage = ValidationRules(), LocalStorage(out)
    item = profile.item_code_from_filename(pdf.name) or pdf.stem
    report: dict = {"file": pdf.name, "panel": panel}
    try:
        trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=pdf, filename=pdf.name, panel=panel, key_prefix=item), profile, storage)
        report["trim_artwork"] = trim.model_dump()
        specs = extract_specs.run(
            extract_specs.ExtractSpecsInput(pdf_path=pdf, filename=pdf.name, key_prefix=item,
                                            trim_width_mm=trim.trim_width_mm, trim_height_mm=trim.trim_height_mm),
            profile, rules, storage,
        )
        report["extract_specs"] = specs.model_dump(mode="json")
        issues = list(specs.report.issues)
        t = specs.sheet.spec_table
        if specs.report.bleed_source == "measured" and t.pouch_closed_width_mm.value and t.pouch_height_mm.value:
            fin = trim_artwork.finish(
                trim, pdf, Sides(**specs.report.bleed_used), t.pouch_closed_width_mm.value, t.pouch_height_mm.value,
                item, profile, storage,
            )
            report["finished"] = fin.model_dump()
            issues += fin.issues
        report["needs_review"] = [i.model_dump() for i in issues if i.severity == "review"]
        report["warnings"] = [i.model_dump() for i in issues if i.severity == "warning"]
        report["status"] = "NEEDS_REVIEW" if report["needs_review"] or "finished" not in report else "OK"
    except NeedsReview as exc:
        report["status"] = "NEEDS_REVIEW"
        report["error"] = exc.to_dict()
    report["seconds"] = round(time.time() - started, 1)
    (out / item).mkdir(parents=True, exist_ok=True)
    (out / item / "phase1_report.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    summary = {k: v for k, v in report.items() if k not in ("extract_specs", "trim_artwork")}
    print(json.dumps(summary, indent=2, default=str))
    return 0 if report["status"] == "OK" else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("phase1", help="trim_artwork + extract_specs on one PDF")
    p1.add_argument("pdf", type=Path)
    p1.add_argument("--out", type=Path, default=Path(".work/phase1"))
    p1.add_argument("--panel", default="front")
    p1.add_argument("--eyemarks", action="store_true", help="include eyemark layers in the texture")
    sub.add_parser("bootstrap", help="create the first admin (ADMIN_EMAIL/ADMIN_PASSWORD) and seed an empty index; run after migrations")
    sub.add_parser("seed-diff", help="show how the seed YAML differs from the current index (writes nothing)")
    sa = sub.add_parser("seed-apply", help="write the seed YAML's new and changed entries as new index versions "
                                           "(an admin edit of the same entry is superseded; its history stays)")
    sa.add_argument("--reason", default="seed update")
    args = parser.parse_args(argv)
    if args.cmd == "phase1":
        from app.pdf import raise_stream_limits

        raise_stream_limits()
        return phase1(args.pdf, args.out, args.panel, args.eyemarks)
    if args.cmd == "bootstrap":
        return bootstrap()
    if args.cmd == "seed-diff":
        return seed_diff()
    if args.cmd == "seed-apply":
        return seed_apply(args.reason)
    return 1


SEED = Path(__file__).parent / "index" / "seed" / "index.yaml"


def bootstrap() -> int:
    from sqlalchemy import func, select
    from sqlalchemy.orm import Session

    from app.auth import ensure_admin
    from app.db import get_engine
    from app.index import store
    from app.models import IndexEntry

    with Session(get_engine()) as session:
        message = ensure_admin(session)
        if message:
            print(message)
        if session.scalar(select(func.count()).select_from(IndexEntry)):
            print("Index already populated; seed not applied (use the admin UI or YAML import).")
            return 0
        plan = store.plan_import(session, SEED.read_text(encoding="utf-8"))
        store.apply_import(session, plan, store.Author(None, "system"), "initial seed", action="seed")
        session.commit()
        print(f"Index seeded: {len(plan.created)} entries.")
    return 0


def seed_diff() -> int:
    from sqlalchemy.orm import Session

    from app.db import get_engine
    from app.index import store

    with Session(get_engine()) as session:
        plan = store.plan_import(session, SEED.read_text(encoding="utf-8"))
    for name, text in plan.diffs.items():
        print(f"== {name}\n{text}\n")
    print(f"created {len(plan.created)}, updated {len(plan.updated)}, unchanged {len(plan.unchanged)}")
    return 0


def seed_apply(reason: str) -> int:
    """Seed changes shipped with a release, applied to a running index as ordinary versions (restorable)."""
    from sqlalchemy.orm import Session

    from app.db import get_engine
    from app.index import store

    with Session(get_engine()) as session:
        plan = store.plan_import(session, SEED.read_text(encoding="utf-8"))
        store.apply_import(session, plan, store.Author(None, "system"), reason, action="seed")
        session.commit()
    for kind, key in plan.created + plan.updated:
        print(f"{'created' if (kind, key) in plan.created else 'updated'} {kind}/{key}")
    print(f"created {len(plan.created)}, updated {len(plan.updated)}, unchanged {len(plan.unchanged)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
