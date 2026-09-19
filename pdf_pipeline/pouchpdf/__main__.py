"""python -m pouchpdf index <folder> | specs <pdf> | artwork <pdf> | run <pdf> [--folder F] | watch <folder>"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .indexer import Index
from .pipeline import run_job

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv=None):
    p = argparse.ArgumentParser(prog="pouchpdf")
    p.add_argument("--db", default=os.path.join(HERE, "output", "index.sqlite"))
    p.add_argument("--out", default=os.path.join(HERE, "output", "jobs"))
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("index", "watch"):
        sub.add_parser(name).add_argument("folder")
    sub.add_parser("specs").add_argument("pdf")
    sub.add_parser("list")
    r = sub.add_parser("run")
    r.add_argument("pdf")
    r.add_argument("--folder", help="folder to index first (default: the PDF's folder)")
    a = p.parse_args(argv)

    index = Index(a.db)
    if a.cmd == "index":
        res = index.scan(a.folder)
        print(json.dumps({"added": len(res.added), "updated": len(res.updated), "removed": len(res.removed), "skipped_no_item_no": len(res.skipped)}, indent=2))
        for row in index.all():
            print(f"  {row['item_no']:10s} {','.join(row['panels']) or '?':14s} {os.path.basename(row['path'])}")
    elif a.cmd == "watch":
        index.watch(a.folder)
    elif a.cmd == "list":
        for row in index.all():
            print(f"{row['item_no']:10s} {','.join(row['panels']) or '?':14s} back={row['back_code']} gusset={row['gusset_code']} {row['path']}")
    elif a.cmd == "specs":
        from .specs import extract_specs

        print(json.dumps(extract_specs(a.pdf), indent=2))
    elif a.cmd == "run":
        index.scan(a.folder or os.path.dirname(os.path.abspath(a.pdf)))
        job = run_job(a.pdf, a.out, index)
        print(json.dumps({k: job[k] for k in ("item_no", "job_dir", "needs_review", "warnings")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
