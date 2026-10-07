// Parametric pouch geometry (spec 5). 1 unit = 1 mm. y is up, the pouch stands on y = 0,
// centred on x = 0, the front faces +z.
//
// Film faces are grids with UVs that equal the printed panel (u across, v bottom -> top), so artwork
// lands exactly where it prints. In the filled state each row of a face keeps its film length
// (arc-length placement): the body pulls in as it bulges instead of stretching the print, seals stay
// flat, and the height stays the printed height. "Flat" is the pouch as manufactured.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { bakedTexture } from "./bake";
import spoutCapUrl from "./spout_cap.glb?url";
import { cutMask, hasWindow, insideField, materialMaps, normalMap, outlineCanvas, paintWindows, PX_PER_MM } from "./surface";
import type { GeometrySpec, SceneTexture } from "./types";

export interface BuildOptions {
  filled: boolean;
}

const FILM = 0.12; // half film thickness: front and back never z-fight in the seals
const loader = new THREE.TextureLoader();

// ---------------------------------------------------------------- helpers
function smooth(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** Cross-section shape across the body: 1 at the centre, 0 at the fold / seal line. */
function prof(xi: number, m = 2.0, n = 1.7) {
  const a = Math.min(1, Math.abs(xi));
  return Math.pow(Math.max(0, 1 - Math.pow(a, m)), 1 / n);
}

function arcLen(a: number, d: number, m: number, n: number, steps = 64) {
  let len = 0, px = -a, pz = 0;
  for (let i = 1; i <= steps; i++) {
    const x = -a + (2 * a * i) / steps;
    const z = d * prof(x / a, m, n);
    len += Math.hypot(x - px, z - pz);
    px = x; pz = z;
  }
  return len;
}

/** Half width `a` of a body whose curved film length is `L` at half-depth `d`. */
function solveHalfWidth(L: number, d: number, m: number, n: number) {
  if (d < 0.05) return L / 2;
  let lo = 0.05 * L, hi = L / 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (arcLen(mid, d, m, n) > L) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Sample a body row: returns x,z at film distance t in [0, L] along the curve. */
function rowSampler(a: number, d: number, m: number, n: number) {
  const N = 160;
  const xs = new Float64Array(N + 1), zs = new Float64Array(N + 1), cum = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    // denser near the ends where the curve turns
    const s = -Math.cos((Math.PI * i) / N);
    xs[i] = a * s;
    zs[i] = d * prof(s, m, n);
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  const total = cum[N];
  return (t: number): [number, number] => {
    const target = Math.max(0, Math.min(1, t)) * total;
    let lo = 0, hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid;
      else hi = mid;
    }
    const f = (target - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
    return [lerp(xs[lo], xs[hi], f), lerp(zs[lo], zs[hi], f)];
  };
}

function sortedUnique(values: number[]) {
  return [...new Set(values.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 1e6) / 1e6))].sort((a, b) => a - b);
}

/** Grid mesh from a position function over (u, v) sample lists. */
function gridGeometry(us: number[], vs: number[], pos: (u: number, v: number) => [number, number, number], flip = false) {
  const nu = us.length, nv = vs.length;
  const positions = new Float32Array(nu * nv * 3);
  const uvs = new Float32Array(nu * nv * 2);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const [x, y, z] = pos(us[i], vs[j]);
      const k = j * nu + i;
      positions.set([x, y, z], k * 3);
      uvs.set([us[i], vs[j]], k * 2);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i, b = a + 1, c = a + nu, d = c + 1;
      if (flip) index.push(a, c, b, b, c, d);
      else index.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- materials
interface FaceMaps {
  alpha?: THREE.Texture | null;
  normal?: THREE.Texture | null;
  window?: boolean; // `alpha` is a window mask (clear film in parts), not a cut
}

// Artwork textures are large (up to 4096 px): load each URL once and share it between rebuilds.
const textureCache = new Map<string, Promise<THREE.Texture>>();
export const cachedTextures = new Set<THREE.Texture>();

async function loadTexture(url: string): Promise<THREE.Texture> {
  if (!textureCache.has(url)) {
    textureCache.set(url, loader.loadAsync(url).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      cachedTextures.add(t);
      return t;
    }));
  }
  return textureCache.get(url)!;
}

/** A grayscale mask used as transparency (linear, not colour). */
async function loadMask(url: string): Promise<THREE.Texture> {
  const key = `mask:${url}`;
  if (!textureCache.has(key)) {
    textureCache.set(key, loader.loadAsync(url).then((t) => {
      t.colorSpace = THREE.NoColorSpace;
      cachedTextures.add(t);
      return t;
    }));
  }
  return textureCache.get(key)!;
}

/** Free a replaced model's GPU resources (shared artwork textures are kept). */
export function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      for (const v of Object.values(m)) {
        if (v instanceof THREE.Texture && !cachedTextures.has(v)) v.dispose();
      }
      m.dispose();
    }
  });
}

/** "exact" lighting: artwork is drawn unlit, every pixel the print colour; no tone mapping. */
export function unlit(g: GeometrySpec): boolean {
  return g.preset.lighting === "exact";
}

/** The artwork texture of a panel with the job page's adjustments applied: a replacement picture,
 *  colour correction and overlays are drawn into a canvas (the texture step bakes the same into
 *  the finished image); turn, flip, move and scale are a texture matrix, which the renders and the
 *  GLB (KHR_texture_transform) apply as well. */
