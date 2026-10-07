// The photo studio around the pouch, shared by the interactive viewer and the headless renders.
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { disposeObject } from "./pouch";
import type { Preset } from "./types";

export const VIEWS: Record<string, { az: number; el: number }> = {
  front: { az: 0, el: 6 },
  back: { az: 180, el: 6 },
  three_quarter_left: { az: -35, el: 14 },
  three_quarter_right: { az: 35, el: 14 },
  top_down: { az: 15, el: 68 },
  turntable: { az: 0, el: 10 },
};

// Tone mapping: Khronos "PBR Neutral" keeps printed colours true (measured on FGPO7215: the gold
// band renders (246,190,75) for a (252,193,67) texture; ACES gave (246,229,159), a washed cream).
// ACES stays for the dramatic look, where mood matters more than colour matching.
type Tone = "neutral" | "aces" | "none";
export const LIGHTING: Record<string, { env: number; key: number; fill: number; rim: number; exposure: number; tone: Tone; warm?: boolean }> = {
  // exact: no lights, no tone mapping; artwork materials are unlit, so every pixel is the print colour.
  exact: { env: 0, key: 0, fill: 0, rim: 0, exposure: 1, tone: "none" },
  studio_soft: { env: 0.7, key: 1.2, fill: 0.45, rim: 0.5, exposure: 0.9, tone: "neutral" },
  studio_hard: { env: 0.45, key: 2.4, fill: 0.15, rim: 0.7, exposure: 0.9, tone: "neutral" },
  daylight: { env: 0.7, key: 1.8, fill: 0.35, rim: 0.3, exposure: 0.95, tone: "neutral", warm: true },
  product_dramatic: { env: 0.35, key: 2.4, fill: 0.08, rim: 1.6, exposure: 1.0, tone: "aces" },
};

function radialTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(0,0,0,0.85)");
  g.addColorStop(0.45, "rgba(0,0,0,0.35)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/** Alpha for the studio floor: solid in the middle, fading out to its rim (no visible edge). */
function fadeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "#fff");
  g.addColorStop(0.35, "#fff");
  g.addColorStop(1, "#000");
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function gradientTexture(colors: string[]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 512;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, 512);
  colors.forEach((col, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), col));
  x.fillStyle = g;
  x.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// moves: turns along when the pouch is turned (a panorama around it / a turntable under it); else it stays put
export type Backdrop = { kind: "white" | "gradient" | "dark" | "none" | "color" | "image"; color: string; image: HTMLImageElement | null; moves: boolean };
// float_mm: the pouch hovers this high above the floor
export type Floor = { kind: "none" | "studio" | "color" | "image"; color: string; image: HTMLImageElement | null; tile_mm: number; moves: boolean; float_mm: number };

