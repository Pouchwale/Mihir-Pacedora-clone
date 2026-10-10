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
import type { GeometrySpec, SceneTexture, Sleeve } from "./types";

export interface BuildOptions {
  filled: boolean;
  pouch?: boolean; // roll form: the formed pouch beside the roll (default shown)
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
  if (tex.masks.window) {
    const window = await loadMask(tex.masks.window);
    const cut = maps.alpha?.image as HTMLCanvasElement | undefined;
    if (cut?.getContext) {
      // a face keeps its own cut mask (corners, hang hole); the window drawn in its artwork (FGPO6813's
      // leaf) is laid over it: the lower alpha of the two wins
      const ctx = cut.getContext("2d")!;
      ctx.save();
      ctx.globalCompositeOperation = "darken";
      ctx.drawImage(window.image as CanvasImageSource, 0, 0, cut.width, cut.height);
      ctx.restore();
      maps.alpha!.needsUpdate = true;
      maps = { ...maps, window: true };
    } else {
      maps = { ...maps, alpha: window, window: true };
    }
  }
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
  const sealEdge = { value: 0 }; // corner seal fins (quad seal): the outer share of the width at each edge
  // back fin seal (centre seal): its centre and half width as shares of the panel width, and 0.5 mm
  const fin = { value: new THREE.Vector3(0.5, 0, 0) };
  mat.userData.outsideFront = outsideFront;
  mat.userData.sealEdge = sealEdge;
  mat.userData.fin = fin;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.insideColor = { value: inside };
    shader.uniforms.outsideFront = outsideFront;
    shader.uniforms.sealEdge = sealEdge;
    shader.uniforms.fin = fin;
    shader.fragmentShader = "uniform vec3 insideColor;\nuniform bool outsideFront;\nuniform float sealEdge;\nuniform vec3 fin;\n" + shader.fragmentShader.replace(
      "#include <map_fragment>", "#include <map_fragment>\n"
      + "  if (gl_FrontFacing != outsideFront && vMapUv.x > sealEdge && vMapUv.x < 1.0 - sealEdge) diffuseColor.rgb = insideColor;\n"
      // the centre seal reads as on a real pack: the folded double strip a shade deeper, a soft
      // highlight at its fold, a hard shadow line under its free edge
      + "  if (fin.y > 0.0 && gl_FrontFacing == outsideFront) {\n"
      + "    float d = vMapUv.x - fin.x;\n"
      + "    if (abs(d) < fin.y) diffuseColor.rgb *= 0.93;\n"
      + "    diffuseColor.rgb *= 1.0 + 0.08 * (1.0 - smoothstep(0.0, fin.z * 3.0, abs(d + fin.y)));\n"
      + "    diffuseColor.rgb *= 1.0 - 0.4 * (smoothstep(fin.y - fin.z, fin.y, d) * (1.0 - smoothstep(fin.y + fin.z, fin.y + fin.z * 4.0, d)));\n"
      + "  }\n"
      // a clear window (alpha mask below half) keeps a faint sheen of plain film, not a ghost of the print
      + "#ifdef USE_ALPHAMAP\n  if (texture2D(alphaMap, vAlphaMapUv).g < 0.5) diffuseColor.rgb = vec3(1.0);\n#endif");
  };
  mat.customProgramCacheKey = () => `inside:${inside.getHexString()}:fin`;
  mat.forceSinglePass = true; // two passes (see-through double-sided film) flip gl_FrontFacing
}

/** The back's centre seal, shaded where it runs down the middle of the panel (plainInside's fin). */
function markFin(mat: THREE.Material, wMm: number, finW: number) {
  (mat.userData.fin as { value: THREE.Vector3 } | undefined)?.value.set(0.5, finW / 2 / wMm, 0.5 / wMm);
}

/** For each film mesh: is its outside the triangles' front side? Their winding normals, summed against
 * the direction away from the pouch's centre, say which way the mesh was built. */