async function panelMap(tex: SceneTexture): Promise<THREE.Texture> {
  const base = tex.bake ? await bakedTexture(tex, tex.bake) : await loadTexture(tex.url);
  const t = tex.transform;
  if (!t || (t.rotation % 360 === 0 && !t.flip_x && !t.flip_y && !t.offset_x_mm && !t.offset_y_mm && (t.scale ?? 1) === 1)) return base;
  const m = base.clone();
  m.needsUpdate = true;
  m.center.set(0.5, 0.5);
  m.rotation = (t.rotation * Math.PI) / 180;
  const s = 1 / (t.scale || 1);
  m.repeat.set((t.flip_x ? -1 : 1) * s, (t.flip_y ? -1 : 1) * s);
  m.offset.set(-(t.offset_x_mm || 0) / tex.width_mm, -(t.offset_y_mm || 0) / tex.height_mm);
  m.wrapS = m.wrapT = THREE.ClampToEdgeWrapping;
  return m;
}

async function filmMaterial(g: GeometrySpec, tex: SceneTexture, maps: FaceMaps): Promise<THREE.Material> {
  const base = g.materials.surfaces.base ?? {};
  if (tex.clear) {
    // unprinted clear film ("Window" side / gusset): the job's window settings, else clear PE
    const w = g.materials.surfaces.window ?? {};
    const clear = unlit(g)
      ? new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })
      : new THREE.MeshPhysicalMaterial({ color: "#ffffff", transmission: w.transmission ?? 0.92, opacity: w.opacity ?? 0.35, transparent: true,
          roughness: w.roughness ?? 0.08, ior: w.ior ?? 1.5, metalness: 0, side: THREE.DoubleSide, depthWrite: false });
    clear.name = "film";
    return clear;
  }
  // a side / gusset with a window left unprinted (texture step: masks.window): clear film there
  if (!maps.alpha && tex.masks.window) maps = { ...maps, alpha: await loadMask(tex.masks.window), window: true };
  const clearParts = hasWindow(g) || !!maps.window;
  if (unlit(g)) {
    const flat = new THREE.MeshBasicMaterial({ map: await panelMap(tex), side: THREE.DoubleSide, toneMapped: false });
    if (maps.alpha) {
      flat.alphaMap = maps.alpha;
      flat.alphaTest = clearParts ? 0.05 : 0.5;
      if (clearParts) flat.transparent = true;
    }
    flat.name = "film";
    plainInside(flat, g);
    return flat;
  }
  const mat = new THREE.MeshPhysicalMaterial({
    roughness: base.roughness ?? 0.5,
    metalness: base.metalness ?? 0,
    clearcoat: base.clearcoat ?? 0,
    clearcoatRoughness: base.clearcoat_roughness ?? 0.1,
    specularIntensity: base.specular_intensity ?? 0.5,
    side: THREE.DoubleSide,
    envMapIntensity: 1,
  });
  mat.map = await panelMap(tex);
  if (maps.normal) {
    mat.normalMap = maps.normal;
    const s = base.normal_scale ?? 0.35;
    mat.normalScale = new THREE.Vector2(s, s);
  }
  if (maps.alpha) {
    mat.alphaMap = maps.alpha;
    if (clearParts) {
      mat.transparent = true;
      mat.alphaTest = 0.05;
      mat.depthWrite = true;
    } else {
      mat.alphaTest = 0.5;
    }
  }
  const mixed = await materialMaps(base, g.materials.surfaces.white_less, g.materials.surfaces.spot, tex.masks.metal, tex.masks.spot);
  if (mixed) {
    mat.roughness = 1;
    mat.roughnessMap = mixed.rough;
    if (mixed.metal) {
      mat.metalness = g.materials.surfaces.white_less?.metalness ?? 1;
      mat.metalnessMap = mixed.metal;
    }
    if (mixed.coat) {
      mat.clearcoat = 1;
      mat.clearcoatMap = mixed.coat;
    }
  }
  mat.name = "film";
  plainInside(mat, g);
  return mat;
}

/** The film's inside is its plain inner layer, white (silver on metallised film), never the print seen
 * backwards: a window on one face looks into the pouch and saw the other face's artwork mirrored.
 * Which side of a mesh is outside is set per mesh by outsideFaces (panels are wound either way). */
function plainInside(mat: THREE.Material, g: GeometrySpec) {
  const inside = new THREE.Color(g.materials.surfaces.white_less ? "#cfd2d6" : "#f3f3f0");
  const outsideFront = { value: true };
  mat.userData.outsideFront = outsideFront;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.insideColor = { value: inside };
    shader.uniforms.outsideFront = outsideFront;
    shader.fragmentShader = "uniform vec3 insideColor;\nuniform bool outsideFront;\n" + shader.fragmentShader.replace(
      "#include <map_fragment>", "#include <map_fragment>\n  if (gl_FrontFacing != outsideFront) diffuseColor.rgb = insideColor;\n"
      // a clear window (alpha mask below half) keeps a faint sheen of plain film, not a ghost of the print
      + "#ifdef USE_ALPHAMAP\n  if (texture2D(alphaMap, vAlphaMapUv).g < 0.5) diffuseColor.rgb = vec3(1.0);\n#endif");
  };
  mat.customProgramCacheKey = () => `inside:${inside.getHexString()}`;
  mat.forceSinglePass = true; // two passes (see-through double-sided film) flip gl_FrontFacing
}

/** For each film mesh: is its outside the triangles' front side? Their winding normals, summed against
 * the direction away from the pouch's centre, say which way the mesh was built. */
