import pytest

from app.index import formula
from app.index.conditions import Condition, RuleGroup, holds, matches

CTX = {
    "spec": {"sealing_type": "Stand-up", "gusset_type": "Bottom", "zipper": True, "gusset_full_width_mm": 120,
             "tear_notch": "V Notch", "layers_text": "18 mic MATT BOPP / 12 mic Met Pet"},
    "measured": {"height_segments_mm": [10, 12, 13, 267, 10]},
    "panels": ["back", "front", "gusset"],
}


def lookup(ns, name):
    if ns:
        return CTX.get(ns, {}).get(name)
    return {"top_seal_mm": 10}.get(name)


@pytest.mark.parametrize("expr, expected", [
    ("spec.gusset_full_width_mm / 2", 60),
    ("measured.height_segments_mm[0] + measured.height_segments_mm[1]", 22),
    ("measured.height_segments_mm[-1]", 10),
    ("6 if spec.zipper else 0", 6),
    ("max(top_seal_mm, 8) * 2", 20),
    ("sum(measured.height_segments_mm)", 312),
    ("spec.tear_notch == 'V Notch' and not false", True),
])
def test_evaluate(expr, expected):
    assert formula.evaluate(expr, lookup) == expected


def test_missing_values_fall_through():
    with pytest.raises(formula.MissingValue):
        formula.evaluate("spec.circumference_mm / 2", lookup)
    with pytest.raises(formula.MissingValue):
        formula.evaluate("measured.height_segments_mm[9]", lookup)


@pytest.mark.parametrize("expr", [
    "__import__('os').system('x')", "open('/etc/passwd')", "spec.__class__", "(lambda: 1)()",
    "top_seal_mm.real", "[x for x in measured.height_segments_mm]", "max(1, key=abs)", "spec.gusset_full_width_mm +",
])
def test_forbidden_or_invalid(expr):
    with pytest.raises(formula.FormulaError):
        formula.parse(expr)


def test_references():
    assert formula.references("spec.a + measured.b[0] + c * max(d, 1)") == {("spec", "a"), ("measured", "b"), ("", "c"), ("", "d")}


@pytest.mark.parametrize("cond, expected", [
    (Condition(field="spec.sealing_type", op="eq", value="stand up"), True),
    (Condition(field="spec.sealing_type", op="contains", value="STAND"), True),
    (Condition(field="spec.sealing_type", op="in", value=["pillow", "stand_up"]), True),
    (Condition(field="spec.gusset_type", op="not_in", value=["Side"]), True),
    (Condition(field="spec.zipper", op="is_true"), True),
    (Condition(field="spec.gusset_full_width_mm", op="gt", value=100), True),
    (Condition(field="spec.gusset_full_width_mm", op="lte", value=100), False),
    (Condition(field="spec.missing_field", op="missing"), True),
    (Condition(field="spec.missing_field", op="eq", value="x"), False),
    (Condition(field="spec.missing_field", op="ne", value="x"), True),
    (Condition(field="panels", op="contains", value="gusset"), True),
    (Condition(field="spec.layers_text", op="contains", value=["vmpet", "met pet"]), True),
])
def test_conditions(cond, expected):
    assert holds(cond, CTX) is expected


def test_groups_are_or_of_and():
    stand_up = RuleGroup(all=[Condition(field="spec.sealing_type", op="contains", value="stand"), Condition(field="spec.gusset_type", op="eq", value="Side")])
    zipper = RuleGroup(all=[Condition(field="spec.zipper", op="is_true")])
    assert not matches([stand_up], CTX)
    assert matches([stand_up, zipper], CTX)
