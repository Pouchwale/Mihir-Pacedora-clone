// The sign-in page's stage: real mockups built by the same code as every job (buildPouch: a stand-up
// pouch, a zipper pouch and a sleeved drink can), wearing Gujarat Print Pack artwork drawn here on a
// canvas, on a slowly turning glossy turntable under moving studio light. Drag turns the turntable.
// No job data: the artwork is the company's own brand, nothing from a customer.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { useEffect, useRef } from "react";
import { buildPouch } from "../three/pouch";
import type { GeometrySpec, SceneTexture } from "../three/types";

const RED = "#b01f24";
const DEEP = "#6e0f13";
const PX = 8; // canvas px per mm

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((ok) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => ok(null);
    im.src = src;
  });
}

/** Brand artwork for one panel, as a texture the pouch builder can load (a data URL). */
function art(wMm: number, hMm: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void): SceneTexture {
  const cv = document.createElement("canvas");
  cv.width = Math.round(wMm * PX);
  cv.height = Math.round(hMm * PX);
  draw(cv.getContext("2d")!, cv.width, cv.height);
  return { url: cv.toDataURL("image/png"), width_mm: wMm, height_mm: hMm, color: null, masks: {} };
}

const FONT = "'Segoe UI', system-ui, sans-serif";
function text(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, weight = 700, align: CanvasTextAlign = "center") {
  c.font = `${weight} ${size}px ${FONT}`;
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = "middle";
  c.fillText(s, x, y);
}

function logoPlate(c: CanvasRenderingContext2D, logo: HTMLImageElement | null, cx: number, cy: number, w: number) {
  if (!logo) return;
  const h = (w * logo.height) / logo.width, pad = w * 0.06;
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.roundRect(cx - w / 2 - pad, cy - h / 2 - pad, w + 2 * pad, h + 2 * pad, pad * 1.4);
  c.fill();
  c.drawImage(logo, cx - w / 2, cy - h / 2, w, h);
}

function redFront(logo: HTMLImageElement | null) {
  return art(130, 170, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#c8262c");
    g.addColorStop(0.55, RED);
    g.addColorStop(1, DEEP);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // sweeping ribbons
    c.globalAlpha = 0.18;
    c.fillStyle = "#ffffff";
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.moveTo(0, h * (0.58 + i * 0.08));
      c.bezierCurveTo(w * 0.35, h * (0.48 + i * 0.08), w * 0.65, h * (0.72 + i * 0.08), w, h * (0.6 + i * 0.08));
      c.lineTo(w, h * (0.63 + i * 0.08));
      c.bezierCurveTo(w * 0.65, h * (0.75 + i * 0.08), w * 0.35, h * (0.51 + i * 0.08), 0, h * (0.61 + i * 0.08));
      c.fill();
    }
    c.globalAlpha = 1;
    logoPlate(c, logo, w / 2, h * 0.22, w * 0.7);
    text(c, "GP3", w / 2, h * 0.47, w * 0.26, "#ffffff", 800);
    text(c, "PREMIUM FLEXIBLE PACKAGING", w / 2, h * 0.585, w * 0.052, "#ffe9ea", 600);
    text(c, "Pouches  |  Rolls  |  Sleeves", w / 2, h * 0.86, w * 0.05, "#ffffff", 500);
    text(c, "NET WT. 500 g", w / 2, h * 0.93, w * 0.04, "#ffd6d8", 600);
  });
}

function whiteFront(logo: HTMLImageElement | null) {
  return art(110, 160, (c, w, h) => {
    c.fillStyle = "#f7f7f8";
    c.fillRect(0, 0, w, h);
    c.fillStyle = RED;
    c.fillRect(0, h * 0.7, w, h * 0.3);
    c.fillStyle = DEEP;
    c.fillRect(0, h * 0.68, w, h * 0.02);
    logoPlate(c, logo, w / 2, h * 0.3, w * 0.72);
    text(c, "Gujarat Print Pack", w / 2, h * 0.5, w * 0.085, "#2a2a2e", 700);
    text(c, "Rotogravure printed laminates", w / 2, h * 0.565, w * 0.05, "#5b5b63", 500);
    text(c, "RESEALABLE", w / 2, h * 0.8, w * 0.085, "#ffffff", 800);
    text(c, "Zipper pouch", w / 2, h * 0.88, w * 0.055, "#ffe0e2", 500);
  });
}

