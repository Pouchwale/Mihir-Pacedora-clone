// Material rule editor with a live preview sphere (three.js MeshPhysicalMaterial in a room environment).
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RuleGroup } from "../api";
import RuleGroups from "./RuleGroups";

type Data = Record<string, unknown>;
type Settings = Record<string, number | null | undefined>;

const SETTINGS: [string, string, number, number, number][] = [
  // key, label, min, max, default shown when unset
  ["roughness", "Roughness", 0, 1, 0.5], ["metalness", "Metalness", 0, 1, 0], ["clearcoat", "Clearcoat", 0, 1, 0], ["clearcoat_roughness", "Clearcoat roughness", 0, 1, 0.1],
  ["sheen", "Sheen", 0, 1, 0], ["specular_intensity", "Specular intensity", 0, 1, 0.5], ["transmission", "Transmission", 0, 1, 0], ["opacity", "Opacity", 0, 1, 1],
  ["ior", "Index of refraction", 1, 2.5, 1.5], ["normal_scale", "Grain (normal scale)", 0, 2, 0.35],
];
const SURFACES: [string, string][] = [["base", "Base: the whole printed film"], ["unprinted", "Unprinted areas"], ["white_less", "No white underlay (metallised film shows)"], ["window", "Transparent window"], ["spot", "Spot varnish mask"]];

export default function MaterialEditor({ data, onChange }: { data: Data; onChange: (d: Data) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...data, [k]: v });
  const settings = (data.settings ?? {}) as Settings;
  const setSetting = (k: string, v: number | null) => set("settings", { ...settings, [k]: v });
  return (
    <div className="stack">
      <div className="card grid2">
        <label className="field">Name<input value={String(data.name ?? "")} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="field">Surface<select value={String(data.surface ?? "base")} onChange={(e) => set("surface", e.target.value)}>{SURFACES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field">Priority (rules apply in this order; later ones override)<input type="number" value={Number(data.priority ?? 100)} onChange={(e) => set("priority", Number(e.target.value))} /></label>
      </div>
      <div className="mat-layout">
        <div className="card stack">
          <h2>Settings <span className="muted small">unticked = left to other rules</span></h2>
          {SETTINGS.map(([k, label, min, max, dflt]) => {
            const on = settings[k] !== null && settings[k] !== undefined;
            const v = on ? Number(settings[k]) : dflt;
            return (
              <div key={k} className="mat-row">
                <label className="check small"><input type="checkbox" checked={on} onChange={(e) => setSetting(k, e.target.checked ? dflt : null)} /> {label}</label>
                <input type="range" min={min} max={max} step={0.01} value={v} disabled={!on} onChange={(e) => setSetting(k, Number(e.target.value))} />
                <input type="number" min={min} max={max} step={0.01} value={on ? v : ""} disabled={!on} onChange={(e) => setSetting(k, Number(e.target.value))} style={{ width: 72 }} />
              </div>
            );
          })}
        </div>
        <div className="card stack">
          <h2>Preview</h2>
          <Sphere settings={settings} />
          <div className="muted small">A print sample under studio light. Job renders default to exact print colours (no shading); this shows how the finish looks under a studio preset.</div>
        </div>
      </div>
      <div className="card">
        <h2>Applies when</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Empty = always. Conditions read the spec table (spec.finish, spec.layers_text, spec.transparent_window …).</p>
        <RuleGroups groups={(data.when ?? []) as RuleGroup[]} onChange={(g) => set("when", g)} emptyText="Always applies." />
      </div>
    </div>
  );
}

function Sphere({ settings }: { settings: Settings }) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef<{ renderer: THREE.WebGLRenderer; material: THREE.MeshPhysicalMaterial; render: () => void } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, 260);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const camera = new THREE.PerspectiveCamera(30, el.clientWidth / 260, 0.1, 100);
    camera.position.set(0, 0.6, 6);
    camera.lookAt(0, 0, 0);
    const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: printTexture() });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.25, 96, 64), material);
    scene.add(mesh);
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 4, 5);
    scene.add(key, new THREE.AmbientLight(0xffffff, 0.3));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.ShadowMaterial({ opacity: 0.15 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.3;
    scene.add(floor);
    let frame = 0;
    const render = () => { mesh.rotation.y += 0.004; renderer.render(scene, camera); frame = requestAnimationFrame(render); };
    render();
    state.current = { renderer, material, render };
    const onResize = () => { renderer.setSize(el.clientWidth, 260); camera.aspect = el.clientWidth / 260; camera.updateProjectionMatrix(); };
    window.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", onResize); pmrem.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); state.current = null; };
  }, []);

  useEffect(() => {
    const m = state.current?.material;
    if (!m) return;
    const v = (k: string, d: number) => (settings[k] === null || settings[k] === undefined ? d : Number(settings[k]));
    m.roughness = v("roughness", 0.5);
    m.metalness = v("metalness", 0);
    m.clearcoat = v("clearcoat", 0);
    m.clearcoatRoughness = v("clearcoat_roughness", 0.1);
    m.sheen = v("sheen", 0);
    m.specularIntensity = v("specular_intensity", 0.5);
    m.transmission = v("transmission", 0);
    m.opacity = v("opacity", 1);
    m.transparent = m.opacity < 1 || m.transmission > 0;
    m.ior = v("ior", 1.5);
    m.needsUpdate = true;
  }, [settings]);

  return <div ref={host} className="mat-sphere" />;
}

/** A small "printed" pattern so roughness, clearcoat and metal read against colour. */
function printTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f2efe8";
  g.fillRect(0, 0, 512, 512);
  const colours = ["#d7263d", "#1b4079", "#f4b400", "#1d7a46", "#222"];
  for (let i = 0; i < 5; i++) {
    g.fillStyle = colours[i];
    g.fillRect(40 + i * 90, 120, 60, 280);
  }
  g.fillStyle = "#222";
  g.font = "bold 48px sans-serif";
  g.fillText("POUCH", 60, 90);
  g.fillText("MOCKUP", 60, 460);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  return t;
}