export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, 1, 1, 20000);
  object: THREE.Object3D | null = null;
  overlay = new THREE.Group(); // dimension lines etc.: never exported
  // The pouch and its dimension lines hang in a pivot at the pouch's centre, so a drag turns the pouch
  // itself (grab a corner, it follows the pointer); after every turn it rests back on the floor.
  private turnable = new THREE.Group();
  private inner = new THREE.Group();
  private bgImage: { w: number; h: number } | null = null;
  // Lights live on a rig that turns with the camera, like a studio set-up around a product:
  // every view gets the same key / fill / rim lighting.
  private rig = new THREE.Group();
  private key = new THREE.DirectionalLight("#ffffff", 1.6);
  private fill = new THREE.DirectionalLight("#ffffff", 0.5);
  private rim = new THREE.DirectionalLight("#ffffff", 0.4);
  // Soft contact shadow: a dim light straight above casting a heavily blurred shadow.
  private shadowLight = new THREE.DirectionalLight("#ffffff", 0.25);
  private catcher: THREE.Mesh;
  private blob: THREE.Mesh;
  // A visible studio floor (viewer option): matte, seen from above only, so the pouch stays visible from below.
  private floor: THREE.Mesh;
  private target = new THREE.Object3D();
  /** Ask an on-demand render loop for a new frame (the viewer sets this). */
  invalidate: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.shadowLight.castShadow = true;
    this.shadowLight.shadow.mapSize.set(1024, 1024);
    this.shadowLight.shadow.radius = 28;
    this.shadowLight.shadow.blurSamples = 25;
    this.shadowLight.shadow.bias = -0.0005;
    for (const l of [this.key, this.fill, this.rim]) {
      l.target = this.target;
      this.rig.add(l);
    }
    this.shadowLight.target = this.target;
    this.inner.add(this.overlay);
    this.turnable.add(this.inner);
    this.scene.add(this.rig, this.target, this.shadowLight, this.turnable);
    this.catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.3 }));
    this.catcher.rotation.x = -Math.PI / 2;
    this.catcher.receiveShadow = true;
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, depthWrite: false, opacity: 0.55 }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.05;
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(0.5, 96), new THREE.MeshStandardMaterial({ color: "#ededf0", roughness: 0.92, metalness: 0, alphaMap: fadeTexture(), transparent: true, depthWrite: false }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.05;
    this.floor.receiveShadow = true;
    this.floor.visible = false;
    this.floor.renderOrder = -1; // (drawn first: it fades into the background behind everything)
    this.scene.add(this.catcher, this.blob, this.floor);
  }

  /** Viewer options: the background (studio white, gradient, dark, a colour, a picture or none = transparent)
   * and the floor (none, studio, a colour or a tiled picture such as wood or marble). */
  setBackdrop(bg: Backdrop, floor: Floor) {
    this.bgImage = null;
    this.bgMoves = bg.moves;
    this.floorMoves = floor.moves;
    if (!floor.moves) this.floor.rotation.z = 0;
    this.lift = Math.max(0, floor.float_mm);
    if (bg.kind === "none") {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else if (bg.kind === "gradient") {
      this.scene.background = gradientTexture(["#fdfdfe", "#e6e9ef", "#c9ced8"]);
    } else if (bg.kind === "image" && bg.image) {
      const t = new THREE.Texture(bg.image);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.MirroredRepeatWrapping; // a moving picture pans on without a seam
      t.needsUpdate = true;
      this.scene.background = t;
      this.bgImage = { w: bg.image.naturalWidth, h: bg.image.naturalHeight };
      this.fitBackground();
    } else {
      this.scene.background = new THREE.Color(bg.kind === "dark" ? "#20242c" : bg.kind === "color" ? bg.color : "#ffffff");
    }
    const mat = this.floor.material as THREE.MeshStandardMaterial;
    this.floor.visible = floor.kind !== "none";
    mat.map?.dispose();
    mat.map = null;
    mat.color.set(floor.kind === "color" ? floor.color : floor.kind === "image" ? "#ffffff" : bg.kind === "dark" ? "#2b3039" : "#ededf0");
    if (floor.kind === "image" && floor.image) {
      const t = new THREE.Texture(floor.image);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      t.needsUpdate = true;
      mat.map = t;
      this.floorTile = Math.max(10, floor.tile_mm);
      this.fitFloor();
    }
    mat.needsUpdate = true;
    this.rest(); // the float height may have changed
  }

  private floorTile = 300;
  /** One picture tile covers `floorTile` mm of floor. */
  private fitFloor() {
    const mat = this.floor.material as THREE.MeshStandardMaterial;
    if (mat.map) mat.map.repeat.setScalar(this.floor.scale.x / this.floorTile);
  }

  /** A picture background covers the view like CSS `background-size: cover` (no stretching). */
  fitBackground() {
    const t = this.scene.background as THREE.Texture | null;
    if (!this.bgImage || !t || !(t as THREE.Texture).isTexture) return;
    const view = this.camera.aspect, img = this.bgImage.w / this.bgImage.h;
    if (view > img) t.repeat.set(1, img / view);
    else t.repeat.set(view / img, 1);
    t.offset.set((1 - t.repeat.x) / 2 + this.bgPan, (1 - t.repeat.y) / 2);
  }

  private bgMoves = false;
  private floorMoves = false;
  private bgPan = 0; // how far a moving picture background has panned (in picture widths)
  private lift = 0;

  /** Background and floor that move with the pouch follow its turn about the vertical. */
  private follow(yaw: number) {
    if (this.floorMoves && this.floor.visible) this.floor.rotation.z += yaw;
    if (this.bgMoves && this.bgImage) {
      this.bgPan -= yaw / (2 * Math.PI);
      this.fitBackground();
    }
  }

  /** The front or back face under a point of the canvas (-1..1 device coordinates), with the texture
   *  coordinate there (0..1 from the texture's top-left). `face` keeps to one face (a shape being drawn). */
  pick(ndc: { x: number; y: number }, face?: string): { face: "front" | "back"; u: number; v: number } | null {
    if (!this.object) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    const faces: THREE.Object3D[] = [];
    this.object.traverse((o) => { if ((o.name === "front" || o.name === "back") && (!face || o.name === face)) faces.push(o); });
    const hit = ray.intersectObjects(faces, false).find((h) => h.uv);
    if (!hit || !hit.uv) return null;
    return { face: hit.object.name as "front" | "back", u: hit.uv.x, v: 1 - hit.uv.y };
  }

  /** Turn the pouch by a drag: `dx`, `dy` in radians about the camera's up and right axes. */
  turn(dx: number, dy: number) {
    const m = this.camera.matrixWorld.elements;
    const right = new THREE.Vector3(m[0], m[1], m[2]).normalize();
    const up = new THREE.Vector3(m[4], m[5], m[6]).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(up, dx).multiply(new THREE.Quaternion().setFromAxisAngle(right, dy));
    this.turnable.quaternion.premultiply(q).normalize();
    this.follow(dx * Math.max(0, up.y));
    this.rest();
  }

  /** Turntable: turn about the vertical. */
  spin(angle: number) {
    this.turnable.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), angle);
    this.follow(angle);
    this.rest();
  }

  /** Back to standing upright, facing front. */
  resetTurn() {
    this.turnable.quaternion.identity();
    this.rest();
  }

  private shadowOn = true;
  private blobBase = new THREE.Vector2(1, 1);
  private blobSpread = 1;
  /** Sit the turned pouch on the floor (its lowest point at y = 0). The soft blob under it follows a
   * turntable turn and is hidden once the pouch is tipped over (the cast shadow alone is right then). */
  private rest() {
    const q = this.turnable.quaternion;
    const across = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    this.blob.visible = this.shadowOn && new THREE.Vector3(0, 1, 0).applyQuaternion(q).y > 0.97;
    this.blob.rotation.z = Math.atan2(-across.z, across.x);
    if (!this.object) return;
    this.turnable.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.object);
    this.turnable.position.y += this.lift - box.min.y;
    this.turnable.updateMatrixWorld(true);
    // a floating pouch: the soft blob under it spreads and fades with the height
    const span = Math.max(1, box.max.y - box.min.y);
    const h = Math.min(1, this.lift / span);
    (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - 0.75 * h);
    this.blob.scale.z = 1;
    this.blobSpread = 1 + h * 0.8;
    this.blob.scale.x = this.blobBase.x * this.blobSpread;
    this.blob.scale.y = this.blobBase.y * this.blobSpread;
  }

  setPreset(p: Preset) {
    const l = LIGHTING[p.lighting] ?? LIGHTING.studio_soft;
    this.scene.environmentIntensity = l.env;
    this.key.intensity = l.key;
    this.key.color.set(l.warm ? "#fff1dc" : "#ffffff");
    this.fill.intensity = l.fill;
    this.rim.intensity = l.rim;
    this.renderer.toneMappingExposure = l.exposure;
    this.renderer.toneMapping = l.tone === "aces" ? THREE.ACESFilmicToneMapping : l.tone === "none" ? THREE.NoToneMapping : THREE.NeutralToneMapping;
    (this.catcher.material as THREE.ShadowMaterial).opacity = p.shadow ? p.shadow_opacity : 0;
    this.shadowLight.castShadow = p.shadow;
    this.shadowOn = p.shadow;
    this.rest();
    const bg = p.background;
    if (bg.type === "transparent") {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else if (bg.type === "gradient" && bg.colors.length >= 2) {
      this.scene.background = gradientTexture(bg.colors);
    } else {
      this.scene.background = new THREE.Color("#ffffff");
    }
  }

  setObject(obj: THREE.Object3D) {
    if (this.object) {
      this.inner.remove(this.object);
      disposeObject(this.object);
    }
    this.object = obj;
    this.inner.add(obj);
    // measure upright, then hang the pouch from its centre and put back the operator's turn
    const turned = this.turnable.quaternion.clone();
    this.turnable.quaternion.identity();
    this.turnable.position.set(0, 0, 0);
    this.inner.position.set(0, 0, 0);
    this.turnable.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    this.inner.position.copy(c).negate();
    this.turnable.position.copy(c);
    this.turnable.quaternion.copy(turned);
    this.rest();
    const span = Math.max(size.x, size.y, size.z);
    this.catcher.scale.set(span * 6, span * 6, 1);
    this.catcher.position.set(c.x, 0, c.z);
    this.blobBase.set(size.x * 1.15, Math.max(size.z, span * 0.12) * 1.5);
    this.blob.scale.set(this.blobBase.x * this.blobSpread, this.blobBase.y * this.blobSpread, 1);
    this.blob.position.set(c.x, 0.05, c.z);
    this.floor.scale.set(span * 5, span * 5, 1);
    this.floor.position.set(c.x, -0.05, c.z);
    this.fitFloor();
    // lights sized to the object, in rig space (the rig turns with the camera azimuth)
    this.target.position.copy(c);
    this.rig.position.set(c.x, 0, c.z);
    this.key.position.set(-span * 0.9, span * 1.6, span * 1.6);
    this.fill.position.set(span * 1.6, span * 0.6, span * 1.2);
    this.rim.position.set(span * 0.3, span * 1.4, -span * 2.0);
    this.shadowLight.position.set(c.x, span * 3, c.z + span * 0.35);
    const cam = this.shadowLight.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -span * 0.9;
    cam.right = cam.top = span * 0.9;
    cam.near = span * 0.5;
    cam.far = span * 6;
    cam.updateProjectionMatrix();
    this.shadowLight.shadow.needsUpdate = true;
  }

  /** Optional look overrides (debug / tuning): tone mapping, exposure, environment and key intensity. */
  tune(o: { tm?: string | null; exp?: number | null; env?: number | null; key?: number | null }) {
    if (o.tm) this.renderer.toneMapping = ({ aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping, agx: THREE.AgXToneMapping } as Record<string, THREE.ToneMapping>)[o.tm] ?? this.renderer.toneMapping;
    if (o.exp != null) this.renderer.toneMappingExposure = o.exp;
    if (o.env != null) this.scene.environmentIntensity = o.env;
    if (o.key != null) this.key.intensity = o.key;
  }

  /** Place the camera for a named view (or an explicit azimuth/elevation) so the object fills the frame. */
  frame(view: string | { az: number; el: number }, aspect: number, margin = 1.08) {
    const v = typeof view === "string" ? VIEWS[view] ?? VIEWS.front : view;
    const box = new THREE.Box3().setFromObject(this.object ?? this.scene);
    // a floating pouch: keep the floor under it in the picture, so the gap shows
    if (this.lift > 0 && this.object) box.expandByPoint(new THREE.Vector3((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2));
    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.camera.aspect = aspect;
    const az = THREE.MathUtils.degToRad(v.az), el = THREE.MathUtils.degToRad(v.el);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    this.rig.rotation.y = az;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    let dist = sphere.radius / Math.sin(vfov / 2);
    let target = center.clone();
    const corners = [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => new THREE.Vector3(
      i ? box.max.x : box.min.x, j ? box.max.y : box.min.y, k ? box.max.z : box.min.z))));
    // Fit the projected bounding box: a few passes of distance + re-centre.
    for (let pass = 0; pass < 4; pass++) {
      this.camera.position.copy(target).addScaledVector(dir, dist);
      this.camera.near = dist / 50;
      this.camera.far = dist * 20;
      this.camera.lookAt(target);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of corners) {
        const q = p.clone().project(this.camera);
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
      }
      const extent = Math.max((maxX - minX) / 2, (maxY - minY) / 2);
      // shift the target toward the projected centre, then scale the distance to the wanted extent
      const ndcCentre = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, 0.5).unproject(this.camera);
      const shift = ndcCentre.sub(this.camera.position).normalize().multiplyScalar(dist).add(this.camera.position).sub(target);
      target = target.add(shift.projectOnPlane(dir));
      dist *= (extent * margin) / 0.92;
    }
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    this.fitBackground();
    return target;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Render one view at an exact pixel size and return a PNG data URL. */
  snapshot(view: string | { az: number; el: number }, w: number, h: number, transparent = false): string {
    const overlayVisible = this.overlay.visible;
    this.overlay.visible = false;
    const bg = this.scene.background;
    if (transparent) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    }
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.frame(view, w / h);
    this.render();
    const url = this.renderer.domElement.toDataURL("image/png");
    this.scene.background = bg;
    this.overlay.visible = overlayVisible;
    return url;
  }

  /** The current view (as the operator left it) at `scale` x the canvas size, as a data URL:
   *  "png" is the pouch alone on a transparent background (no backdrop, no floor; its shadow stays),
   *  "jpeg" is the view with its background and floor (white where the view itself is transparent). */
  capture(scale = 2, kind: "png" | "jpeg" = "png"): string {
    const el = this.renderer.domElement;
    const w = el.clientWidth || el.width, h = el.clientHeight || el.height;
    const ratio = this.renderer.getPixelRatio();
    const overlayVisible = this.overlay.visible, floorVisible = this.floor.visible;
    const bg = this.scene.background;
    const clear = this.renderer.getClearColor(new THREE.Color()), clearAlpha = this.renderer.getClearAlpha();
    this.overlay.visible = false;
    if (kind === "png") {
      this.scene.background = null;
      this.floor.visible = false;
      this.renderer.setClearColor(0x000000, 0);
    }
    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(w, h, false);
    this.render();
    let url: string;
    if (kind === "png") url = el.toDataURL("image/png");
    else {
      // JPEG has no transparency: lay the render on white so see-through parts are not black
      const c = document.createElement("canvas");
      c.width = el.width;
      c.height = el.height;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(el, 0, 0);
      url = c.toDataURL("image/jpeg", 0.92);
    }
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.scene.background = bg;
    this.floor.visible = floorVisible;
    this.renderer.setClearColor(clear, clearAlpha);
    this.overlay.visible = overlayVisible;
    this.render();
    return url;
  }

  async exportGLB(): Promise<ArrayBuffer> {
    if (!this.object) throw new Error("nothing to export");
    const clone = this.object.clone(true);
    clone.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = bakeForExport(mesh.material as THREE.MeshPhysicalMaterial);
    });
    const result = await new GLTFExporter().parseAsync(clone, { binary: true, maxTextureSize: 2048 });
    return result as ArrayBuffer;
  }

  dispose() {
    this.renderer.dispose();
  }
}

/** glTF has no separate alpha map: bake the cut mask into the colour map's alpha (alphaMode MASK). */
function bakeForExport(mat: THREE.MeshPhysicalMaterial): THREE.Material {
  if (!mat || !(mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial || !mat.alphaMap || !mat.map?.image) return mat;
  const img = mat.map.image as HTMLImageElement | HTMLCanvasElement;
  const alpha = mat.alphaMap.image as HTMLCanvasElement;
  const w = Math.min(2048, img.width), h = Math.round((w * img.height) / img.width);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  x.drawImage(img, 0, 0, w, h);
  const a = document.createElement("canvas");
  a.width = w;
  a.height = h;
  const ax = a.getContext("2d")!;
  ax.drawImage(alpha, 0, 0, w, h);
  const cd = x.getImageData(0, 0, w, h), ad = ax.getImageData(0, 0, w, h);
  for (let p = 0; p < cd.data.length; p += 4) cd.data[p + 3] = ad.data[p];
  x.putImageData(cd, 0, 0);
  const out = mat.clone();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  out.map = t;
  out.alphaMap = null;
  out.alphaTest = 0.5;
  out.transparent = false;
  return out;
}