function outsideFaces(grp: THREE.Group) {
  grp.updateMatrixWorld(true);
  const centre = new THREE.Box3().setFromObject(grp).getCenter(new THREE.Vector3());
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  grp.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const flag = mesh.isMesh ? ((mesh.material as THREE.Material).userData?.outsideFront as { value: boolean } | undefined) : undefined;
    if (!flag) return;
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    let sum = 0;
    for (let i = 0; i + 2 < count; i += 3) {
      const [i0, i1, i2] = index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2];
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      n.subVectors(c, b).cross(m.subVectors(a, b)); // = (b - a) x (c - a): the front side's normal, area-weighted
      m.copy(a).add(b).add(c).divideScalar(3).sub(centre);
      sum += n.dot(m);
    }
    flag.value = sum >= 0;
  });
}

function plasticMaterial(g: GeometrySpec, color = "#f4f4f2", roughness = 0.35): THREE.Material {
  if (unlit(g)) return new THREE.MeshBasicMaterial({ color, toneMapped: false, name: "plastic" });
  return new THREE.MeshPhysicalMaterial({ color, roughness, clearcoat: 0.4, clearcoatRoughness: 0.2, name: "plastic" });
}

/** A plain-colour or textured surface that is not artwork film (roll core, roll ends, product). */
function solidMaterial(g: GeometrySpec, opts: { color?: string; map?: THREE.Texture; roughness?: number; metalness?: number; side?: THREE.Side }): THREE.Material {
  if (unlit(g)) return new THREE.MeshBasicMaterial({ color: opts.color ?? "#ffffff", map: opts.map, side: opts.side ?? THREE.FrontSide, toneMapped: false });
  return new THREE.MeshStandardMaterial({ color: opts.color ?? "#ffffff", map: opts.map, roughness: opts.roughness ?? 0.5, metalness: opts.metalness ?? 0, side: opts.side ?? THREE.FrontSide });
}

// ---------------------------------------------------------------- depth profiles
// Depth / full depth every 1/17 of the swell length from the seal edge (Pacdora center_seal.obj).
const PILLOW_RISE = [0, 0.24, 0.36, 0.43, 0.52, 0.59, 0.66, 0.72, 0.77, 0.82, 0.86, 0.9, 0.92, 0.95, 0.97, 0.98, 0.99, 1];
// Gusset opening / full depth every 0.234 gusset widths from the seal (Pacdora two_side_gusset.obj).
const GUSSET_RISE = [0, 0.2, 0.5, 0.69, 0.81, 0.9, 0.94, 0.97, 0.99, 1];
function gussetRise(sInGussets: number) {
  const x = Math.max(0, sInGussets / 0.234);
  if (x >= GUSSET_RISE.length - 1) return 1;
  const i = Math.floor(x);
  return lerp(GUSSET_RISE[i], GUSSET_RISE[i + 1], x - i);
}

function pillowRise(s: number) {
  const x = Math.max(0, Math.min(1, s)) * (PILLOW_RISE.length - 1);
  const i = Math.min(PILLOW_RISE.length - 2, Math.floor(x));
  return lerp(PILLOW_RISE[i], PILLOW_RISE[i + 1], x - i);
}
interface Profile {
  depth: (y: number) => number; // half thickness of the body at height y
  base: number; // half depth of the stand-up base at y = 0 (0 = no base)
}

function profileFor(g: GeometrySpec, filled: boolean, shape: string): Profile {
  if (!filled) return { depth: () => 0, base: 0 };
  const W = g.width_mm, H = g.height_mm;
  const fill = Math.max(0.2, Math.min(1, (g.fill_level_percent || 85) / 100));
  const dMid = (g.body_bulge_percent / 100) * W;
  const top = Math.max(g.seals.top, g.seals.crimp);
  const zipTop = g.zipper.enabled ? Math.max(top, g.zipper.y_from_top_mm) : top;
  const fillY = H * fill; // product level (from the bottom); above it the film relaxes

  if (shape === "stand_up_bottom_gusset") {
    const base = Math.max(0, Math.min(g.gusset_depth_mm * 0.65, dMid * 2.0)) * Math.sqrt(fill);
    return {
      base,
      depth: (y) => {
        const fromTop = H - y;
        if (fromTop <= top) return 0;
        const pre = fromTop < zipTop ? 1.2 : 0; // two layers above the zipper stay close
        const rise = smooth(zipTop, zipTop + 0.24 * H, fromTop);
        const product = lerp(0.55, 1, smooth(fillY + 0.08 * H, fillY - 0.1 * H, y));
        const body = lerp(base, dMid, smooth(0, 0.34 * H, y)) * product;
        return Math.max(pre, body * rise);
      },
    };
  }
  const bottom = Math.max(g.seals.bottom, g.seals.crimp);
  if (shape === "center_seal_pillow") {
    // Swell measured on the Pacdora clone's sculpted 200 x 299 mm pillow pack (frontend/public/models/
    // center_seal.obj): steep out of the crimp, full depth after ~42 % of the height.
    const rise = (from: number) => pillowRise(from / (0.425 * H));
    return {
      base: 0,
      depth: (y) => {
        const fromTop = H - y;
        if (fromTop <= top || y <= bottom) return 0;
        // above the product the film relaxes but stays rounded (a pillow never tapers to a point)
        const product = lerp(0.78, 1, smooth(fillY + 0.18 * H, fillY - 0.12 * H, y));
        return dMid * rise(fromTop - top) * rise(y - bottom) * product;
      },
    };
  }
  return {
    base: 0,
    depth: (y) => {
      const fromTop = H - y;
      if (fromTop <= top || y <= bottom) return 0;
      const pre = fromTop < zipTop ? 1.2 : 0;
      const rTop = smooth(zipTop, zipTop + 0.22 * H, fromTop);
      const rBottom = smooth(bottom, bottom + 0.2 * H, y);
      const product = lerp(0.6, 1, smooth(fillY + 0.08 * H, fillY - 0.1 * H, y));
      return Math.max(pre, dMid * rTop * rBottom * product);
    },
  };
}

