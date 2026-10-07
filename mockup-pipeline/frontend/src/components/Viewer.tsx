// Interactive 3D viewer (results page). Drag turns the pouch itself in any direction (grab its top-left
// corner and pull it down, it tips toward you), with a turntable spin, view presets, filled / flat,
// dimensions, a realistic or exact-colour look, and a scene panel for the background and the floor
// (studio, colour or your own picture).
// `draft` (the job page's adjustment panel) previews changes instantly: geometry edits rebuild the
// model client-side, artwork placement is a texture matrix, scene settings apply to the stage.
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { dimensionOverlay } from "../three/dimensions";
import { buildPouch, measure } from "../three/pouch";
import { Stage, VIEWS, type Backdrop, type Floor } from "../three/stage";
import type { GeometrySpec, SceneData, SceneTexture, WindowShape } from "../three/types";
import { applyDraft, type Draft } from "../three/draft";

const VIEW_LABELS: Record<string, string> = {
  front: "Front", back: "Back", three_quarter_left: "¾ left", three_quarter_right: "¾ right", top_down: "Top",
};
// views turn the pouch (the camera stays put): a turn about the vertical, then a tilt toward the camera
const VIEW_TURN: Record<string, { az: number; el: number }> = {
  front: { az: 0, el: 0 }, back: { az: 180, el: 0 }, three_quarter_left: { az: 35, el: 0 }, three_quarter_right: { az: -35, el: 0 }, top_down: { az: 0, el: -55 }, // top tipped back: seen from above
};

type Look = "realistic" | "exact";
const TURN_SPEED = 0.008; // radians per pixel dragged

interface Props {
  scene: SceneData;
  draft?: Draft | null;
  name?: string | null; // file name stem for snapshots (the item code)
  /** Given (the job page): the Window tool marks clear windows on the pouch and reports them here. */
  onWindows?: (windows: WindowShape[]) => void;
  /** A customer's share link: the Scene panel offers only dimension lines and filled / flat. */
  customer?: boolean;
}

type Tool = "wand" | "free" | "rect";
const TOOL_HELP: Record<Tool, string> = {
  wand: "Click a printed area (e.g. a white panel) — the area of that colour turns into a clear window.",
  free: "Press and draw around the part to make clear; let go to close the shape.",
  rect: "Drag a box over the part to make clear.",
};
const KIND_LABEL: Record<WindowShape["kind"], string> = { wand: "picked area", free: "free shape", rect: "rectangle" };

/** Load a picked file as an image element (kept in this browser only). */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error(`${file.name} is not an image this browser can read`));
    img.src = URL.createObjectURL(file);
  });
}

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const ICONS = {
  scene: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  full: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3",
  exit: "M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3",
  spin: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  reset: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  close: "M18 6 6 18M6 6l12 12",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  window: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 8h8v8H8z",
  wand: "M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5",
  free: "M3 17c3-6 6-9 9-6s5 2 9-4",
  rect: "M4 4h16v16H4z",
  trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
};

