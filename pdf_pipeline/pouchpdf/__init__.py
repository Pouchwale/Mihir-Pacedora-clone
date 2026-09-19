"""Approval-PDF -> pouch mockup pipeline. Each stage is its own module:

indexer  (1) folder of approval PDFs -> SQLite index keyed by item number
specs    (2) spec table -> validated JSON (local OCR, no API)
artwork  (3) TrimBox crop, technical marks removed, bleed trimmed -> texture PNG
linking  (4) follow back / gusset codes through the index
"""
