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

export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, 1, 1, 20000);
  object: THREE.Object3D | null = null;
  overlay = new THREE.Group(); // dimension lines etc.: never exported
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
    this.scene.add(this.rig, this.target, this.shadowLight, this.overlay);
    this.catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.3 }));
    this.catcher.rotation.x = -Math.PI / 2;
    this.catcher.receiveShadow = true;
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, depthWrite: false, opacity: 0.55 }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.05;
    this.scene.add(this.catcher, this.blob);
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
    this.blob.visible = p.shadow;
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
      this.scene.remove(this.object);
      disposeObject(this.object);
    }
    this.object = obj;
    this.scene.add(obj);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z);
    this.catcher.scale.set(span * 6, span * 6, 1);
    this.catcher.position.set(c.x, 0, c.z);
    this.blob.scale.set(size.x * 1.15, Math.max(size.z, span * 0.12) * 1.5, 1);
    this.blob.position.set(c.x, 0.05, c.z);
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

  /** The current view (camera as the operator left it) at `scale` x the canvas size, as a PNG data URL. */
  capture(scale = 2, transparent = false): string {
    const el = this.renderer.domElement;
    const w = el.clientWidth || el.width, h = el.clientHeight || el.height;
    const ratio = this.renderer.getPixelRatio();
    const overlayVisible = this.overlay.visible;
    const bg = this.scene.background;
    this.overlay.visible = false;
    if (transparent) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    }
    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(w, h, false);
    this.render();
    const url = el.toDataURL("image/png");
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.scene.background = bg;
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