export default function Viewer({ scene, draft, name, onWindows, customer = false }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const controls = useRef<OrbitControls | null>(null);
  const spinRef = useRef(false);
  const [filled, setFilled] = useState(true);
  const [dims, setDims] = useState(false); // dimension lines: off until asked for
  const [look, setLook] = useState<Look>("realistic");
  const [shadow, setShadow] = useState(true);
  const [backdrop, setBackdropState] = useState<Backdrop>({ kind: "white", color: "#e8edf5", image: null, moves: false });
  const [floor, setFloorState] = useState<Floor>({ kind: "studio", color: "#d9d4cc", image: null, tile_mm: 300, moves: false, float_mm: 0 });
  // the Window tool: what a press on the pouch does while it is on, and the shape being drawn (screen px)
  const [tool, setTool] = useState<Tool | null>(null);
  const [tolerance, setTolerance] = useState(40);
  const [sketch, setSketch] = useState<{ kind: Tool; pts: [number, number][] } | null>(null);
  const [winPanel, setWinPanel] = useState(false);
  const windows: WindowShape[] = draft?.windows ?? [];
  const toolRef = useRef<{ tool: Tool | null; tolerance: number; add: (w: WindowShape) => void }>({ tool: null, tolerance: 40, add: () => undefined });
  toolRef.current = { tool: onWindows ? tool : null, tolerance, add: (w) => onWindows?.([...windows, w]) };
  const [panel, setPanel] = useState(false);
  const [full, setFull] = useState(false);
  const [spin, setSpin] = useState(false);
  const [size, setSize] = useState<{ x: number; y: number; z: number } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const firstBuild = useRef(true);
  const pendingView = useRef<string | null>(null);
  const gotoRef = useRef<(view: string) => void>(() => undefined);
  const setBackdrop = (b: Partial<Backdrop>) => setBackdropState((cur) => ({ ...cur, ...b }));
  const setFloor = (f: Partial<Floor>) => setFloorState((cur) => ({ ...cur, ...f }));

  // The scene as adjusted by the draft (or the job's saved adjustments when there is no draft).
  const adjusted: { geometry: GeometrySpec; textures: Record<string, SceneTexture> } = applyDraft(scene, draft ?? null);
  // "Realistic": studio lighting on the film's own material (the preset's, or soft studio light when the
  // preset prints exact colours); "Exact colours": unlit, every pixel the print colour.
  const lighting: GeometrySpec["preset"]["lighting"] = look === "exact" ? "exact" : adjusted.geometry.preset.lighting === "exact" ? "studio_soft" : adjusted.geometry.preset.lighting;
  const effective = { ...adjusted, geometry: { ...adjusted.geometry, preset: { ...adjusted.geometry.preset, lighting } } };
  const draftKey = JSON.stringify(draft ?? null);

  // stage lifetime
  useEffect(() => {
    const el = canvas.current!;
    const stage = new Stage(el);
    stageRef.current = stage;
    // the camera only zooms (scroll / pinch) and moves (right-drag / two fingers); a left drag turns the pouch
    const oc = new OrbitControls(stage.camera, el);
    oc.enableDamping = true;
    oc.enableRotate = false;
    oc.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    oc.touches = { ONE: null as unknown as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_PAN };
    oc.zoomToCursor = true;
    controls.current = oc;
    let raf = 0;
    let dirty = true; // render on demand: after a change, a resize, while easing or spinning
    oc.addEventListener("change", () => { dirty = true; });
    stage.invalidate = () => { dirty = true; };

    // drag to turn, with a little momentum after letting go
    const pointers = new Set<number>();
    let last: { x: number; y: number; t: number } | null = null;
    let vel = { x: 0, y: 0 };
    // Window tool: a press picks / draws on the pouch instead of turning it
    const ndc = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      return { x: ((x - r.left) / r.width) * 2 - 1, y: -((y - r.top) / r.height) * 2 + 1 };
    };
    const local = (e: PointerEvent): [number, number] => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    let drawing: { kind: Tool; pts: [number, number][]; screen: [number, number][]; face: string } | null = null;
    const finish = () => {
      const d = drawing;
      drawing = null;
      setSketch(null);
      if (!d) return;
      const r = el.getBoundingClientRect();
      const uv = (p: [number, number]) => stage.pick(ndc(p[0] + r.left, p[1] + r.top), d.face);
      if (d.kind === "rect") {
        const [a, b] = [d.screen[0], d.screen[d.screen.length - 1]];
        const corners = [uv(a), uv(b)];
        if (corners[0] && corners[1] && Math.abs(a[0] - b[0]) > 4 && Math.abs(a[1] - b[1]) > 4) {
          toolRef.current.add({ face: d.face as WindowShape["face"], kind: "rect", points: corners.map((c) => [c!.u, c!.v] as [number, number]) });
        }
      } else if (d.kind === "free") {
        const step = Math.max(1, Math.ceil(d.screen.length / 300)); // at most ~300 points
        const pts = d.screen.filter((_, i) => i % step === 0).map(uv).filter(Boolean).map((c) => [c!.u, c!.v] as [number, number]);
        if (pts.length >= 3) toolRef.current.add({ face: d.face as WindowShape["face"], kind: "free", points: pts });
      }
    };
    const down = (e: PointerEvent) => {
      pointers.add(e.pointerId);
      const t = toolRef.current.tool;
      if (t && e.button === 0 && pointers.size === 1) {
        const hit = stage.pick(ndc(e.clientX, e.clientY));
        if (!hit) return;
        if (t === "wand") {
          toolRef.current.add({ face: hit.face, kind: "wand", points: [[hit.u, hit.v]], tolerance: toolRef.current.tolerance });
          return;
        }
        try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        drawing = { kind: t, pts: [], screen: [local(e)], face: hit.face };
        setSketch({ kind: t, pts: [local(e)] });
        return;
      }
      if (e.button !== 0 || pointers.size > 1) { last = null; return; }
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      last = { x: e.clientX, y: e.clientY, t: performance.now() };
      vel = { x: 0, y: 0 };
      spinRef.current = false;
      setSpin(false);
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (drawing) {
        const p = local(e), q = drawing.screen[drawing.screen.length - 1];
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 3) return;
        drawing.screen = drawing.kind === "rect" ? [drawing.screen[0], p] : [...drawing.screen, p];
        setSketch({ kind: drawing.kind, pts: drawing.screen });
        return;
      }
      if (!last || pointers.size > 1) return;
      const dx = (e.clientX - last.x) * TURN_SPEED, dy = (e.clientY - last.y) * TURN_SPEED;
      const now = performance.now(), dt = Math.max(1, now - last.t);
      const cap = (v: number) => Math.max(-0.03, Math.min(0.03, v)); // radians per frame
      vel = { x: cap((dx / dt) * 16), y: cap((dy / dt) * 16) };
      last = { x: e.clientX, y: e.clientY, t: now };
      stage.turn(dx, dy);
      dirty = true;
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (drawing) { finish(); return; }
      if (last && performance.now() - last.t > 80) vel = { x: 0, y: 0 }; // held still before letting go
      last = null;
      el.style.cursor = "";
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    const resize = () => {
      const box = wrap.current!;
      const w = box.clientWidth, h = box.clientHeight;
      if (!w || !h) return; // hidden (a closed tab, a page still opening): keep the last good size
      stage.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
      stage.renderer.setSize(w, h, false);
      stage.camera.aspect = w / h;
      stage.camera.updateProjectionMatrix();
      stage.fitBackground();
      dirty = true;
      if (pendingView.current) gotoRef.current(pendingView.current); // the first view waited for a size
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap.current!);
    resize();
    let prev = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      if (spinRef.current) {
        stage.spin(dt * 0.6); // a turn in ~10 s
        dirty = true;
      } else if (!last && (Math.abs(vel.x) > 1e-4 || Math.abs(vel.y) > 1e-4)) {
        stage.turn(vel.x, vel.y);
        vel = { x: vel.x * 0.9, y: vel.y * 0.9 };
        dirty = true;
      }
      if (oc.update() || dirty) {
        stage.render();
        dirty = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    firstBuild.current = true;
    const onFull = () => { if (!document.fullscreenElement) setFull(false); };  // Esc / back leaves full screen
    document.addEventListener("fullscreenchange", onFull);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("fullscreenchange", onFull);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      oc.dispose();
      stage.dispose();
    };
  }, [scene]);

  // scene settings: lighting from the look, shadow, background and floor from the scene panel
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.setPreset({ ...effective.geometry.preset, shadow: shadow && effective.geometry.preset.shadow !== false, shadow_opacity: effective.geometry.preset.shadow_opacity || 0.3, background: { type: "studio_white", colors: [], image: null } });
    stage.setBackdrop(backdrop, floor);
    stage.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, lighting, shadow, backdrop, floor]);

  useEffect(() => { spinRef.current = spin; }, [spin]);

  // floating higher or lower: frame the pouch and the floor under it again (the turn stays)
  const firstFloat = useRef(true);
  useEffect(() => {
    if (firstFloat.current) { firstFloat.current = false; return; }
    const stage = stageRef.current;
    if (!stage?.object || !controls.current || !wrap.current) return;
    const center = stage.frame({ az: 0, el: VIEWS.front.el + 8 }, wrap.current.clientWidth / wrap.current.clientHeight, 1.25);
    controls.current.target.copy(center as THREE.Vector3);
    controls.current.update();
    stage.invalidate();
  }, [floor.float_mm]);

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
          setSize(measure(obj)); // upright, before the operator's turn applies
          stage.setObject(obj);
          stage.overlay.clear();
          stage.overlay.add(dimensionOverlay(effective.geometry, filled));
          stage.overlay.visible = dims;
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

  /** A named view: the pouch turned to face it, the camera framing it from the front. */
  const goto = (view: string) => {
    const stage = stageRef.current;
    if (!stage || !controls.current || !wrap.current) return;
    if (!wrap.current.clientWidth || !wrap.current.clientHeight) { pendingView.current = view; return; } // framed once it has a size
    pendingView.current = null;
    const t = VIEW_TURN[view] ?? VIEW_TURN.front;
    stage.resetTurn();
    stage.spin(THREE.MathUtils.degToRad(t.az));
    const aspect = wrap.current.clientWidth / wrap.current.clientHeight;
    const center = stage.frame({ az: 0, el: VIEWS.front.el + 8 }, aspect, 1.25);
    if (t.el) stage.turn(0, THREE.MathUtils.degToRad(t.el));
    controls.current.target.copy(center as THREE.Vector3);
    controls.current.update();
    stage.invalidate();
  };

  gotoRef.current = goto;

  // A PNG of the view as it is on screen (turn, filled / flat, draft edits), at 2x, optionally transparent.
  const snapshot = (kind: "png" | "jpeg") => {
    const stage = stageRef.current;
    if (!stage) return;
    const url = stage.capture(2, kind);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name ?? "pouch"}_${filled ? "filled" : "flat"}.${kind === "png" ? "png" : "jpg"}`;
    a.click();
    stage.invalidate();
  };

  const toggleFull = () => {
    // The viewer fills the window by itself (iPhone Safari has no element full screen, and some
    // browsers refuse or ignore it); where the browser allows, it also goes truly full screen.
    if (full) {
      setFull(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    } else {
      setFull(true);
      wrap.current?.requestFullscreen?.().catch(() => undefined);
    }
  };

  const pick = async (file: File | undefined, apply: (img: HTMLImageElement) => void) => {
    if (!file) return;
    try { apply(await loadImage(file)); } catch (e) { setError((e as Error).message); }
  };

  const g = effective.geometry;
  const dark = backdrop.kind === "dark" || (backdrop.kind === "image");
  const tile = (on: boolean, label: string, swatch: ReactNode, onClick: () => void, title?: string) => (
    <button className={`tile ${on ? "on" : ""}`} onClick={onClick} title={title ?? label}>
      <span className="tile-swatch">{swatch}</span>
      <span>{label}</span>
    </button>
  );
  const uploadTile = (on: boolean, img: HTMLImageElement | null, onFile: (f: File | undefined) => void, onSelect: () => void) => (
    <label className={`tile ${on ? "on" : ""}`} title="Use your own picture" onClick={(e) => { if (img && !on) { e.preventDefault(); onSelect(); } }}>
      <span className="tile-swatch" style={img ? { backgroundImage: `url(${img.src})` } : undefined}>{!img && <Icon d={ICONS.upload} />}</span>
      <span>{img ? "Picture" : "Upload"}</span>
      <input type="file" accept="image/*" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
    </label>
  );
  const toggle = (on: boolean, label: string, set: (v: boolean) => void, hint?: string) => (
    <label className="switch" title={hint}>
      <span>{label}</span>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <i />
    </label>
  );

  return (
    <div className="stack">
      <div className={`viewer viewer-${backdrop.kind} ${dark ? "viewer-dark" : ""} ${full ? "viewer-full" : ""} ${tool && onWindows ? "viewer-drawing" : ""}`} ref={wrap}>
        <canvas ref={canvas} />
        <div className="viewer-bar top">
          <div className="seg">
            {(["realistic", "exact"] as Look[]).map((l) => <button key={l} className={look === l ? "on" : ""} onClick={() => setLook(l)}>{l === "realistic" ? "Realistic" : "Exact colours"}</button>)}
          </div>
          <div className="seg">
            {onWindows && <button className={winPanel ? "on" : ""} onClick={() => { setWinPanel(!winPanel); setPanel(false); if (winPanel) setTool(null); }} title="Make parts of the pouch clear (a window)"><Icon d={ICONS.window} /> Window{windows.length ? ` (${windows.length})` : ""}</button>}
            <button className={panel ? "on" : ""} onClick={() => { setPanel(!panel); setWinPanel(false); setTool(null); }} title="Background, floor and display options"><Icon d={ICONS.scene} /> Scene</button>
            <button onClick={toggleFull} title={full ? "Leave full screen" : "Full screen"} aria-label="Full screen"><Icon d={full ? ICONS.exit : ICONS.full} /></button>
          </div>
        </div>

        {sketch && (
          <svg className="viewer-sketch">
            {sketch.kind === "rect" && sketch.pts.length > 1
              ? <rect x={Math.min(sketch.pts[0][0], sketch.pts[1][0])} y={Math.min(sketch.pts[0][1], sketch.pts[1][1])} width={Math.abs(sketch.pts[1][0] - sketch.pts[0][0])} height={Math.abs(sketch.pts[1][1] - sketch.pts[0][1])} />
              : <polygon points={sketch.pts.map((p) => p.join(",")).join(" ")} />}
          </svg>
        )}
        {winPanel && onWindows && (
          <aside className="viewer-panel">
            <div className="viewer-panel-head">
              <b>Clear window</b>
              <button className="icon-btn" onClick={() => { setWinPanel(false); setTool(null); }} aria-label="Close"><Icon d={ICONS.close} /></button>
            </div>
            <div className="viewer-panel-section">
              <div className="viewer-panel-label">Tool</div>
              <div className="tiles">
                {tile(tool === "wand", "Pick area", <Icon d={ICONS.wand} size={22} />, () => setTool(tool === "wand" ? null : "wand"), "Click a printed area to make it clear")}
                {tile(tool === "free", "Free shape", <Icon d={ICONS.free} size={22} />, () => setTool(tool === "free" ? null : "free"), "Draw around the part to make clear")}
                {tile(tool === "rect", "Rectangle", <Icon d={ICONS.rect} size={22} />, () => setTool(tool === "rect" ? null : "rect"), "Drag a box")}
              </div>
              <div className="viewer-panel-foot">{tool ? TOOL_HELP[tool] : "Choose a tool, then click or draw on the front or back of the pouch. Turn the pouch with the tool off."}</div>
              {tool === "wand" && (
                <label className="slider">
                  <span>Colour range <b>{tolerance}</b></span>
                  <input type="range" min={5} max={150} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
                </label>
              )}
            </div>
            <div className="viewer-panel-section">
              <div className="viewer-panel-label">Windows on this pouch</div>
              {windows.length === 0 && <div className="viewer-panel-foot">None yet.</div>}
              {windows.map((w, i) => (
                <div key={i} className="win-row">
                  <span>{i + 1}. {w.face} · {KIND_LABEL[w.kind]}</span>
                  <button className="icon-btn" onClick={() => onWindows(windows.filter((_, j) => j !== i))} aria-label="Remove window" title="Remove"><Icon d={ICONS.trash} /></button>
                </div>
              ))}
              {windows.length > 0 && (
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <button className="icon-btn" onClick={() => onWindows(windows.slice(0, -1))}>Undo last</button>
                  <button className="icon-btn" onClick={() => onWindows([])}>Clear all</button>
                </div>
              )}
              <div className="viewer-panel-foot">Shown here at once. <b>Apply and re-render</b> (beside the viewer) saves them into the renders, the GLB and share links.</div>
            </div>
          </aside>
        )}
        {panel && (
          <aside className={`viewer-panel ${customer ? "compact" : ""}`}>
            <div className="viewer-panel-head">
              <b>Scene</b>
              <button className="icon-btn" onClick={() => setPanel(false)} aria-label="Close"><Icon d={ICONS.close} /></button>
            </div>
            {!customer && <>
            <div className="viewer-panel-section">
              <div className="viewer-panel-label">Background</div>
              <div className="tiles">
                {tile(backdrop.kind === "white", "Studio", <span style={{ background: "#fff" }} />, () => setBackdrop({ kind: "white" }))}
                {tile(backdrop.kind === "gradient", "Gradient", <span style={{ background: "linear-gradient(#fdfdfe,#c9ced8)" }} />, () => setBackdrop({ kind: "gradient" }))}
                {tile(backdrop.kind === "dark", "Dark", <span style={{ background: "#20242c" }} />, () => setBackdrop({ kind: "dark" }))}
                {tile(backdrop.kind === "none", "None", <span className="checker" />, () => setBackdrop({ kind: "none" }), "Transparent (for PNGs)")}
                <label className={`tile ${backdrop.kind === "color" ? "on" : ""}`} title="Pick a colour">
                  <span className="tile-swatch"><span style={{ background: backdrop.color }} /></span>
                  <span>Colour</span>
                  <input type="color" value={backdrop.color} onChange={(e) => setBackdrop({ kind: "color", color: e.target.value })} onClick={() => setBackdrop({ kind: "color" })} />
                </label>
                {uploadTile(backdrop.kind === "image", backdrop.image, (f) => pick(f, (img) => setBackdrop({ kind: "image", image: img })), () => setBackdrop({ kind: "image" }))}
              </div>
              {backdrop.kind === "image" && toggle(backdrop.moves, "Moves with the pouch", (v) => setBackdrop({ moves: v }), "On: the picture pans as you turn the pouch, like walking round it. Off: it stays still.")}
            </div>
            <div className="viewer-panel-section">
              <div className="viewer-panel-label">Floor</div>
              <div className="tiles">
                {tile(floor.kind === "none", "None", <span className="checker" />, () => setFloor({ kind: "none" }))}
                {tile(floor.kind === "studio", "Studio", <span style={{ background: "radial-gradient(#ededf0 40%, #cfd3da)" }} />, () => setFloor({ kind: "studio" }))}
                <label className={`tile ${floor.kind === "color" ? "on" : ""}`} title="Pick a colour">
                  <span className="tile-swatch"><span style={{ background: floor.color }} /></span>
                  <span>Colour</span>
                  <input type="color" value={floor.color} onChange={(e) => setFloor({ kind: "color", color: e.target.value })} onClick={() => setFloor({ kind: "color" })} />
                </label>
                {uploadTile(floor.kind === "image", floor.image, (f) => pick(f, (img) => setFloor({ kind: "image", image: img })), () => setFloor({ kind: "image" }))}
              </div>
              {floor.kind === "image" && (
                <label className="slider">
                  <span>Picture size <b>{floor.tile_mm} mm</b></span>
                  <input type="range" min={50} max={1500} step={10} value={floor.tile_mm} onChange={(e) => setFloor({ tile_mm: Number(e.target.value) })} />
                </label>
              )}
              {floor.kind !== "none" && toggle(floor.moves, "Turns with the pouch", (v) => setFloor({ moves: v }), "On: the floor turns with the pouch like a turntable. Off: the floor stays still.")}
              <label className="slider">
                <span>Float above the floor <b>{floor.float_mm ? `${floor.float_mm} mm` : "off"}</b></span>
                <input type="range" min={0} max={300} step={5} value={floor.float_mm} onChange={(e) => setFloor({ float_mm: Number(e.target.value) })} />
              </label>
              {toggle(shadow, "Shadow", setShadow, "Soft contact shadow under the pouch")}
            </div>
            </>}
            <div className="viewer-panel-section">
              <div className="viewer-panel-label">Display</div>
              {toggle(filled, "Filled with product", setFilled, "Filled, or flat as made")}
              {toggle(dims, "Dimension lines", setDims)}
            </div>
            {!customer && <div className="viewer-panel-foot">Pictures stay in this browser; they are not uploaded.</div>}
          </aside>
        )}

        <div className="viewer-bar bottom">
          <div className="seg">
            {Object.keys(VIEW_LABELS).map((v) => <button key={v} onClick={() => { setSpin(false); goto(v); }}>{VIEW_LABELS[v]}</button>)}
            <button onClick={() => { setSpin(false); goto("front"); }} title="Stand the pouch back up, facing front" aria-label="Reset"><Icon d={ICONS.reset} /></button>
          </div>
          <div className="seg">
            <button className={spin ? "on" : ""} onClick={() => setSpin(!spin)} title="Turn the pouch all the way round"><Icon d={ICONS.spin} /> {spin ? "Stop" : "Spin 360°"}</button>
            <button onClick={() => snapshot("png")} disabled={busy} title="The pouch alone on a transparent background (PNG, twice the screen size)"><Icon d={ICONS.download} /> PNG</button>
            <button onClick={() => snapshot("jpeg")} disabled={busy} title="This view with its background and floor (JPEG, twice the screen size)"><Icon d={ICONS.download} /> JPEG</button>
          </div>
        </div>
        {busy && <div className="viewer-note"><span className="spinner" /> Building 3D model…</div>}
        {error && <div className="viewer-note msg bad">{error}</div>}
        <div className="viewer-hint">{tool && onWindows ? TOOL_HELP[tool] : "Drag the pouch to turn it any way · right-drag to move · scroll to zoom"}</div>
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
