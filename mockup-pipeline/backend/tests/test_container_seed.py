"""Containers shipped in the seed: every 3D model they name ships with them and reaches storage, and the
GHEE SPECIAL SHAPE container (an uploaded model) is offered and carries its sleeve."""

import hashlib

import yaml

from app import cli
from app.geometry import glb_shape
from app.geometry import sleeve as sleeve_geo
from app.index import store
from app.index.schemas import Container
from app.storage import LocalStorage

SEED_CONTAINERS = yaml.safe_load(cli.SEED.read_text(encoding="utf-8"))["container"]


def _model(key: str) -> bytes:
    return (cli.SEED_MODELS / key.split("/", 1)[1]).read_bytes()


def test_every_seed_container_model_ships_with_the_seed():
    for name, data in SEED_CONTAINERS.items():
        c = Container.model_validate(data)
        if c.model:
            body = _model(c.model)
            assert hashlib.sha256(body).hexdigest() == c.model.split("/")[1][:-4], name
            glb_shape.measure(body)  # readable as jobs and the 3D view read it


def test_ghee_special_shape_entry():
    c = Container.model_validate(SEED_CONTAINERS["ghee_special_shape"])
    assert (c.name, c.shape, c.material, c.priority, c.default, c.lid) == ("GHEE SPECIAL SHAPE", "bottle", "plastic", 50, False, False)
    assert (c.sleeve_from, c.sleeve_to, c.min_height_ratio, c.neck_ratio) == (0.05, 0.95, 0.5, 0.4)
    assert (c.body_color, c.cap_color, c.match_words) == ("#c9ccd1", "#d9dce1", [])
    assert c.model == "containers/0fa7f91a18a55e12ddea00ff533966b02acbd2cd7c4000b73aeb208971cc2827.glb"


def test_sleeve_on_ghee_special_shape(seeded):
    containers = store.load_all(seeded)["container"]
    assert "ghee_special_shape" in containers
    measure = lambda key: glb_shape.measure(_model(key))  # noqa: E731
    s = sleeve_geo.build(containers, "ghee_special_shape", "FGSL4100 Ghee 1 ltr", 230.0, 120.0, 113.5, measure_model=measure)
    assert (s.container, s.chosen_by, s.model) == ("ghee_special_shape", "job", containers["ghee_special_shape"].model)
    assert s.model_top and 0 < s.sleeve_from < s.sleeve_to <= s.model_top
    # no match words: a ghee item still gets the Ghee pot automatically
    assert sleeve_geo.pick_container(containers, None, "Pure Cow Ghee 500 ml")[0] == "ghee_pot"


def test_seed_models_reach_storage(tmp_path, monkeypatch):
    storage = LocalStorage(tmp_path / "storage")
    monkeypatch.setattr("app.storage.get_storage", lambda: storage)
    added = cli.seed_models()
    key = SEED_CONTAINERS["ghee_special_shape"]["model"]
    assert key in added and storage.get_bytes(key) == _model(key)
    assert cli.seed_models() == []  # already there: nothing written again
