"""Field dictionary (index kind `field`): every value the system reads from an approval PDF.

One entry per field, keyed by the field's name (e.g. `pouch_height_mm`). An entry says what is
printed on the sheet (label and its variants), how the value is read (kind, options and their
printed synonyms, range), what it means for a job (required, confidence threshold) and where it
sits in the table (section, order). The OCR template (`SpecTemplate.fields`) is composed from the
dictionary, so renaming a label, adding an option spelling or changing a threshold is an index
edit, not a deploy.

Every non-stop field stores into a `SpecTable` column; the dictionary can describe any of them and
add stop labels (printed text that only ends the previous value). A brand-new column needs a
schema change first, and the validator says so instead of dropping the value silently.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.ocr.template import DEFAULT_FIELDS, FieldRule, SpecTemplate, ValueKind
from app.specs.schema import SpecTable

Source = Literal["spec_table", "dieline", "ink_row", "derived"]

# Columns the extraction fills without a printed label: they may be in the dictionary (required,
# confidence) but carry no label to search for.
UNLABELLED = {"inks": "ink_row", "finish": "derived", "layers": "derived"}
STORED_FIELDS = set(SpecTable.model_fields) | {"layer_1", "layer_2", "layer_3", "layer_4"}


class FieldDef(BaseModel):
    name: str = Field(description="shown in the admin UI, e.g. 'Pouch height'")
    label: str = Field("", description="as printed on the sheet, e.g. 'Pouch height:'")
    aliases: list[str] = Field([], description="other printings of the same label (template variants)")
    kind: ValueKind = "text"
    options: list[str] = Field([], description="canonical values of an option field")
    synonyms: dict[str, list[str]] = Field({}, description="canonical option -> other printed spellings, e.g. {'Stand-up': ['Standy', 'Stand up']}")
    unit: str = ""
    min: float | None = None
    max: float | None = None
    required: bool = Field(False, description="a job cannot continue without a value")
    optional: bool = Field(True, description="a blank cell is a valid answer; False = a blank cell is an unreadable value")
    min_confidence: float | None = Field(None, ge=0, le=1, description="review below this; empty = the validation rules' threshold")
    section: bool = Field(False, description="this label starts a block of the table")
    multiline: bool = False
    keep_chars: str = ""
    confirm_with_filename: Literal["stem", "code"] | None = None
    stop: bool = Field(False, description="a stop label: printed text that only ends the previous value, stores nothing")
    source: Source = "spec_table"
    order: int = Field(100, description="position in the table, top to bottom")
    description: str = ""

    @model_validator(mode="after")
    def _consistent(self) -> "FieldDef":
        if self.kind == "option" and not self.options:
            raise ValueError("an option field needs its options")
        for canonical in self.synonyms:
            if canonical not in self.options:
                raise ValueError(f"synonyms for {canonical!r}, which is not one of the options")
        if not self.stop and not self.label and self.source == "spec_table":
            raise ValueError("a spec-table field needs its printed label (or mark it as a stop label)")
        return self

    def all_options(self) -> list[str]:
        """Canonical options first, then every synonym: what the OCR parser may match."""
        out = list(self.options)
        for canonical, more in self.synonyms.items():
            out += [m for m in more if m not in out]
        return out

    def to_rule(self, key: str) -> FieldRule | None:
        """The OCR template rule for this field; None for unlabelled columns (nothing to search for)."""
        if self.source != "spec_table" and not self.stop:
            return None
        return FieldRule(
            field=None if self.stop else key, label=self.label, aliases=self.aliases, section=self.section, kind=self.kind,
            options=self.options, synonyms=self.synonyms, min=self.min, max=self.max, optional=self.optional, multiline=self.multiline,
            keep_chars=self.keep_chars, confirm_with_filename=self.confirm_with_filename,
        )


def check_keys(fields: dict[str, FieldDef]) -> list[str]:
    """Dictionary keys must be storable columns (or stop labels)."""
    problems = []
    for key, f in fields.items():
        if f.stop:
            continue
        if key not in STORED_FIELDS:
            problems.append(f"field {key}: no column of the spec table stores it (known: {', '.join(sorted(STORED_FIELDS))}); "
                            "add the column to SpecTable first or mark the entry as a stop label")
    return problems


def compose_template(base: SpecTemplate, fields: dict[str, FieldDef]) -> SpecTemplate:
    """The OCR template with its field rules taken from the dictionary (table order = `order`)."""
    if not fields:
        return base
    rules = [r for key, f in sorted(fields.items(), key=lambda kf: (kf[1].order, kf[0])) if (r := f.to_rule(key)) is not None]
    return base.model_copy(update={"fields": rules})


def seed_fields() -> dict[str, FieldDef]:
    """The built-in template as dictionary entries (what the seed ships)."""
    out: dict[str, FieldDef] = {}
    stops = 0
    for i, r in enumerate(DEFAULT_FIELDS):
        if r.field is None:
            stops += 1
            key = "stop_" + "".join(ch if ch.isalnum() else "_" for ch in r.label.lower()).strip("_")[:40]
            out[key] = FieldDef(name=r.label, label=r.label, section=r.section, stop=True, order=(i + 1) * 10)
            continue
        out[r.field] = FieldDef(
            name=r.field.replace("_mm", "").replace("_", " ").capitalize(), label=r.label, aliases=r.aliases, kind=r.kind,
            options=r.options, unit="mm" if r.field.endswith("_mm") else "", min=r.min, max=r.max, optional=r.optional,
            section=r.section, multiline=r.multiline, keep_chars=r.keep_chars, confirm_with_filename=r.confirm_with_filename,
            order=(i + 1) * 10,
        )
    return out