// ---------------------------------------------------------------- flat-ish pouches (3SS, stand-up, pillow, spout, shaped)
interface FaceBuild {
  front: THREE.BufferGeometry;
  back: THREE.BufferGeometry;
  baseHalf: [number, number] | null; // stand-up base half axes (x, z)
  m: number;
  n: number;
}

function pouchFaces(g: GeometrySpec, filled: boolean, shape: string, inside?: (x: number, y: number) => number): FaceBuild {
  const W = g.width_mm, H = g.height_mm;
  const pillow = shape === "center_seal_pillow";
  const s = pillow ? 0 : g.seals.side;
  const bodyL = W - 2 * s;
  const pr = profileFor(g, filled, shape);
  // Pillow edges are round folds (ellipse); sealed edges meet at an angle (lens section, finite slope).
  const m = 2.0, n = pillow ? 2.0 : 1 / 0.9;

  // rows: uniform + exact feature lines
  const vs = sortedUnique([
    ...Array.from({ length: 181 }, (_, i) => i / 180),
    ...[g.seals.top, g.seals.crimp, g.zipper.y_from_top_mm - 2, g.zipper.y_from_top_mm, g.zipper.y_from_top_mm + 2, g.tear_notch.y_from_top_mm]
      .filter((v) => v > 0 && v < H).map((v) => 1 - v / H),
    ...[g.seals.bottom, g.seals.crimp].filter((v) => v > 0).map((v) => v / H),
  ]);
  const fw = g.seals.fin / 2;
  const finCols = pillow ? [-fw - 2, -fw, fw - 0.4, fw, fw + 0.4].map((d) => (W / 2 + d) / W) : [];
  const us = sortedUnique([...Array.from({ length: 121 }, (_, i) => i / 120), s / W, 1 - s / W, ...finCols]);

  // per-row solution: half width and a sampler
  const rows = new Map<number, { a: number; d: number; sample: (t: number) => [number, number] }>();
  // Film cannot bulge further than its sides can pull in: a filled pack's waist stays at >= 74 % of
  // its flat width (Pacdora's sculpted pillow: 0.76). Deeper bulge or fill settings are capped here,
  // so no setting turns the pouch into a round "onion".
  const minA = 0.74 * (bodyL / 2);
  const capDepth = (d: number) => {
    if (solveHalfWidth(bodyL, d, m, n) >= minA) return d;
    let lo = 0, hi = d;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (solveHalfWidth(bodyL, mid, m, n) >= minA) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  for (const v of vs) {
    const y = v * H;
    const d = inside ? 0 : capDepth(pr.depth(y));
    const a = solveHalfWidth(bodyL, d, m, n);
    rows.set(v, { a, d, sample: rowSampler(a, d, m, n) });
  }
  const zipY = g.zipper.enabled ? H - g.zipper.y_from_top_mm : null;
  const ridge = (y: number, d: number) =>
    zipY === null || !filled ? 0 : (g.zipper.ridge_height_mm / 2) * Math.exp(-((y - zipY) ** 2) / 2.5) * Math.min(1, d / 2 + 0.3);
  const finX = pillow ? W / 2 : null;
  const finBulge = (f: number) => {
    if (finX === null) return 0;
    const lift = filled ? 0.9 : 0.35; // two film layers, puffed a little when the pouch is filled
    return lift * smooth(finX - fw - 2, finX - fw + 0.5, f) * (1 - smooth(finX + fw - 0.4, finX + fw + 0.4, f));
  };
  // Fan wrinkles where the filled tube flattens into the crimp seals: folds across the width that are
  // strongest right at the seal and fade into the body (they never break the side folds).
  const crimpTop = Math.max(g.seals.top, g.seals.crimp), crimpBottom = Math.max(g.seals.bottom, g.seals.crimp);
  // Creases fan out of the four crimp corners towards the middle (the look of the Pacdora sculpt):
  // folds by angle around each corner, fading with distance from it and in the full body.
  const fan = (f: number, y: number, d: number, t: number) => {
    if (!pillow || !filled || d < 0.05) return 0;
    const edge = Math.min(1, t * 10, (1 - t) * 10); // not on the side folds themselves
    let z = 0;
    for (const [cx, cy, ph] of [[0, H - crimpTop, 0.3], [W, H - crimpTop, 1.7], [0, crimpBottom, 2.9], [W, crimpBottom, 4.1]]) {
      const dx = f - cx, dy = y - cy, r = Math.hypot(dx, dy);
      if (r > 0.55 * W) continue;
      const ang = Math.atan2(Math.abs(dy), Math.abs(dx)); // 0 along the seal .. pi/2 along the side
      z += Math.exp(-r / (0.2 * W)) * Math.sin(Math.PI * Math.min(1, r / 6)) * (1.3 * Math.sin(ang * 7 + ph) + 0.5 * Math.sin(ang * 17 + 2 * ph));
    }
    return z * edge * Math.min(1, d / 4);
  };

  const place = (u: number, v: number, sign: 1 | -1, fin: boolean): [number, number, number] => {
    const y = v * H;
    const row = rows.get(v)!;
    const f = u * W; // film coordinate from this face's own left edge
    let x: number, z: number;
    if (f <= s) {
      x = -(row.a + s - f); z = 0;
    } else if (f >= W - s) {
      x = row.a + (f - (W - s)); z = 0;
    } else {
      const t = (f - s) / bodyL;
      [x, z] = row.sample(t);
      if (row.d > 0.05) z += ridge(y, row.d) + fan(f, y, row.d, t);
    }
    if (inside) {
      // shaped die-cut: inflation follows the outline (0 at the cut edge)
      const k = inside(f, H - y);
      x = f - W / 2;
      z = filled ? (g.body_bulge_percent / 100) * W * 0.8 * Math.pow(k, 0.7) : 0;
    }
    if (fin) z += finBulge(f);
    // The film offset closes to nothing at the side edges: there front and back are one fold (a pillow)
    // or two layers sealed together, never a see-through slit 2 x FILM wide down the side.
    const closed = Math.min(1, f / 0.5, (W - f) / 0.5);
    // each face's own left edge is at world -x for the front and +x for the back
    return [sign === 1 ? x : -x, y, sign * (z + FILM * closed)];
  };
  const front = gridGeometry(us, vs, (u, v) => place(u, v, 1, false));
  const back = gridGeometry(us, vs, (u, v) => place(u, v, -1, pillow), true);
  const r0 = rows.get(vs[0])!;
  return { front, back, baseHalf: pr.base > 0 ? [r0.a, pr.base] : null, m, n };
}

/** Stand-up base at y = 0 carrying the gusset artwork (centre fold along x). Its outline is the
 *  bottom row of the front / back faces (same profile), so the base meets the panels exactly.
 *  Gusset artwork as printed on the web below the front: its top edge joins the front's bottom
 *  edge and its x runs with the front's x, so the image top maps to the front rim. */
function baseGeometry(W: number, s: number, A: number, B: number, m: number, n: number) {
  const nx = 96, nt = 32;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nt; j++) {
    const t = (j / nt) * 2 - 1; // -1 back rim .. 0 centre fold .. 1 front rim
    for (let i = 0; i <= nx; i++) {
      const xi = -Math.cos((Math.PI * i) / nx); // denser near the corners
      const x = A * xi;
      const z = t * B * prof(xi, m, n);
      // slightly concave (the pouch stands on its rim), with the gusset's centre fold as a soft ridge
      // across the base: the film folded in half shows a crease where the two halves meet
      const p = prof(xi, m, n);
      const crease = 1.6 * Math.exp(-((t * B) ** 2) / 6) * p;
      pos.push(x, 0.15 + 1.2 * (1 - t * t) * p + crease, z);
      uv.push((s + ((xi + 1) / 2) * (W - 2 * s)) / W, 0.5 + 0.5 * t);
    }
  }
  for (let j = 0; j < nt; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- box-like pouches (side gusset, quad, flat bottom)
function boxFaces(g: GeometrySpec, filled: boolean, shape: string, sideH = g.height_mm) {
  const W = g.width_mm, H = g.height_mm;
  const S = g.side_gusset_full_mm || 2 * g.side_gusset_depth_mm || 0.3 * W;
  const cs = shape === "center_seal_side_gusset" ? 0 : g.seals.side; // corner seals (quad / box)
  const X = W / 2 - cs;
  const top = Math.max(g.seals.top, g.seals.crimp);
  // Side gusset and quad seal close into a bottom seal like the top (the Pacdora sculpt); only the
  // flat-bottom box pouch stands on an open, flat base.
  const closedBottom = shape === "center_seal_side_gusset" || shape === "quad_seal";
  const bottomSeal = closedBottom ? Math.max(g.seals.bottom, g.seals.crimp) : 0;
  // Side gusset / quad seal: the gusset unfolds along the curve measured on the Pacdora clone's sculpted
  // model (frontend/public/models/two_side_gusset.obj), gradual over ~1.6 gusset widths from the seal.
  const measured = shape === "center_seal_side_gusset" || shape === "quad_seal";
  const ramp = (from: number) => (measured ? gussetRise(from / S) : smooth(0, 0.55 * S + 0.05 * H, from));
  const open = (y: number) => {
    if (!filled) return 0;
    const fromTop = H - y;
    const t = fromTop <= top ? 0 : ramp(fromTop - top);
    const b = bottomSeal > 0 ? (y <= bottomSeal ? 0 : ramp(y - bottomSeal)) : 1;
    return t * b;
  };
  const bulge = filled ? (g.body_bulge_percent / 100) * W * 0.25 : 0;
  const vs = sortedUnique([...Array.from({ length: 161 }, (_, i) => i / 160), 1 - top / H, bottomSeal / H]);
  const us = sortedUnique([...Array.from({ length: 81 }, (_, i) => i / 80), cs / W, 1 - cs / W]);
  const r = 0.12 * S; // rounded vertical corners when open

  const faceFront = (sign: 1 | -1) =>
    gridGeometry(us, vs, (u, v) => {
      const y = v * H;
      const o = open(y);
      const Zd = (S / 2) * o;
      const f = u * W;
      let x: number, z: number;
      if (f < cs || f > W - cs) {
        // corner seal fin, angled outward at 45 degrees when open
        // corner seal fin: flat in the pouch as made, angled 45 degrees outward when filled
        const e = f < cs ? cs - f : f - (W - cs);
        const dir = f < cs ? -1 : 1;
        const th = (Math.PI / 4) * o;
        x = dir * (X + e * Math.cos(th));
        z = Zd + e * Math.sin(th);
      } else {
        x = f - W / 2;
        const xi = x / X;
        z = Zd + bulge * o * prof(xi, 2, 1.5) - (Math.abs(xi) > 1 - r / X ? (Math.abs(xi) - (1 - r / X)) * X * 0.35 * o : 0);
      }
      return [sign === 1 ? x : -x, y, sign * (z + FILM)];
    }, sign === -1);

  const faceSide = (sideSign: 1 | -1) =>
    gridGeometry(
      sortedUnique(Array.from({ length: 49 }, (_, i) => i / 48)),
      vs,
      (u, v) => {
        const y = v * sideH; // a side drawn taller than the faces (FGPO4003) stands above them, closed
        const o = open(y);
        const w = u * 2 - 1; // -1 at the front edge .. 1 at the back edge (as printed left -> right)
        const Zd = (S / 2) * o;
        const tuck = (1 - o) * (S / 2) * (1 - Math.abs(w)); // folds inward where closed
        const x = X + (bulge * 0.3) * o * (1 - w * w) - tuck + 0.2 * o;
        const z = -w * Zd * sideSign; // right side: printed left edge meets the front
        return [sideSign * x, y, z * 1];
      },
      sideSign === 1,
    );

  return { front: faceFront(1), back: faceFront(-1), right: faceSide(1), left: faceSide(-1), X, S, openBottom: !closedBottom };
}

// ---------------------------------------------------------------- spout
// Flange + collar + ridged cap from the Pacdora clone's center_spout_pouch.glb, baked to mm with the
// axis on +y and the flange on y = 0. Its cap is CAP_D wide and spans CAP_H at the top.
const CAP_D = 13.6, CAP_H = 7.55;
let capGeometry: Promise<THREE.BufferGeometry> | null = null;
function loadCap() {
  capGeometry ??= new GLTFLoader().loadAsync(spoutCapUrl).then((gltf) => (gltf.scene.getObjectByName("spout_cap") as THREE.Mesh).geometry);
  return capGeometry;
}

async function spoutGroup(g: GeometrySpec): Promise<THREE.Group> {
  const sp = g.spout!;
  const grp = new THREE.Group();
  const neckR = sp.diameter_mm / 2;
  // the insert inside the film (the "boat") is hidden unless the film is clear
  const boat = new THREE.Mesh(new THREE.CylinderGeometry(neckR * 1.25, neckR * 1.25, 14, 48), plasticMaterial(g));
  boat.scale.set(1.5, 1, 0.45);
  boat.position.y = -6;
  // ponytail: one stretch for the whole fitting (flange grows with the cap); split the mesh by height
  // if a keyline ever needs a neck much narrower than its cap.
  const cap = new THREE.Mesh(await loadCap(), plasticMaterial(g, "#e8e8e4", 0.45));
  const k = sp.cap_diameter_mm / CAP_D;
  cap.scale.set(k, sp.cap_height_mm / CAP_H, k);
  cap.name = "spout";
  grp.add(boat, cap);
  return grp;
}

// ---------------------------------------------------------------- one-way (coffee) valve
/** A one-way degassing valve as it sits on coffee packs: a flat plastic disc welded to the film, a
 *  raised ring and a domed centre with vent holes. Built facing +z with its base at z = 0. */
function valveGroup(g: GeometrySpec, d: number): THREE.Group {
  const grp = new THREE.Group();
  const r = d / 2;
  const disc = plasticMaterial(g, "#f4f4f1", 0.4);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.6, 64), disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.72, r * 0.07, 12, 64), disc);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(r * 0.5, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), plasticMaterial(g, "#e9e9e5", 0.3));
  base.rotation.x = Math.PI / 2;
  base.position.z = 0.3;
  ring.position.z = 0.7;
  dome.rotation.x = Math.PI / 2;
  dome.scale.set(1, 0.35, 1); // a low dome, ~1.5 mm for a 22 mm valve
  dome.position.z = 0.6;
  grp.add(base, ring, dome);
  const hole = solidMaterial(g, { color: "#3a3a3a", roughness: 0.8 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const h = new THREE.Mesh(new THREE.CircleGeometry(r * 0.06, 16), hole);
    h.position.set(Math.cos(a) * r * 0.24, Math.sin(a) * r * 0.24, 0.6 + r * 0.5 * 0.35 * 0.9);
    grp.add(h);
  }
  grp.name = "valve";
  return grp;
}

