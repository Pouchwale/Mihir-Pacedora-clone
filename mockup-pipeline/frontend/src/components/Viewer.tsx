// Interactive 3D viewer (results page): orbit, zoom, view presets, filled / flat, dimensions.
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
  const [size, setSize] = useState<{ x: number; y: number; z: number } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const firstBuild = useRef(true);

  // The scene as adjusted by the draft (or the job's saved adjustments when there is no draft).
  const effective: { geometry: GeometrySpec; textures: Record<string, SceneTexture> } = applyDraft(scene, draft ?? null);
  const draftKey = JSON.stringify(draft ?? null);

  // stage lifetime
  useEffect(() => {
    const stage = new Stage(canvas.current!);
    stageRef.current = stage;
    const oc = new OrbitControls(stage.camera, canvas.current!);
    oc.enableDamping = true;
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

  // scene settings (lighting, background, shadow): the viewer always shows a white studio background
  useEffect(() => {
    stageRef.current?.setPreset({ ...effective.geometry.preset, background: { type: "studio_white", colors: [], image: null } });
    stageRef.current?.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, effective.geometry.preset.lighting, effective.geometry.preset.shadow]);

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
  }, [scene, filled, draftKey]);

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
  return (
    <div className="stack">
      <div className="viewer" ref={wrap}>
        <canvas ref={canvas} />
        {busy && <div className="viewer-note">Building 3D model…</div>}
        {error && <div className="viewer-note msg bad">{error}</div>}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          {Object.keys(VIEW_LABELS).filter((v) => v in VIEWS).map((v) => <button key={v} onClick={() => goto(v)}>{VIEW_LABELS[v]}</button>)}
        </div>
        <div className="row">
          <label className="check"><input type="checkbox" checked={filled} onChange={(e) => setFilled(e.target.checked)} /> Filled</label>
          <label className="check"><input type="checkbox" checked={dims} onChange={(e) => setDims(e.target.checked)} /> Dimensions</label>
          <button onClick={() => snapshot(false)} disabled={busy} title="Save this view as a PNG at twice the screen size">Snapshot PNG</button>
          <button onClick={() => snapshot(true)} disabled={busy} title="Save this view with a transparent background">Transparent PNG</button>
        </div>
      </div>
      <div className="muted small">
        Keyline: {g.width_mm} × {g.height_mm} mm
        {g.gusset_full_mm ? ` · bottom gusset ${g.gusset_full_mm} mm` : ""}
        {g.side_gusset_full_mm ? ` · side gusset ${g.side_gusset_full_mm} mm` : ""}
        {size && <> · model size {filled ? "(filled)" : "(flat)"}: {size.x.toFixed(1)} × {size.y.toFixed(1)} × {size.z.toFixed(1)} mm (W × H × D)</>}
        {" · colours: "}{g.preset.lighting === "exact" ? "exact print colours" : `studio lighting (${g.preset.lighting.replace("_", " ")})`}
      </div>
    </div>
  );
}