function plain(wMm: number, hMm: number, color: string, label?: string) {
  return art(wMm, hMm, (c, w, h) => {
    c.fillStyle = color;
    c.fillRect(0, 0, w, h);
    if (label) text(c, label, w / 2, h / 2, Math.min(w, h) * 0.08, "rgba(255,255,255,.75)", 600);
  });
}

function canSleeve(logo: HTMLImageElement | null) {
  return art(182, 135, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#1d1d22");
    g.addColorStop(1, "#0f0f12");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = RED;
    c.beginPath();
    c.moveTo(0, h * 0.62);
    c.bezierCurveTo(w * 0.3, h * 0.5, w * 0.6, h * 0.78, w, h * 0.6);
    c.lineTo(w, h);
    c.lineTo(0, h);
    c.fill();
    // the front is the middle of the printed width
    logoPlate(c, logo, w / 2, h * 0.24, w * 0.3);
    text(c, "GP3", w / 2, h * 0.45, h * 0.15, "#ffffff", 800);
    text(c, "SHRINK SLEEVE", w / 2, h * 0.75, h * 0.055, "#ffffff", 700);
    text(c, "360° print", w / 2, h * 0.83, h * 0.045, "#ffe0e2", 500);
  });
}

const GLOSS = { roughness: 0.3, metalness: 0, clearcoat: 0.7, specular_intensity: 0.6, normal_scale: 0.2 };

function pouchSpec(w: number, h: number, gusset: number, zipper: boolean): GeometrySpec {
  return {
    version: 1, template: "stand_up_bottom_gusset", shape: "stand_up_bottom_gusset", width_mm: w, height_mm: h,
    gusset_full_mm: gusset, gusset_depth_mm: gusset / 2, side_gusset_full_mm: 0, side_gusset_depth_mm: 0,
    seals: { top: 10, bottom: 10, side: 8, fin: 0, crimp: 0 },
    zipper: { enabled: zipper, y_from_top_mm: 26, ridge_height_mm: 3 },
    tear_notch: { type: "v_notch", y_from_top_mm: 15, depth_mm: 4 }, butterfly_notch: false, corner_radius_mm: 6,
    hang_hole: { type: "none", size_mm: 8, offset_mm: 10 },
    window: { enabled: false, x_mm: 0, y_mm: 0, width_mm: 0, height_mm: 0, radius_mm: 0, shapes: [] },
    spout: null, valve: null, roll: null, sleeve: null, body_bulge_percent: 12, fill_level_percent: 85, outline_svg: null,
    panels: { front: { width_mm: w, height_mm: h }, back: { width_mm: w, height_mm: h }, gusset: { width_mm: w, height_mm: gusset } },
    materials: { surfaces: { base: GLOSS }, applied: { base: ["film_base"] } },
    preset: { name: "login", views: [], width_px: 0, height_px: 0, background: { type: "transparent", colors: [], image: null }, shadow: true, shadow_opacity: 0.3, lighting: "studio_soft", formats: [], turntable_seconds: 0, turntable_fps: 0, naming_pattern: "" },
    preset_key: "login", dimensions: [],
  };
}

function canSpec(): GeometrySpec {
  const base = pouchSpec(182, 135, 0, false);
  return {
    ...base, template: "shrink_sleeve", shape: "shrink_sleeve", width_mm: 182, height_mm: 135, panels: { sleeve: { width_mm: 182, height_mm: 135 } },
    sleeve: {
      container: "drink_can", name: "Drink can", shape: "can", chosen_by: "default", diameter_mm: 55, container_height_mm: 145,
      sleeve_height_mm: 135, printed_width_mm: 182, layflat_mm: 86.5, circumference_mm: 173, overlap_mm: 9, sleeve_from: 0.03, sleeve_to: 0.96,
      front_center_pct: 50, lid: false, neck_ratio: 0.4, body_color: "#cfd3d8", cap_color: "#c4c8ce", material: "metal",
    },
  };
}