/** Put `obj` on a film face at its printed spot (u across from the face's own left edge, v up),
 *  sitting on the surface and turned with it. */
function placeOnFace(face: THREE.Mesh, u: number, v: number, obj: THREE.Object3D) {
  const uv = face.geometry.getAttribute("uv") as THREE.BufferAttribute;
  const pos = face.geometry.getAttribute("position") as THREE.BufferAttribute;
  const nor = face.geometry.getAttribute("normal") as THREE.BufferAttribute;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < uv.count; i++) {
    const d = (uv.getX(i) - u) ** 2 + (uv.getY(i) - v) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  const p = new THREE.Vector3().fromBufferAttribute(pos, best);
  const n = new THREE.Vector3().fromBufferAttribute(nor, best).normalize();
  // the grid's winding may point the normal inward: the outside is away from the pouch's centre line
  if (n.dot(new THREE.Vector3(p.x, 0, p.z)) < 0) n.negate();
  obj.position.copy(p);
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  face.parent?.add(obj);
}

// ---------------------------------------------------------------- roll stock
async function rollGroup(g: GeometrySpec, textures: Record<string, SceneTexture>, filled: boolean): Promise<THREE.Group> {
  const roll = g.roll!;
  const grp = new THREE.Group();
  const R = roll.outer_diameter_mm / 2, r = roll.core_diameter_mm / 2, L = roll.web_width_mm;
  // The print repeat (repeat x web) wraps the roll and lies on the table; the formed sachet shows
  // the front and back cut from one pouch blank of that repeat (texture step).
  const tex = textures.roll ?? textures.front;
  const map = await loadTexture(tex.url);
  map.wrapS = THREE.RepeatWrapping;
  const around = (2 * Math.PI * R) / roll.repeat_mm;
  const outer = new THREE.CylinderGeometry(R, R, L, 256, 1, true);
  const mapA = map.clone();
  mapA.needsUpdate = true;
  mapA.wrapS = THREE.RepeatWrapping;
  mapA.repeat.set(around, 1);
  const base = g.materials.surfaces.base ?? {};
  const film = unlit(g) ? new THREE.MeshBasicMaterial({ map: mapA, side: THREE.DoubleSide, toneMapped: false })
    : new THREE.MeshPhysicalMaterial({ map: mapA, roughness: base.roughness ?? 0.5, clearcoat: base.clearcoat ?? 0, side: THREE.DoubleSide });
  const rollMesh = new THREE.Mesh(outer, film);
  const endMat = solidMaterial(g, { color: "#d9d9d4", roughness: 0.35, metalness: g.materials.surfaces.white_less ? 0.6 : 0.1 });
  const ringGeo = new THREE.RingGeometry(r, R, 128, 8);
  const coreMat = solidMaterial(g, { color: "#a47a4a", roughness: 0.9, side: THREE.DoubleSide });
  const core = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L + 6, 64, 1, true), coreMat);
  const e1 = new THREE.Mesh(ringGeo, endMat), e2 = new THREE.Mesh(ringGeo, endMat);
  e1.position.y = L / 2; e1.rotation.x = -Math.PI / 2;
  e2.position.y = -L / 2; e2.rotation.x = Math.PI / 2;
  const rollObj = new THREE.Group();
  rollObj.add(rollMesh, core, e1, e2);
  rollObj.rotation.z = Math.PI / 2; // axis along x
  rollObj.position.y = R;
  grp.add(rollObj);
  // unwound web on the table: 1.6 repeats, starting under the roll
  const webLen = roll.repeat_mm * 1.6;
  const web = new THREE.PlaneGeometry(L, webLen);
  const mapW = map.clone();
  mapW.needsUpdate = true;
  mapW.wrapS = mapW.wrapT = THREE.RepeatWrapping;
  mapW.rotation = Math.PI / 2;
  mapW.repeat.set(1, webLen / roll.repeat_mm);
  const webMesh = new THREE.Mesh(web, unlit(g) ? new THREE.MeshBasicMaterial({ map: mapW, side: THREE.DoubleSide, toneMapped: false })
    : new THREE.MeshPhysicalMaterial({ map: mapW, roughness: base.roughness ?? 0.5, side: THREE.DoubleSide }));
  webMesh.rotation.x = -Math.PI / 2;
  webMesh.position.set(0, 0.2, webLen / 2);
  grp.add(webMesh);
  // one formed sachet next to the roll
  const sachetSpec: GeometrySpec = { ...g, shape: "center_seal_pillow", template: "center_seal_pillow", seals: { ...g.seals, side: 0, crimp: Math.max(8, g.seals.top) } };
  // true size, so the measured model is the pouch (57 x 247.65 mm for FGPO7138) and the sachet
  // reads at the same scale as the print on the web beside it
  const sachet = await flatLikeGroup(sachetSpec, { front: textures.front ?? tex, back: textures.back ?? textures.front ?? tex }, filled, "center_seal_pillow");
  sachet.position.set(L / 2 + g.width_mm * 0.9, 0, R * 0.6);
  sachet.rotation.y = -0.5;
  grp.add(sachet);
  return grp;
}

