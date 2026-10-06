// Interactive 3D viewer (results page): free 360° orbit (and a turntable spin), view presets, filled /
// flat, dimensions, a realistic or exact-colour look, background and floor.
// `draft` (the job page's adjustment panel) previews changes instantly: geometry edits rebuild the
// model client-side, artwork placement is a texture matrix, scene settings apply to the stage.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { dimensionOverlay } from "../three/dimensions";
import { buildPouch, measure } from "../three/pouch";
import { Stage, VIEWS } from "../three/stage";
import type { GeometrySpec, SceneData, SceneTexture } from "../three/types";
import { applyDraft, type Draft } from "../three/draft";

const VIEW_LABELS: Record<string, string> = {
  front: "Front", back: "Back", three_quarter_left: "¾ left", three_quarter_right: "¾ right", top_down: "Top",
};

type Look = "realistic" | "exact";
type Backdrop = "white" | "gradient" | "dark" | "none";

interface Props {
  scene: SceneData;
  draft?: Draft | null;
  name?: string | null; // file name stem for snapshots (the item code)
}

export default function Viewer({ scene, draft, name }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const controls = useRef<OrbitControls | null>(null);
  const [filled, setFilled] = useState(true);
  const [dims, setDims] = useState(true);
  const [look, setLook] = useState<Look>("realistic");
  const [backdrop, setBackdrop] = useState<Backdrop>("white");
  const [floor, setFloor] = useState(true);
  const [spin, setSpin] = useState(false);
  const [size, setSize] = useState<{ x: number; y: number; z: number } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const firstBuild = useRef(true);

  // The scene as adjusted by the draft (or the job's saved adjustments when there is no draft).
  const adjusted: { geometry: GeometrySpec; textures: Record<string, SceneTexture> } = applyDraft(scene, draft ?? null);
  // "Realistic": studio lighting on the film's own material (the preset's, or soft studio light when the
  // preset prints exact colours); "Exact colours": unlit, every pixel the print colour.
  const lighting: GeometrySpec["preset"]["lighting"] = look === "exact" ? "exact" : adjusted.geometry.preset.lighting === "exact" ? "studio_soft" : adjusted.geometry.preset.lighting;
  const effective = { ...adjusted, geometry: { ...adjusted.geometry, preset: { ...adjusted.geometry.preset, lighting } } };
  const draftKey = JSON.stringify(draft ?? null);

  // stage lifetime
  useEffect(() => {
    const stage = new Stage(canvas.current!);
    stageRef.current = stage;
    const oc = new OrbitControls(stage.camera, canvas.current!);
    oc.enableDamping = true;
    oc.minPolarAngle = 0; // the full sphere: from above, all round, and from below
    oc.maxPolarAngle = Math.PI;
    oc.autoRotateSpeed = 4; // one turn in 15 s
    oc.zoomToCursor = true;
    controls.current = oc;
    let raf = 0;
    let dirty = true; // render on demand: after a change, a resize or while the orbit is easing
    oc.addEventListener("change", () => { dirty = true; });
    stageRef.current.invalidate = () => { dirty = true; };
    const resize = () => {
      const el = wrap.current!;
      const w = el.clientWidth, h = el.clientHeight;
      stage.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
      stage.renderer.setSize(w, h, false);
      stage.camera.aspect = w / h;
      stage.camera.updateProjectionMatrix();
      dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap.current!);
    resize();
    const loop = () => {
      if (oc.update() || dirty) {
        stage.render();
        dirty = false;
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    firstBuild.current = true;
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      oc.dispose();
      stage.dispose();
    };
  }, [scene]);

  // scene settings: lighting and shadow from the look, background and floor from the viewer's options
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.setPreset({ ...effective.geometry.preset, background: { type: "studio_white", colors: [], image: null } });
    stage.setBackdrop(backdrop, floor);
    stage.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, lighting, effective.geometry.preset.shadow, backdrop, floor]);

  useEffect(() => {
    if (controls.current) controls.current.autoRotate = spin;
  }, [spin, scene]);

  // (re)build the model; draft edits are debounced so sliders stay smooth
  useEffect(() => {
    let cancelled = false;
    const delay = firstBuild.current ? 0 : 250;
    const timer = window.setTimeout(() => {
      setBusy(true);
      setError("");
      buildPouch(effective.geometry, effective.textures, { filled })
        .then((obj) => {
          if (cancelled || !stageRef.current) return;
          const stage = stageRef.current;
          stage.setObject(obj);
          stage.overlay.clear();
          stage.overlay.add(dimensionOverlay(effective.geometry, filled));
          stage.overlay.visible = dims;
          setSize(measure(obj));
          if (firstBuild.current) goto("three_quarter_left");
          firstBuild.current = false;
          stage.invalidate();
        })
        .catch((e) => setError(String(e)))
        .finally(() => !cancelled && setBusy(false));
    }, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, filled, draftKey, lighting]);

  useEffect(() => {
    if (stageRef.current) {
      stageRef.current.overlay.visible = dims;
      stageRef.current.invalidate();
    }
  }, [dims]);

  const goto = (view: string) => {
    const stage = stageRef.current;
    if (!stage || !controls.current || !wrap.current) return;
    const aspect = wrap.current.clientWidth / wrap.current.clientHeight;
    const center = stage.frame(view, aspect, 1.25);
    controls.current.target.copy(center as THREE.Vector3);
    controls.current.update();
  };

  // A PNG of the view as it is on screen (camera, filled / flat, draft edits), at 2x, optionally transparent.
  const snapshot = (transparent: boolean) => {
    const stage = stageRef.current;
    if (!stage) return;
    const url = stage.capture(2, transparent);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name ?? "pouch"}_${filled ? "filled" : "flat"}${transparent ? "_transparent" : ""}.png`;
    a.click();
    stage.invalidate();
  };

  const g = effective.geometry;
  const seg = <T extends string>(value: T, options: [T, string][], set: (v: T) => void) => (
    <div className="seg">
      {options.map(([v, label]) => <button key={v} className={v === value ? "on" : ""} onClick={() => set(v)}>{label}</button>)}
    </div>
  );
  return (
    <div className="stack">
      <div className={`viewer viewer-${backdrop}`} ref={wrap}>
        <canvas ref={canvas} />
        <div className="viewer-bar top">
          {seg<Look>(look, [["realistic", "Realistic"], ["exact", "Exact colours"]], setLook)}
          {seg<Backdrop>(backdrop, [["white", "Studio"], ["gradient", "Gradient"], ["dark", "Dark"], ["none", "None"]], setBackdrop)}
          <div className="seg">
            <button className={floor ? "on" : ""} onClick={() => setFloor(!floor)} title="Show the studio floor">Floor</button>
            <button className={dims ? "on" : ""} onClick={() => setDims(!dims)} title="Dimension lines">Dimensions</button>
            <button className={filled ? "on" : ""} onClick={() => setFilled(!filled)} title="Filled with product, or flat as made">Filled</button>
          </div>
        </div>
        <div className="viewer-bar bottom">
          <div className="seg">
            {Object.keys(VIEW_LABELS).filter((v) => v in VIEWS).map((v) => <button key={v} onClick={() => { setSpin(false); goto(v); }}>{VIEW_LABELS[v]}</button>)}
          </div>
          <div className="seg">
            <button className={spin ? "on" : ""} onClick={() => setSpin(!spin)} title="Turn the pouch all the way round">{spin ? "Stop" : "Spin 360°"}</button>
            <button onClick={() => snapshot(false)} disabled={busy} title="Save this view as a PNG at twice the screen size">PNG</button>
            <button onClick={() => snapshot(true)} disabled={busy} title="Save this view with a transparent background">Transparent PNG</button>
          </div>
        </div>
        {busy && <div className="viewer-note">Building 3D model…</div>}
        {error && <div className="viewer-note msg bad">{error}</div>}
        <div className="viewer-hint">Drag to turn · right-drag to move · scroll to zoom</div>
      </div>
      <div className="muted small">
        Keyline: {g.width_mm} × {g.height_mm} mm
        {g.gusset_full_mm ? ` · bottom gusset ${g.gusset_full_mm} mm` : ""}
        {g.side_gusset_full_mm ? ` · side gusset ${g.side_gusset_full_mm} mm` : ""}
        {size && <> · model size {filled ? "(filled)" : "(flat)"}: {size.x.toFixed(1)} × {size.y.toFixed(1)} × {size.z.toFixed(1)} mm (W × H × D)</>}
        {" · "}{look === "exact" ? "exact print colours" : `studio lighting (${lighting.replace("_", " ")})`}
      </div>
    </div>
  );
}