export default function LoginScene() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current!;
    let alive = true;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.75;
    const camera = new THREE.PerspectiveCamera(28, 1, 10, 5000);
    const look = new THREE.Vector3(0, 70, -20);

    // light: a warm key that slowly sweeps round (moving highlights on the film), a red rim, a soft fill
    const key = new THREE.DirectionalLight("#fff4e8", 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 6;
    key.shadow.bias = -0.0004;
    Object.assign(key.shadow.camera, { left: -350, right: 350, top: 350, bottom: -350, near: 10, far: 2000 });
    scene.add(key, key.target);
    const rim = new THREE.PointLight("#ff3b42", 9e4, 1600, 2);
    rim.position.set(-260, 260, -320);
    const fill = new THREE.HemisphereLight("#ffffff", "#2a0d10", 0.6);
    scene.add(rim, fill);

    // the turntable: a dark glossy disc with a thin bright edge
    const table = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(300, 306, 18, 128), new THREE.MeshPhysicalMaterial({ color: "#16131a", roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08, metalness: 0.2 }));
    disc.position.y = -9;
    disc.receiveShadow = true;
    const edge = new THREE.Mesh(new THREE.TorusGeometry(303, 1.6, 12, 160), new THREE.MeshStandardMaterial({ color: RED, emissive: RED, emissiveIntensity: 1.2 }));
    edge.rotation.x = Math.PI / 2;
    table.add(disc, edge);
    const spinner = new THREE.Group(); // turns with the table: the products ride on it
    table.add(spinner);
    scene.add(table);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const items: { o: THREE.Object3D; t0: number }[] = [];
    (async () => {
      const logo = await loadImage("/gp3-logo.png");
      const red = redFront(logo), white = whiteFront(logo);
      const parts = await Promise.all([
        buildPouch(pouchSpec(130, 170, 70, false), { front: red, back: red, gusset: plain(130, 70, DEEP) }, { filled: true }),
        buildPouch(pouchSpec(110, 160, 60, true), { front: white, back: white, gusset: plain(110, 60, RED) }, { filled: true }),
        buildPouch(canSpec(), { sleeve: canSleeve(logo) }, { filled: true }),
      ]).catch(() => null);
      if (!alive || !parts) return;
      const spots: [number, number, number][] = [[0, 0, 40], [-170, -55, -60], [170, 25, -20]]; // x, z, turn (deg)
      parts.forEach((o, i) => {
        const box = new THREE.Box3().setFromObject(o);
        const c = box.getCenter(new THREE.Vector3());
        const holder = new THREE.Group();
        o.position.set(-c.x, -box.min.y, -c.z); // centred, standing on the table
        holder.add(o);
        holder.position.set(spots[i][0], 0, spots[i][1]);
        holder.rotation.y = THREE.MathUtils.degToRad(spots[i][2]) + (i === 0 ? 0 : Math.atan2(-spots[i][0], 400));
        o.traverse((m) => { if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; } });
        spinner.add(holder);
        items.push({ o: holder, t0: performance.now() + i * 180 });
      });
    })();

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // drag turns the table; it keeps its momentum, then eases back to the slow showroom turn
    const SHOW = reduced ? 0 : 0.18; // rad/s
    let vel = SHOW, dragX: number | null = null, lastT = 0;
    const pointer = { x: 0, y: 0 }, eased = { x: 0, y: 0 };
    const down = (e: PointerEvent) => { dragX = e.clientX; lastT = performance.now(); el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing"; };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1;
      if (dragX === null) return;
      const now = performance.now(), dx = (e.clientX - dragX) * 0.008;
      table.rotation.y += dx;
      vel = (dx / Math.max(1, now - lastT)) * 1000;
      dragX = e.clientX;
      lastT = now;
    };
    const up = () => { dragX = null; el.style.cursor = ""; };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);

    let raf = 0, prev = performance.now();
    const start = prev;
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const t = (now - start) / 1000;
      if (dragX === null) {
        vel += (SHOW - vel) * Math.min(1, dt * 1.5);
        table.rotation.y += vel * dt;
      }
      // products drop onto the table one after another
      for (const it of items) {
        const k = reduced ? 1 : Math.min(1, Math.max(0, (now - it.t0) / 900));
        const ease = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // ease-out-back
        it.o.position.y = (1 - ease) * 260;
        it.o.scale.setScalar(0.001 + 0.999 * Math.min(1, k * 1.6));
      }
      // the key light circles slowly; the camera leans toward the pointer
      const a = reduced ? 0.8 : 0.8 + t * 0.25;
      key.position.set(Math.cos(a) * 420, 520, Math.sin(a) * 420 + 200);
      eased.x += (pointer.x - eased.x) * 0.05;
      eased.y += (pointer.y - eased.y) * 0.05;
      const wide = camera.aspect >= 1;
      const dist = wide ? 840 : 1150;
      camera.position.set(eased.x * 70, 230 - eased.y * 35, dist);
      camera.lookAt(look);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      renderer.dispose();
      pmrem.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);
  return <div ref={host} className="login-scene" aria-hidden="true" />;
}