// ---------------------------------------------------------------- assembly
/** The operator's windows on one face, drawn into its cut mask (the artwork for "pick area" ones). */
function windowsOn(g: GeometrySpec, mesh: THREE.Mesh, face: "front" | "back") {
  const shapes = (g.window.shapes ?? []).filter((w) => w.face === face);
  const mat = mesh.material as THREE.MeshPhysicalMaterial;
  if (shapes.length) paintWindows(mat.alphaMap, shapes, (mat.map?.image as CanvasImageSource) ?? null);
}

async function flatLikeGroup(g: GeometrySpec, textures: Record<string, SceneTexture>, filled: boolean, shape: string): Promise<THREE.Group> {
  const grp = new THREE.Group();
  const W = g.width_mm, H = g.height_mm;
  let inside: ((x: number, y: number) => number) | undefined;
  let outline: HTMLCanvasElement | null = null;
  if (g.template === "shaped_diecut" && g.outline_svg) {
    outline = await outlineCanvas(g.outline_svg, W, H);
    inside = insideField(outline, Math.min(W, H) * 0.12, outline.width / W);
  }
  const faces = pouchFaces(g, filled, shape, inside);
  const spoutCorner = g.spout && g.spout.position !== "top_center" ? (g.spout.position === "top_left_corner" ? "left" : "right") : null;
  const zones = { side: shape === "center_seal_pillow" ? 0 : g.seals.side, top: Math.max(g.seals.top, g.seals.crimp),
    bottom: shape === "stand_up_bottom_gusset" ? g.seals.bottom : Math.max(g.seals.bottom, g.seals.crimp),
    zipperY: g.zipper.enabled ? g.zipper.y_from_top_mm : null, crimp: shape === "center_seal_pillow" };
  const frontTex = textures.front;
  const backTex = textures.back ?? textures.front;
  const frontMat = await filmMaterial(g, frontTex, {
    alpha: cutMask(g, W, H, { corners: true, spoutCorner, outline, face: "front" }),
    normal: normalMap(W, H, zones, 1),
  });
  const backMat = await filmMaterial(g, backTex, {
    alpha: cutMask(g, W, H, { corners: true, spoutCorner: spoutCorner === "left" ? "right" : spoutCorner === "right" ? "left" : null, outline, mirror: !!outline, face: "back" }),
    normal: normalMap(W, H, { ...zones, finX: shape === "center_seal_pillow" ? W / 2 : null, finW: g.seals.fin }, 2),
  });
  const front = new THREE.Mesh(faces.front, frontMat);
  const back = new THREE.Mesh(faces.back, backMat);
  front.name = "front";
  back.name = "back";
  windowsOn(g, front, "front");
  windowsOn(g, back, "back");
  grp.add(front, back);
  if (faces.baseHalf && textures.gusset) {
    const [A, B] = faces.baseHalf;
    const gt = textures.gusset;
    const baseMat = await filmMaterial(g, gt, { normal: null, alpha: null });
    const base = new THREE.Mesh(baseGeometry(W, g.seals.side, A, B, faces.m, faces.n), baseMat);
    base.name = "gusset";
    grp.add(base);
  }
  if (g.spout && g.template === "spout_pouch") {
    const sp = await spoutGroup(g);
    const inset = g.seals.top * 0.5;
    if (g.spout.position === "top_center") {
      sp.position.set(0, H - inset, 0);
    } else {
      const cut = g.spout.cap_diameter_mm * 1.1;
      const sx = g.spout.position === "top_left_corner" ? -1 : 1;
      sp.position.set(sx * (W / 2 - cut / 2 + 2), H - cut / 2 + 2, 0);
      sp.rotation.z = -sx * Math.PI / 4;
    }
    grp.add(sp);
  }
  // (No stand-in product behind windows: a brown inner body filled every window, drawn or printed,
  // instead of clear film. As in boxGroup, a window shows the clear film and what is behind it.)
  return grp;
}

