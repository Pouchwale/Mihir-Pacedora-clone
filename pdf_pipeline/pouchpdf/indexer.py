"""Stage 1: index a folder of approval PDFs, keyed by item number (FGPO + digits)."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from dataclasses import dataclass

from .config import ITEM_NO_RE

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  item_no TEXT,
  panels TEXT NOT NULL,            -- JSON list: front / back / gusset
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  client_name TEXT,
  date_of_approval TEXT,
  back_code TEXT,
  gusset_code TEXT,
  specs TEXT,                      -- JSON from stage 2 (NULL until extracted)
  indexed_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS files_item ON files(item_no);
"""

# Filenames are typed by hand: accept the common misspelling "Fornt"
PANEL_WORDS = {"front": "front", "fornt": "front", "back": "back", "gusset": "gusset", "guset": "gusset", "bottom": "gusset"}


def item_no_from_name(filename: str) -> str | None:
    m = ITEM_NO_RE.search(os.path.basename(filename))
    return m.group(1).upper() if m else None


def panels_from_name(filename: str) -> list[str]:
    words = re.findall(r"[a-z]+", os.path.basename(filename).lower())
    found: list[str] = []
    for w in words:
        panel = PANEL_WORDS.get(w)
        if panel and panel not in found:
            found.append(panel)
    return found


@dataclass
class ScanResult:
    added: list[str]
    updated: list[str]
    removed: list[str]
    skipped: list[str]  # PDFs without an item number in the name


class Index:
    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self.db = sqlite3.connect(db_path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self):
        self.db.close()

    def scan(self, folder: str) -> ScanResult:
        """Add new files, re-index changed ones (mtime/size) and drop deleted ones."""
        result = ScanResult([], [], [], [])
        folder = os.path.abspath(folder)
        seen: set[str] = set()
        for root, _dirs, names in os.walk(folder):
            for name in names:
                if not name.lower().endswith(".pdf"):
                    continue
                path = os.path.join(root, name)
                item_no = item_no_from_name(name)
                if not item_no:
                    result.skipped.append(path)
                    continue
                seen.add(path)
                st = os.stat(path)
                row = self.db.execute("SELECT mtime, size FROM files WHERE path=?", (path,)).fetchone()
                if row and row["mtime"] == st.st_mtime and row["size"] == st.st_size:
                    continue
                # A changed file loses its cached specs: they must be extracted again
                self.db.execute(
                    "INSERT OR REPLACE INTO files(path,item_no,panels,mtime,size,indexed_at) VALUES(?,?,?,?,?,?)",
                    (path, item_no, json.dumps(panels_from_name(name)), st.st_mtime, st.st_size, time.time()),
                )
                (result.updated if row else result.added).append(path)
        for row in self.db.execute("SELECT path FROM files WHERE path LIKE ?", (folder + "%",)).fetchall():
            if row["path"] not in seen:
                self.db.execute("DELETE FROM files WHERE path=?", (row["path"],))
                result.removed.append(row["path"])
        self.db.commit()
        return result

    def watch(self, folder: str, interval: float = 5.0, on_change=print):
        """Polling watcher (no extra dependency). Runs until interrupted."""
        while True:
            r = self.scan(folder)
            if r.added or r.updated or r.removed:
                on_change(r)
            time.sleep(interval)

    def store_specs(self, path: str, specs: dict):
        self.db.execute(
            "UPDATE files SET specs=?, client_name=?, date_of_approval=?, back_code=?, gusset_code=? WHERE path=?",
            (json.dumps(specs), specs.get("client_name"), specs.get("date_of_approval"), specs.get("back_code"), specs.get("gusset_code"), os.path.abspath(path)),
        )
        self.db.commit()

    def cached_specs(self, path: str) -> dict | None:
        row = self.db.execute("SELECT specs FROM files WHERE path=?", (os.path.abspath(path),)).fetchone()
        return json.loads(row["specs"]) if row and row["specs"] else None

    def lookup(self, item_no: str, panel: str | None = None) -> list[dict]:
        """Files for an item number, newest first; optionally only those holding a panel."""
        rows = self.db.execute("SELECT * FROM files WHERE item_no=? ORDER BY mtime DESC", (item_no.upper(),)).fetchall()
        out = []
        for row in rows:
            d = dict(row)
            d["panels"] = json.loads(d["panels"])
            d["specs"] = json.loads(d["specs"]) if d["specs"] else None
            if panel is None or panel in d["panels"] or not d["panels"]:
                out.append(d)
        return out

    def all(self) -> list[dict]:
        return [dict(r) | {"panels": json.loads(r["panels"])} for r in self.db.execute("SELECT * FROM files ORDER BY item_no, path")]
