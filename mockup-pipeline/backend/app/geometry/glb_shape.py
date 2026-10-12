"""A sleeve container's uploaded 3D model (GLB), measured the way the 3D view fits it (frontend
three/pouch.ts fittedModel): which way is up, how tall it is for its girth, and where a lid starts. The
job's sizes (container height, the sleeve's place, the job page's "Above / Below the sleeve") then
describe the model as it is drawn, not a made-up height."""

import json
import math
import struct
from functools import lru_cache

import numpy as np

SECTORS = 24
BINS = 200
_TYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _accessor(g: dict, binary: bytes, index: int) -> np.ndarray:
    a = g["accessors"][index]
    view = g["bufferViews"][a["bufferView"]]
    dtype, width = np.dtype(_TYPES[a["componentType"]]), _WIDTH[a["type"]]
    start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = view.get("byteStride") or dtype.itemsize * width
    rows = np.ndarray((a["count"], width), dtype, binary, start, (stride, dtype.itemsize))
    return rows.astype(np.float64) if width > 1 else rows.reshape(-1).astype(np.int64)


def _matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.array(node["matrix"], float).reshape(4, 4).T  # (column-major in the file)
    t, (x, y, z, w), s = node.get("translation", [0, 0, 0]), node.get("rotation", [0, 0, 0, 1]), node.get("scale", [1, 1, 1])
    r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    m = np.eye(4)
    m[:3, :3] = r * np.array(s, float)
    m[:3, 3] = t
    return m


def surface_points(data: bytes) -> np.ndarray:
    """Every vertex, in world space, plus points along every triangle edge (a wall drawn as tall faces has
    vertices at a few heights only), N x 3."""
    if data[:4] != b"glTF":
        raise ValueError("not a GLB file")
    json_len = struct.unpack_from("<I", data, 12)[0]
    g = json.loads(data[20:20 + json_len])
    binary = data[20 + json_len + 8:] if len(data) > 20 + json_len + 8 else b""
    meshes: list[tuple[np.ndarray, np.ndarray | None]] = []

    def walk(i: int, parent: np.ndarray) -> None:
        node = g["nodes"][i]
        world = parent @ _matrix(node)
        if "mesh" in node:
            for p in g["meshes"][node["mesh"]]["primitives"]:
                if "POSITION" not in p.get("attributes", {}):
                    continue
                pos = _accessor(g, binary, p["attributes"]["POSITION"])[:, :3]
                pos = pos @ world[:3, :3].T + world[:3, 3]
                tri = None
                if p.get("mode", 4) == 4:
                    tri = (_accessor(g, binary, p["indices"]) if "indices" in p else np.arange(len(pos))).reshape(-1, 3)
                meshes.append((pos, tri))
        for c in node.get("children", []):
            walk(c, world)

    scene = g.get("scenes", [{}])[g.get("scene", 0)] if g.get("scenes") else {"nodes": list(range(len(g.get("nodes", []))))}
    for i in scene.get("nodes", []):
        walk(i, np.eye(4))
    if not meshes:
        raise ValueError("the model has no geometry")
    corners = np.vstack([m[0] for m in meshes])
    out = [corners]
    if sum(len(t) for _, t in meshes if t is not None) > 60000:
        return corners  # a detailed model's vertices already reach every slice (same rule as pouch.ts fittedModel)
    step = float(np.ptp(corners, axis=0).max()) / 300
    for pos, tri in meshes:
        if tri is None or not len(tri):
            continue
        for c in range(3):
            a, b = pos[tri[:, c]], pos[tri[:, (c + 1) % 3]]
            n = np.minimum(64, (np.linalg.norm(b - a, axis=1) / step).astype(int))
            for k in range(1, int(n.max(initial=0))):
                sel = n > k
                out.append(a[sel] + (b[sel] - a[sel]) * (k / n[sel])[:, None])
    return np.vstack(out)


def _slices(p: np.ndarray, axis: int, bins: int) -> tuple[np.ndarray, float, float, float]:
    """Along `axis`: the radius at each slice (median of 24 sectors' outermost points; 0 = no reading),
    how round the slices are (lower is rounder), and the extent along the axis."""
    u, w = [a for a in range(3) if a != axis]
    lo, hi = p[:, axis].min(), p[:, axis].max()
    cu, cw = (p[:, u].min() + p[:, u].max()) / 2, (p[:, w].min() + p[:, w].max()) / 2
    du, dw = p[:, u] - cu, p[:, w] - cw
    b = np.round((p[:, axis] - lo) / ((hi - lo) or 1) * bins).astype(int)
    s = np.minimum(SECTORS - 1, ((np.arctan2(dw, du) + math.pi) / (2 * math.pi) * SECTORS).astype(int))
    cells = np.zeros((bins + 1, SECTORS))
    np.maximum.at(cells, (b, s), np.hypot(du, dw))
    radius, spread = np.zeros(bins + 1), []
    for i in range(bins + 1):
        row = np.sort(cells[i][cells[i] > 0])
        if len(row) < SECTORS / 2:
            continue
        radius[i] = row[len(row) // 2]
        spread.append(row.std() / (row.mean() or 1))
    return radius, (float(np.mean(spread)) if spread else math.inf), float(lo), float(hi)


def measure(data: bytes) -> tuple[float, float, int]:
    """(height / widest diameter, share of the height where a lid starts, the up axis 0 x / 1 y / 2 z)."""
    p = surface_points(data)
    score = [_slices(p, a, 40)[1] * (0.85 if a == 1 else 1) for a in range(3)]
    up = int(np.argmin(score))
    prof, _, lo, hi = _slices(p, up, BINS)
    filled = np.nonzero(prof)[0]
    if not len(filled):
        raise ValueError("no round cross-section found")
    prof = np.interp(np.arange(BINS + 1), filled, prof[filled])

    def average(a: np.ndarray, w: int) -> np.ndarray:
        return np.array([a[max(0, i - w):i + w + 1].mean() for i in range(BINS + 1)])

    smooth = np.maximum(average(np.maximum(average(prof, 5), prof), 2), prof)  # smooth, never inside the surface
    widest = int(np.argmax(smooth))
    neck, lid = widest, BINS
    for i in range(widest + 1, BINS + 1):
        if smooth[i] < smooth[neck]:
            neck = i
        # a lid: a clearly narrow neck in the upper part, anything wider above it (a waisted bottle's middle
        # is no lid; the ghee pot's rim is only 2.6 % wider than its neck). Same rule as pouch.ts fittedModel.
        elif smooth[i] > smooth[neck] * 1.015 and smooth[neck] < 0.88 * smooth[widest] and neck >= 0.55 * BINS:
            lid = neck
            break
    return (hi - lo) / (2 * float(smooth.max())), lid / BINS, up


@lru_cache(maxsize=32)
def measure_stored(key: str) -> tuple[float, float, int]:
    """`measure` of an uploaded model by its storage key (kept by content hash, so the cache never goes stale)."""
    from app.storage import get_storage

    return measure(get_storage().get_bytes(key))