function outsideFaces(grp: THREE.Group) {
  grp.updateMatrixWorld(true);
  const centres = new Map<THREE.Object3D, THREE.Vector3>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  grp.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const flag = mesh.isMesh ? ((mesh.material as THREE.Material).userData?.outsideFront as { value: boolean } | undefined) : undefined;
    if (!flag) return;
    // the centre of the pouch the panel belongs to (its group): a roll's sachet is not measured from the roll
    const body = mesh.parent ?? grp;
    if (!centres.has(body)) centres.set(body, new THREE.Box3().setFromObject(body).getCenter(new THREE.Vector3()));
    const centre = centres.get(body)!;
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
  // centre seal + side gusset: the back's fin seal runs down the middle, laid flat (as on the pillow)
  const fw = shape === "center_seal_side_gusset" ? g.seals.fin / 2 : 0;
  const finCols = fw ? [-fw - 2, -fw, fw - 0.4, fw, fw + 0.4].map((d) => (W / 2 + d) / W) : [];
  const finBulge = (f: number, o: number) => !fw ? 0
    // two films folded over: a strip standing ~1.5 mm proud, rising softly at the fold, dropping sharply at its free edge
    : (0.8 + 0.8 * o) * smooth(W / 2 - fw - 2, W / 2 - fw + 0.5, f) * (1 - smooth(W / 2 + fw - 0.25, W / 2 + fw + 0.25, f));
  const us = sortedUnique([...Array.from({ length: 81 }, (_, i) => i / 80), cs / W, 1 - cs / W, ...finCols]);
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
        if (sign === -1) z += finBulge(f, o);
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

  return { front: faceFront(1), back: faceFront(-1), right: faceSide(1), left: faceSide(-1), X, S, openBottom: !closedBottom, finW: fw * 2 };
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
async function rollGroup(g: GeometrySpec, textures: Record<string, SceneTexture>, filled: boolean, pouch = true): Promise<THREE.Group> {
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
  // the print's repeat runs along the web, its lanes (ac_ups) across it, exactly as on the roll. three
  // scales uv before turning it: repeat x counts along the length (v), so the lanes stay once across
  // the width (repeat (1, n) gave n copies of the lanes: 3 designs for FGPO7042's 2 ups).
  mapW.rotation = Math.PI / 2;
  mapW.repeat.set(webLen / roll.repeat_mm, 1);
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
  if (pouch) grp.add(sachet);
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
  if (shape === "center_seal_pillow" && g.seals.fin > 0) markFin(backMat, W, g.seals.fin);
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
    const fin = name === "back" && f.finW ? { finX: wMm / 2, finW: f.finW } : {}; // the knurled centre seal strip
    const mat = await filmMaterial(g, t, { alpha: alpha ? cutMask(g, wMm, H, { corners: false, face }) : null, normal: normalMap(wMm, H, { ...zones, ...fin }, name.length) });
    // a corner seal fin is two films sealed back to back: printed on both faces, never the pouch's inside
    if (face && mat.userData.sealEdge) mat.userData.sealEdge.value = zones.side / wMm;
    if (name === "back" && f.finW) markFin(mat, wMm, f.finW);
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
// ---------------------------------------------------------------- shrink sleeve on a container
/** Radius of the turned container at height y (mm, base at 0): its body outline, without lid or cap. */
function containerRadius(s: Sleeve, y: number): number {
  const R = s.diameter_mm / 2, H = s.container_height_mm, t = y / H;
  const ease = (a: number, b: number, x: number) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  switch (s.shape) {
    case "can": // a drawn can: domed-in base, straight wall, the neck tapering to the lid seam
      return R * (0.78 + 0.22 * ease(0, 0.07, t)) * (1 - 0.15 * ease(0.9, 0.975, t));
    case "bottle": // body, a round shoulder into the neck (the cap sits on the neck)
      return R * (1 - (1 - s.neck_ratio) * ease(0.56, 0.84, t));
    case "jar": // a wide body with a short shoulder under the lid
      return R * (1 - (1 - s.neck_ratio) * ease(0.84, 0.88, t));
    case "pot": { // a ghee jar, measured from its 3D model (Tripo "Gowardhan ghee jar"): the base rounding
      // out from 86 % to the full width by a third of the height, a straight belly, then a round shoulder
      // in to the neck (neck_ratio) at the body's top, 80 % of the jar's height; the lid sits above
      const u = Math.min(1, t / 0.8), n = s.neck_ratio;
      if (u < 0.4) { const k = u / 0.4; return R * (0.86 + 0.14 * Math.sin((k * Math.PI) / 2) ** 0.7); }
      if (u < 0.86) return R;
      const k = (u - 0.86) / 0.14; // shoulder: a quarter round from the belly into the neck
      return R * (n + (1 - n) * Math.sqrt(Math.max(0, 1 - k * k)));
    }
    default: // tin: a straight wall between its rolled rims (the rims are added proud of it)
      return R;
  }
}

/** How high the body outline goes (a bottle's cap and a jar's / pot's lid sit above it). Sleeve.BODY_TOP on the server. */
function bodyTop(s: Sleeve): number {
  const H = s.container_height_mm;
  return H * ({ bottle: 0.9, jar: 0.88, pot: 0.8 } as Record<string, number>)[s.shape] || H;
}

/** Shading baked into a sphere picture (a matcap): metal and plastic still look like themselves under
 *  "exact" lighting, which has no lights at all (the artwork there must stay the flat print colour). */
const matcaps = new Map<string, THREE.Texture>();
function matcap(kind: "metal" | "plastic"): THREE.Texture {
  if (!matcaps.has(kind)) {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(100, 82, 4, 128, 128, 132);
    const stops: [number, string][] = kind === "metal"
      ? [[0, "#ffffff"], [0.18, "#f1f3f5"], [0.45, "#b9bec5"], [0.7, "#e4e7ea"], [0.86, "#8d939b"], [1, "#4d535b"]] // a bright sky, a dark horizon band
      : [[0, "#ffffff"], [0.4, "#fbfbfb"], [0.78, "#e8e8e8"], [1, "#c6c6c6"]]; // (plastic keeps its true colour: darker edges turned yellow olive)
    for (const [o, col] of stops) g.addColorStop(o, col);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    matcaps.set(kind, t);
    cachedTextures.add(t); // shared: never disposed with a model
  }
  return matcaps.get(kind)!;
}

/** What a container's metal and gloss reflect: a dark product-photography studio with an overhead softbox and
 *  two strip lights at the sides (polished metal shows what it reflects: the viewer's bright white studio
 *  made can ends look flat grey; these bands of light and dark are what make them look rich). */
let studio: THREE.Texture | null = null;
function studioReflections(): THREE.Texture {
  if (studio) return studio;
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  const sky = ctx.createLinearGradient(0, 0, 0, 512);
  for (const [o, col] of [[0, "#e4e8ed"], [0.22, "#b4bac2"], [0.42, "#5d636b"], [0.52, "#2e3238"], [0.75, "#1b1d22"], [1, "#101114"]] as [number, string][]) sky.addColorStop(o, col);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 1024, 512);
  const box = (x: number, y: number, w: number, h: number, a: number) => {
    const gr = ctx.createLinearGradient(x, 0, x + w, 0);
    gr.addColorStop(0, `rgba(255,255,255,0)`);
    gr.addColorStop(0.2, `rgba(255,255,255,${a})`);
    gr.addColorStop(0.8, `rgba(255,255,255,${a})`);
    gr.addColorStop(1, `rgba(255,255,255,0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(x, y, w, h);
  };
  box(0, 0, 1024, 26, 1); // the overhead softbox (the top rows of the map are straight up)
  box(260, 26, 504, 70, 1);
  box(120, 120, 70, 240, 0.95); // strip lights left and right
  box(834, 120, 70, 240, 0.95);
  box(490, 150, 44, 200, 0.55); // a faint rim strip behind
  studio = new THREE.CanvasTexture(c);
  studio.mapping = THREE.EquirectangularReflectionMapping;
  studio.colorSpace = THREE.SRGBColorSpace;
  cachedTextures.add(studio);
  return studio;
}

function containerMaterial(g: GeometrySpec, color: string, kind: string): THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial | THREE.MeshMatcapMaterial {
  if (unlit(g)) return kind === "clear" || kind === "glass"
    ? new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.3 })
    : new THREE.MeshMatcapMaterial({ color, matcap: matcap(kind === "metal" ? "metal" : "plastic"), toneMapped: false });
  const envMap = studioReflections();
  if (kind === "metal") return new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness: 0.18, clearcoat: 0.5, clearcoatRoughness: 0.1, envMap, envMapIntensity: 1.35 });
  if (kind === "glass") return new THREE.MeshPhysicalMaterial({ color, roughness: 0.05, transmission: 0.9, thickness: 2, ior: 1.5, envMap, envMapIntensity: 1.1 });
  if (kind === "clear") // clear PET: a water bottle
    return new THREE.MeshPhysicalMaterial({ color, roughness: 0.03, transmission: 0.96, thickness: 1.2, ior: 1.45, clearcoat: 1, transparent: true, side: THREE.DoubleSide,
      envMap, envMapIntensity: 1.2 });
  // moulded PP / HDPE: lit by the scene's own soft studio (the dark metal studio turned a yellow lid
  // olive), a satin surface under a light gloss, no glow (a glow flattened the shading into a cartoon)
  return new THREE.MeshPhysicalMaterial({ color, roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.25, specularIntensity: 0.5 });
}

/** A turned shape from (radius, y) points, base to top. */
function lathe(points: [number, number][], segments = 160): THREE.LatheGeometry {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y)), segments);
}

/** A turned shape with fine vertical ribs pressed into its side between heights `from` and `to` (a screw
 *  cap's or a lid's knurling): `ribs` round it, each `depth` mm proud. */
function knurled(points: [number, number][], from: number, to: number, ribs: number, depth: number, broad = false): THREE.LatheGeometry {
  // the profile needs points all along the ribbed band (with only its two ends there, the ribs faded to
  // nothing at both and were never drawn): each segment is cut into steps of 0.4 mm
  const dense: [number, number][] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [r0, y0] = points[i - 1], [r1, y1] = points[i];
    const steps = Math.max(1, Math.min(200, Math.ceil(Math.hypot(r1 - r0, y1 - y0) / 0.4)));
    for (let k = 1; k <= steps; k++) dense.push([r0 + ((r1 - r0) * k) / steps, y0 + ((y1 - y0) * k) / steps]);
  }
  points = dense;
  const geo = lathe(points, Math.max(240, ribs * 16));
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) {
    const y = pos.getY(k);
    if (y < from || y > to) continue;
    const x = pos.getX(k), z = pos.getZ(k), r = Math.hypot(x, z);
    if (r < 1e-3) continue;
    const c = Math.cos(Math.atan2(x, z) * ribs);
    // fine ribs: sharp ridges; broad flutes (a ghee lid's): rounded lobes with narrow grooves between
    const ease = Math.min(1, (y - from) / 2, (to - y) / 2); // flutes fade in and out at their ends
    const f = 1 + (depth * ease * (broad ? Math.sqrt((1 + c) / 2) : Math.max(0, c))) / r;
    pos.setXYZ(k, x * f, y, z * f);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Soft vertical facets round a turned shape (a ghee pot's moulded panels): its radius pressed in a little
 *  between `n` flat-ish panels. */
function faceted(geo: THREE.LatheGeometry, n: number, amount: number): THREE.LatheGeometry {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), z = pos.getZ(k);
    const f = 1 - (amount * (1 - Math.cos(Math.atan2(x, z) * n))) / 2; // smooth panels: no creases between them
    pos.setXYZ(k, x * f, pos.getY(k), z * f);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Spun metal: the fine concentric turning rings of a can end catch the light round it (what makes a real
 *  end look rich rather than flat grey). A ring texture as bump and roughness, mapped by distance from the
 *  axis so the rings run evenly from the centre to the rim. */
const spinTexture = (() => {
  let t: THREE.Texture | null = null;
  return () => {
    if (t) return t;
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 1024;
    const ctx = c.getContext("2d")!;
    let v = 128;
    for (let y = 0; y < 1024; y++) {
      v = Math.max(70, Math.min(190, v + (Math.random() - 0.5) * 70));
      ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
      ctx.fillRect(0, y, 4, 1);
    }
    t = new THREE.CanvasTexture(c);
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 1.2);
    cachedTextures.add(t);
    return t;
  };
})();

function spun(mesh: THREE.Mesh, rMax: number): THREE.Mesh {
  const geo = mesh.geometry as THREE.BufferGeometry;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute, uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) uv.setXY(k, 0.5, Math.hypot(pos.getX(k), pos.getZ(k)) / rMax);
  uv.needsUpdate = true;
  const m = mesh.material;
  if (m instanceof THREE.MeshPhysicalMaterial) {
    const tex = spinTexture();
    mesh.material = Object.assign(m.clone(), { bumpMap: tex, bumpScale: 0.22, roughnessMap: tex, roughness: 0.3, metalness: 1, clearcoat: 0.6, clearcoatRoughness: 0.06 });
  }
  return mesh;
}

/** A flat part lying on a can end: a shape drawn in (x, -z), raised `depth` mm from height y. */
function onEnd(shape: THREE.Shape, depth: number, y: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 2, curveSegments: 24 }), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
}

/** A tin's / drink can's easy-open end: the double seam, the recessed panel, the scored opening at the
 *  front, the pull tab over it and its rivet in the middle. */
/** A food / powder tin's ends (Pacdora's round tin): a bright rolled rim proud of the wall top and bottom;
 *  the top a flat panel just below its rim, with two expansion rings, the score round its edge and a ring
 *  pull lying on it (a full-aperture easy-open end). */
function tinEnds(r: number, H: number, mat: THREE.Material): THREE.Object3D[] {
  const P = H - 3;
  const rim = (y: number) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r + 0.35, 1.6, 20, 200), mat);
    m.rotation.x = Math.PI / 2;
    m.position.y = y;
    return m;
  };
  // the panel with three rounded expansion beads pressed up into it (the light runs round them)
  const prof: [number, number][] = [[0, P]];
  for (let i = 1; i <= 220; i++) {
    const x = (0.88 * r * i) / 220;
    const bump = [0.36, 0.56, 0.76].reduce((acc, c) => acc + 1.3 * Math.exp(-(((x - c * r) / (0.042 * r)) ** 2)), 0);
    prof.push([x, P + bump]);
  }
  // (drawn from the rim in: a profile running outwards faces down, and the end showed its back)
  const panel = new THREE.Mesh(lathe(([...prof, [r - 1.3, P + 0.15], [r - 0.9, H - 0.8], [r + 0.2, H]] as [number, number][]).reverse()), mat);
  const bright = mat instanceof THREE.MeshPhysicalMaterial ? Object.assign(mat.clone(), { roughness: 0.12, clearcoat: 0.7 }) : mat;
  const score = new THREE.Mesh(new THREE.TorusGeometry(0.9 * r, 0.35, 8, 200), mat);
  score.rotation.x = Math.PI / 2;
  score.position.y = P + 0.15;
  // the ring pull: a flat ring towards the middle, its lever riveted near the front edge (+z)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16 * r, 0.9, 12, 64), bright);
  ring.rotation.x = Math.PI / 2;
  ring.scale.set(1, 1.35, 0.6);
  ring.position.set(0, P + 1, 0.42 * r);
  const lever = new THREE.Shape();
  const lw = 0.07 * r;
  lever.moveTo(-lw, -0.84 * r).lineTo(lw, -0.84 * r).lineTo(lw * 1.4, -0.6 * r).lineTo(-lw * 1.4, -0.6 * r).closePath();
  const rivet = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * r, 0.045 * r, 1.2, 20), bright);
  rivet.position.set(0, P + 1, 0.78 * r);
  const bead = new THREE.Mesh(new THREE.TorusGeometry(r + 0.15, 0.55, 12, 200), mat); // the seam's step under the rim
  bead.rotation.x = Math.PI / 2;
  bead.position.y = H - 3.6;
  return [rim(H - 1.6), rim(1.6), bead, spun(panel, r), score, ring, onEnd(lever, 0.45, P + 0.35, bright), rivet];
}

function canEnd(r: number, H: number, mat: THREE.Material): THREE.Object3D[] {
  // one turned profile, centre to rim: the panel 5 mm down, the countersink groove round it, the chuck wall
  // up to the double seam (a rolled lip proud of the neck), and the seam's outside down onto the neck
  const P = H - 5;
  const end = new THREE.Mesh(lathe(([[0, P], [0.76 * r, P], [0.8 * r, P - 0.35], [0.84 * r, P - 1.1], [0.88 * r, P - 0.45], [r - 1.7, P + 0.3],
    [r - 1.35, H - 0.7], [r - 0.75, H + 0.3], [r + 0.15, H + 0.25], [r + 0.55, H - 0.9], [r + 0.45, H - 2.7], [r - 0.2, H - 3.3]] as [number, number][]).reverse()), mat); // (rim in: faces up)
  // the score: a raised teardrop ring between the rivet and the rim, at the front (+z)
  const ring = new THREE.Shape().absellipse(0, -0.5 * r, 0.24 * r, 0.3 * r, 0, Math.PI * 2, false, 0);
  ring.holes.push(new THREE.Path().absellipse(0, -0.5 * r, 0.24 * r - 1.3, 0.3 * r - 1.3, 0, Math.PI * 2, false, 0));
  // the tab: its nose on the opening, the finger ring towards the back
  const w = 0.17 * r, nose = -0.42 * r, tail = 0.46 * r;
  const tab = new THREE.Shape();
  tab.moveTo(-w, nose + w).quadraticCurveTo(-w, nose, 0, nose).quadraticCurveTo(w, nose, w, nose + w)
    .lineTo(w, tail - w).quadraticCurveTo(w, tail, 0, tail).quadraticCurveTo(-w, tail, -w, tail - w).closePath();
  tab.holes.push(new THREE.Path().absellipse(0, 0.25 * r, 0.6 * w, 0.1 * r, 0, Math.PI * 2, false, 0));
  // the tab is pressed from brighter stock than the end
  const bright = mat instanceof THREE.MeshPhysicalMaterial ? Object.assign(mat.clone(), { roughness: 0.14, clearcoat: 0.6 }) : mat;
  const rivet = new THREE.Mesh(new THREE.CylinderGeometry(0.055 * r, 0.07 * r, 1.2, 24), bright);
  rivet.position.y = P + 0.9;
  return [spun(end, r), onEnd(ring, 0.8, P, bright), onEnd(tab, 0.6, P + 0.45, bright), rivet];
}

async function sleeveGroup(g: GeometrySpec, textures: Record<string, SceneTexture>): Promise<THREE.Group> {
  const s = g.sleeve!;
  const grp = new THREE.Group();
  const H = s.container_height_mm, R = s.diameter_mm / 2, top = bodyTop(s);
  const metal = s.shape === "tin" || s.shape === "can";
  // the container body: a tin / can stands on a narrow ring with its base domed in (the wall's footer
  // curves into it); other containers have a slightly domed base
  const dome = Math.min(9, 0.07 * H);
  const outline: [number, number][] = s.shape === "can"
    ? [[0, dome], [0.5 * R, 0.75 * dome], [0.66 * R, 1.2], [0.71 * R, 0], [0.75 * R, 0.25]]
    : s.shape === "tin" ? [[0, 2.6], [R - 1.2, 2.6], [R, 0.4]] : [[0, 1.2]];
  for (let i = metal ? 1 : 0; i <= 120; i++) { const y = (top * i) / 120; outline.push([containerRadius(s, y), y]); }
  // (a tin's / can's body closes below its recessed end, or its top would hide the tab / ring pull)
  if (metal) outline.push([containerRadius(s, top) - 1.6, top - 3.4], [0, top - 6.5]);
  else outline.push([0, top]);
  const bodyMat = containerMaterial(g, s.body_color, s.material);
  bodyMat.name = "film"; // (measured as the model)
  grp.add(new THREE.Mesh(s.shape === "pot" ? faceted(lathe(outline), 12, 0) : lathe(outline), bodyMat));
  if (s.material === "clear") {
    // water inside a clear bottle, to its shoulder
    const fill = outline.filter(([, y]) => y <= 0.62 * H).map(([r, y]) => [r * 0.95, y] as [number, number]);
    const water = containerMaterial(g, "#cfe8f5", "clear");
    grp.add(new THREE.Mesh(lathe([...fill, [0, fill[fill.length - 1][1]]]), water));
  }
  const cap = containerMaterial(g, s.cap_color, s.shape === "can" || s.shape === "tin" ? "metal" : "plastic");
  if (s.shape === "tin") {
    grp.add(...tinEnds(R, H, cap));
  } else if (s.shape === "can") {
    grp.add(...canEnd(containerRadius(s, H), H, cap));
  } else if (s.shape === "pot") {
    // the jar's lid, as measured: a band at its foot the neck's width (6 % of the jar's height), then the
    // smooth lid at 89 % of the body's width, straight-sided with a well rounded top edge and a flat top
    const rt = containerRadius(s, top), lidH = H - top;
    const rl = R * 0.89, bandTop = top + 0.3 * lidH, er = Math.min(0.12 * lidH, 4); // edge radius
    const band = containerMaterial(g, s.cap_color, "plastic");
    if ("color" in band) band.color.multiplyScalar(0.85);
    grp.add(new THREE.Mesh(lathe([[rt - 0.5, top - 1.2], [rt + 0.3, top - 0.6], [rt + 0.3, bandTop], [rt - 0.2, bandTop]], 160), band));
    const lid: [number, number][] = [[rt - 0.2, bandTop], [rl - 0.6, bandTop], [rl, bandTop + 0.8], [rl, H - er]];
    for (let i = 1; i <= 12; i++) { const a = (i / 12) * (Math.PI / 2); lid.push([rl - er + er * Math.cos(a), H - er + er * Math.sin(a)]); }
    lid.push([0.6 * rl, H + 0.2], [0, H + 0.3]);
    grp.add(new THREE.Mesh(lathe(lid, 200), cap));
    const gap = containerMaterial(g, "#3a3a3a", "plastic");
    const shadow = new THREE.Mesh(new THREE.TorusGeometry(rt + 0.4, 0.45, 8, 160), gap);
    shadow.rotation.x = Math.PI / 2;
    shadow.position.y = top - 1.2;
    grp.add(shadow);
  } else if (s.shape === "bottle") {
    // a PET bottle's top: the neck's support flange, the tamper-evident band left on the neck, and the screw
    // cap above it, finely knurled with a rounded top edge
    const rn = containerRadius(s, top), rc = rn * 1.18, capH = H - top;
    grp.add(new THREE.Mesh(lathe([[rn - 0.2, top - 2.2], [rn + 2.6, top - 1.9], [rn + 2.9, top - 1.2], [rn + 2.6, top - 0.5], [rn - 0.2, top - 0.3]], 160), bodyMat));
    const band0 = top + 0.15 * capH, band1 = top + 0.3 * capH, cap0 = band1 + 0.6;
    grp.add(new THREE.Mesh(knurled([[rn, top], [rc - 0.3, band0 - 0.4], [rc, band0], [rc, band1], [rc - 0.4, band1 + 0.2], [rn, band1 + 0.2]],
      band0, band1, 60, 0.25), cap));
    grp.add(new THREE.Mesh(knurled([[rn, cap0], [rc, cap0], [rc, cap0 + 0.5], [rc, H - 1.6], [rc - 0.5, H - 0.4], [rc - 1.6, H], [0.5 * rc, H - 0.2], [0, H - 0.2]],
      cap0 + 0.8, H - 1.8, 96, 0.4), cap));
  } else {
    // a jar's lid above the body
    const r = R * 0.97;
    grp.add(new THREE.Mesh(lathe([[0, top - 0.5], [r, top - 0.5], [r, H - 1.2], [r - 1.2, H], [0, H]], 96), cap));
  }
  // the sleeve: the container's own outline over the band it covers, a hair outside it (it is shrunk on)
  const y0 = s.sleeve_from * H, y1 = Math.min(s.sleeve_to * H, top);
  const band: [number, number][] = [];
  for (let i = 0; i <= 96; i++) { const y = y0 + ((y1 - y0) * i) / 96; band.push([containerRadius(s, y) + 0.25, y]); }
  const geo = s.shape === "pot" ? faceted(lathe(band), 12, 0) : lathe(band); // (shrunk onto the pot's soft facets)
  // v follows the film's length along the outline (a bottle's shoulder takes its share of the print)
  const lengths = [0];
  for (let i = 1; i < band.length; i++) lengths.push(lengths[i - 1] + Math.hypot(band[i][0] - band[i - 1][0], band[i][1] - band[i - 1][1]));
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let k = 0; k < uv.count; k++) uv.setY(k, lengths[k % band.length] / lengths[lengths.length - 1]);
  uv.needsUpdate = true;
  const tex = textures.sleeve ?? Object.values(textures)[0];
  const map = (await loadTexture(tex.url)).clone();
  map.needsUpdate = true;
  map.wrapS = THREE.RepeatWrapping;
  // once round = the circumference; the seam overlap (half from each edge of the print) is left out at
  // the back. The lathe's own seam (u = 0) is turned to the back, so u = 0.5 faces the front and the
  // print's main-panel centre (front_center_pct) sits there with no cut through it.
  const around = Math.min(1, s.circumference_mm / s.printed_width_mm);
  map.repeat.set(around, 1);
  map.offset.set(s.front_center_pct / 100 - around / 2, 0);
  // the unprinted bands at the sleeve's edges are clear film (texture step: masks.window), placed as the print
  let alphaMap: THREE.Texture | null = null;
  if (tex.masks.window) {
    alphaMap = (await loadMask(tex.masks.window)).clone();
    alphaMap.needsUpdate = true;
    alphaMap.wrapS = THREE.RepeatWrapping;
    alphaMap.repeat.copy(map.repeat);
    alphaMap.offset.copy(map.offset);
  }
  const clear = alphaMap ? { alphaMap, transparent: true } : {};
  const film = unlit(g)
    ? new THREE.MeshBasicMaterial({ map, ...clear, side: THREE.DoubleSide, toneMapped: false })
    // printed gloss film: a broad soft sheen; a hard clearcoat put a white glare stripe across the print
    : new THREE.MeshPhysicalMaterial({ map, ...clear, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.32, specularIntensity: 0.6,
        envMapIntensity: 0.75, side: THREE.DoubleSide });
  film.name = "film";
  const sleeve = new THREE.Mesh(geo, film);
  sleeve.name = "sleeve";
  sleeve.rotation.y = Math.PI; // the seam at the back
  grp.add(sleeve);
  return grp;
}

export async function buildPouch(g: GeometrySpec, textures: Record<string, SceneTexture>, opts: BuildOptions): Promise<THREE.Group> {
  let grp: THREE.Group;
  if (g.template === "shrink_sleeve" && g.sleeve) grp = await sleeveGroup(g, textures);
  else if (g.template === "roll_stock" && g.roll) grp = await rollGroup(g, textures, opts.filled, opts.pouch !== false);
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