async function boxGroup(g: GeometrySpec, textures: Record<string, SceneTexture>, filled: boolean, shape: string): Promise<THREE.Group> {
  const grp = new THREE.Group();
  const W = g.width_mm, H = g.height_mm;
  const sideTex = textures.side_left ?? textures.side_right;
  const f = boxFaces(g, filled, shape, sideTex?.height_mm);
  const zones = { side: shape === "center_seal_side_gusset" ? 0 : g.seals.side, top: Math.max(g.seals.top, g.seals.crimp),
    bottom: shape === "center_seal_side_gusset" || shape === "quad_seal" ? Math.max(g.seals.bottom, g.seals.crimp) : 0, zipperY: g.zipper.enabled ? g.zipper.y_from_top_mm : null };
  const mk = async (geo: THREE.BufferGeometry, tex: SceneTexture | undefined, name: string, wMm: number, alpha: boolean) => {
    const t = tex ?? textures.front;
    const face = name === "front" || name === "back" ? name : undefined;
    const mat = await filmMaterial(g, t, { alpha: alpha ? cutMask(g, wMm, H, { corners: false, face }) : null, normal: normalMap(wMm, H, zones, name.length) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    if (face) windowsOn(g, mesh, face);
    return mesh;
  };
  grp.add(await mk(f.front, textures.front, "front", W, true));
  grp.add(await mk(f.back, textures.back ?? textures.front, "back", W, true));
  grp.add(await mk(f.right, textures.side_right ?? sideTex, "side_right", f.S, false));
  grp.add(await mk(f.left, textures.side_left ?? sideTex, "side_left", f.S, false));
  // (No stand-in product behind clear sides or gusset windows: a box, or the walls' shape copied inside,
  // showed through the window as a fake block; the window shows the clear film, as an empty pouch does.)
  if (filled && f.openBottom) {
    const bottomTex = textures.bottom ?? sideTex ?? textures.front;
    const geo = new THREE.PlaneGeometry(2 * f.X, f.S);
    const mesh = new THREE.Mesh(geo, await filmMaterial(g, bottomTex, {}));
    mesh.rotation.x = Math.PI / 2;
    mesh.position.y = 0.2;
    mesh.name = "bottom";
    grp.add(mesh);
  }
  return grp;
}

/** Build the pouch for a job's geometry spec. The returned group stands on y = 0. */
export async function buildPouch(g: GeometrySpec, textures: Record<string, SceneTexture>, opts: BuildOptions): Promise<THREE.Group> {
  let grp: THREE.Group;
  if (g.template === "roll_stock" && g.roll) grp = await rollGroup(g, textures, opts.filled);
  else if (["center_seal_side_gusset", "quad_seal", "flat_bottom_box_pouch"].includes(g.shape)) grp = await boxGroup(g, textures, opts.filled, g.shape);
  else grp = await flatLikeGroup(g, textures, opts.filled, g.shape);
  if (g.valve) {
    const face = grp.getObjectByName(g.valve.panel) as THREE.Mesh | undefined;
    if (face) placeOnFace(face, g.valve.x_mm / g.width_mm, 1 - g.valve.y_from_top_mm / g.height_mm, valveGroup(g, g.valve.diameter_mm));
  }
  grp.name = "pouch";
  outsideFaces(grp);
  grp.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  grp.userData.spec = { width_mm: g.width_mm, height_mm: g.height_mm };
  return grp;
}

/** Axis-aligned size of the pouch film in mm (spout, roll core and product excluded): what the
 *  viewer reports and the render step records, to compare with the keyline. */
export function measure(obj: THREE.Object3D): { x: number; y: number; z: number } {
  const box = new THREE.Box3();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && (mesh.material as THREE.Material).name === "film") box.expandByObject(mesh);
  });
  if (box.isEmpty()) box.setFromObject(obj);
  const s = box.getSize(new THREE.Vector3());
  return { x: s.x, y: s.y, z: s.z };
}

export { PX_PER_MM };
