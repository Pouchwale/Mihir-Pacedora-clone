"""Workflow graphs as data: validation rules, layout, the seeded default, node -> step mapping."""

import pytest

from app.index import store
from app.index.fields import seed_fields
from app.index.graph import NODE_STEPS, WorkflowGraph, auto_layout, linear_graph, validate_graph
from app.index.schemas import field_keys
from app.workflow.runner import STEPS, reset_index

TYPES = {"stand_up_bottom_gusset", "roll_stock"}
FIELDS = field_keys(seed_fields())


def graph(nodes, edges, **kw):
    return WorkflowGraph(name="t", nodes=[{"id": n[0], "type": n[1], **(n[2] if len(n) > 2 else {})} for n in nodes],
                         edges=[{"id": f"e{i}", "source": a, "target": b, **(x[0] if x else {})} for i, (a, b, *x) in enumerate(edges)], **kw)


def problems(g, workflows=frozenset()):
    return validate_graph(g, TYPES, FIELDS, set(workflows))


def test_linear_graph_is_valid_and_covers_every_step():
    g = linear_graph()
    assert problems(g) == []
    assert [s for n in g.nodes for s in NODE_STEPS[n.type]] == STEPS


def test_decision_needs_else_and_conditions():
    g = graph([("s", "start"), ("d", "decision"), ("e", "end"), ("e2", "end")],
              [("s", "d"), ("d", "e", {"when": [{"all": [{"field": "spec.zipper", "op": "is_true"}]}]}), ("d", "e2")])
    p = problems(g)
    assert any("ELSE" in x for x in p) and any("no conditions" in x for x in p)
    g.edges[2].otherwise = True
    assert problems(g) == []


def test_every_path_ends_and_nothing_is_unreachable():
    g = graph([("s", "start"), ("p", "prepare"), ("x", "validate"), ("e", "end")], [("s", "p"), ("x", "e")])
    p = problems(g)
    assert any("no outgoing edge" in x and "Prepare" in x for x in p)
    assert any("unreachable" in x and "Validate" in x for x in p)


def test_cycles_and_multiple_starts_are_refused():
    g = graph([("s", "start"), ("a", "validate"), ("b", "resolve_keyline"), ("e", "end")], [("s", "a"), ("a", "b"), ("b", "a")])
    assert any("cycle" in x for x in problems(g))
    two = graph([("s", "start"), ("s2", "start"), ("e", "end")], [("s", "e"), ("s2", "e")])
    assert any("exactly one START" in x for x in problems(two))


def test_references_are_checked():
    g = graph([("s", "start"), ("t", "set_pouch_type", {"pouch_type": "nope"}), ("f", "fetch", {"fields": [{"key": "no_such"}]}),
               ("w", "sub_workflow", {"workflow": "other"}), ("e", "end")], [("s", "t"), ("t", "f"), ("f", "w"), ("w", "e")])
    p = problems(g)
    assert any("'nope' is not in the catalog" in x for x in p)
    assert any("'no_such' is not in the field dictionary" in x for x in p)
    assert any("'other' is not published" in x for x in p)
    g.nodes[1].pouch_type = None  # automatic
    g.nodes[2].fields[0].key = "pouch_height_mm"
    assert problems(g, {"other"}) == []
    assert any("cannot call itself" in x for x in validate_graph(g, TYPES, FIELDS, {"other"}, self_key="other"))


def test_review_branches_need_labels_and_may_end_a_path():
    g = graph([("s", "start"), ("r", "review"), ("e", "end"), ("e2", "end")], [("s", "r"), ("r", "e"), ("r", "e2")])
    assert any("needs a label" in x for x in problems(g))
    g.edges[1].label, g.edges[2].label = "ok", "redo"
    assert problems(g) == []
    terminal = graph([("s", "start"), ("r", "review")], [("s", "r")])
    assert problems(terminal) == []


def test_auto_layout_and_hand_written_graphs_get_positions():
    g = graph([("s", "start"), ("p", "prepare"), ("d", "decision"), ("a", "end"), ("b", "end")],
              [("s", "p"), ("p", "d"), ("d", "a", {"when": [{"all": [{"field": "spec.zipper", "op": "is_true"}]}]}), ("d", "b", {"otherwise": True})])
    xs = {n.id: n.position.x for n in g.nodes}  # laid out by the validator because every position was 0,0
    assert xs["s"] < xs["p"] < xs["d"] < xs["a"] == xs["b"]
    ys = {n.id: n.position.y for n in auto_layout(g).nodes}
    assert ys["a"] != ys["b"]


def test_ids_must_be_unique():
    with pytest.raises(ValueError, match="unique"):
        graph([("s", "start"), ("s", "end")], [])


def test_reset_index_maps_nodes_to_steps():
    g = linear_graph()
    assert STEPS[reset_index(g, "prepare")] == "ingest"
    assert STEPS[reset_index(g, "link_panels")] == "link_panels"
    assert STEPS[reset_index(g, "start")] == "ingest"
    assert reset_index(g, "end") is None


def test_seeded_default_workflow_is_valid(seeded):
    index = store.load_all(seeded)
    g = index["workflow"]["default"]
    assert validate_graph(g, set(index["pouch_type"]), field_keys(index["field"]), set(index["workflow"])) == []
    decisions = [n for n in g.nodes if n.type == "decision"]
    assert [d.question for d in decisions] == ["Pouch or roll?", "Which sealing type?"]
    assert {n.pouch_type for n in g.nodes if n.type == "set_pouch_type"} >= {"roll_stock", "stand_up_bottom_gusset", "three_side_seal", None}
    # publishing a broken graph is refused by the index itself
    broken = g.model_dump(mode="json")
    broken["edges"] = [e for e in broken["edges"] if e["id"] != "e14"]  # the sealing decision loses its ELSE edge
    with pytest.raises(store.IndexError_, match="ELSE"):
        store.save(seeded, "workflow", "default", broken, store.Author(None, "admin@example.com"), "x")


def test_field_dictionary_composes_the_ocr_template(seeded):
    from app.pdf.profile import PdfProfile
    from app.workflow.context import compose_profile

    index = store.load_all(seeded)
    profile = compose_profile(PdfProfile(), index["field"])
    rules = {r.field: r for r in profile.spec_template.fields if r.field}
    assert rules["sealing_type"].canonical("Standy") == "Stand-up" and "Standy" in rules["sealing_type"].all_options()
    assert [r.label for r in profile.spec_template.fields if r.field is None] == ["Note that exact colour matching", "Please review this document", "Tolerances", "Other Notes"]
    # a dictionary key that no column stores is refused
    with pytest.raises(store.IndexError_, match="no column"):
        store.save(seeded, "field", "pouch_colour", {"name": "Colour", "label": "Colour:"}, store.Author(None, "admin@example.com"), "x")
