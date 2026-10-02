"""Safe expressions for keyline formulas, e.g. "spec.gusset_full_width_mm / 2".

Only a whitelisted subset of Python expression syntax is evaluated (no calls except the listed
functions, no attribute access except the spec./measured. namespaces, no imports, no dunders).
Names resolve through a callback so the resolver can evaluate other keyline fields on demand.
"""

import ast
import math
import operator
from collections.abc import Callable
from typing import Any


class FormulaError(ValueError):
    """The expression is invalid (syntax, forbidden construct). Reported to the admin on save."""


class MissingValue(LookupError):
    """A referenced value is not available for this job; the resolver falls through to the next source."""

    def __init__(self, name: str):
        super().__init__(name)
        self.name = name


NAMESPACES = ("spec", "measured")
FUNCTIONS: dict[str, Callable] = {
    "min": min, "max": max, "abs": abs, "round": round, "sum": sum, "len": len,
    "ceil": math.ceil, "floor": math.floor,
}
_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow}
_CMP = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt, ast.LtE: operator.le,
        ast.Gt: operator.gt, ast.GtE: operator.ge}
_CONSTANTS = {"true": True, "false": False, "none": None, "True": True, "False": False, "None": None}

# lookup(namespace, name): namespace is "spec", "measured" or "" for another keyline field.
Lookup = Callable[[str, str], Any]


def parse(expression: str) -> ast.Expression:
    try:
        tree = ast.parse(expression.strip(), mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"Syntax error in {expression!r}: {exc.msg}") from exc
    _check(tree.body)
    return tree


def references(expression: str) -> set[tuple[str, str]]:
    """(namespace, name) pairs the expression reads."""
    refs: set[tuple[str, str]] = set()
    for node in ast.walk(parse(expression).body):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            refs.add((node.value.id, node.attr))
        elif isinstance(node, ast.Name) and node.id not in NAMESPACES and node.id not in FUNCTIONS and node.id not in _CONSTANTS:
            refs.add(("", node.id))
    return refs


def evaluate(expression: str, lookup: Lookup) -> Any:
    return _eval(parse(expression).body, lookup)


def _check(node: ast.AST) -> None:
    allowed = (ast.Constant, ast.Name, ast.Attribute, ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare,
               ast.IfExp, ast.Call, ast.Subscript, ast.List, ast.Tuple, ast.Load,
               *_BIN.keys(), *_CMP.keys(), ast.USub, ast.UAdd, ast.Not, ast.And, ast.Or, ast.In, ast.NotIn)
    for child in ast.walk(node):
        if not isinstance(child, allowed):
            raise FormulaError(f"Not allowed in a formula: {type(child).__name__}")
        if isinstance(child, ast.Attribute):
            if not (isinstance(child.value, ast.Name) and child.value.id in NAMESPACES) or child.attr.startswith("_"):
                raise FormulaError(f"Only {', '.join(n + '.<field>' for n in NAMESPACES)} may use '.'")
        if isinstance(child, ast.Call):
            if not (isinstance(child.func, ast.Name) and child.func.id in FUNCTIONS) or child.keywords:
                raise FormulaError(f"Only these functions are allowed: {', '.join(FUNCTIONS)}")
        if isinstance(child, ast.Name) and child.id.startswith("_"):
            raise FormulaError(f"Invalid name {child.id!r}")


def _eval(node: ast.AST, lookup: Lookup) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in _CONSTANTS:
            return _CONSTANTS[node.id]
        return _value(lookup("", node.id), node.id)
    if isinstance(node, ast.Attribute):
        return _value(lookup(node.value.id, node.attr), f"{node.value.id}.{node.attr}")
    if isinstance(node, ast.BinOp):
        return _BIN[type(node.op)](_eval(node.left, lookup), _eval(node.right, lookup))
    if isinstance(node, ast.UnaryOp):
        v = _eval(node.operand, lookup)
        return -v if isinstance(node.op, ast.USub) else +v if isinstance(node.op, ast.UAdd) else not v
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            return all(_eval(v, lookup) for v in node.values)
        return any(_eval(v, lookup) for v in node.values)
    if isinstance(node, ast.Compare):
        left = _eval(node.left, lookup)
        for op, comparator in zip(node.ops, node.comparators):
            right = _eval(comparator, lookup)
            ok = (left in right) if isinstance(op, ast.In) else (left not in right) if isinstance(op, ast.NotIn) else _CMP[type(op)](left, right)
            if not ok:
                return False
            left = right
        return True
    if isinstance(node, ast.IfExp):
        return _eval(node.body, lookup) if _eval(node.test, lookup) else _eval(node.orelse, lookup)
    if isinstance(node, ast.Call):
        return FUNCTIONS[node.func.id](*(_eval(a, lookup) for a in node.args))
    if isinstance(node, ast.Subscript):
        seq = _eval(node.value, lookup)
        index = _eval(node.slice, lookup)
        try:
            return seq[index]
        except (IndexError, KeyError, TypeError) as exc:
            raise MissingValue(f"{ast.unparse(node)}") from exc
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_eval(e, lookup) for e in node.elts]
    raise FormulaError(f"Not allowed in a formula: {type(node).__name__}")


def _value(value: Any, name: str) -> Any:
    if value is None:
        raise MissingValue(name)
    return value
