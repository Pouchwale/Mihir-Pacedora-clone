// Dimension overlay for the viewer: nominal keyline dimensions drawn in mm next to the model.
import * as THREE from "three";
import type { GeometrySpec } from "./types";

function label(text: string, heightMm: number): THREE.Sprite {
  const c = document.createElement("canvas");
  const x = c.getContext("2d")!;
  const font = 64;
  x.font = `600 ${font}px system-ui, sans-serif`;
  c.width = Math.ceil(x.measureText(text).width) + 40;
  c.height = font + 30;
  x.font = `600 ${font}px system-ui, sans-serif`;
  x.fillStyle = "rgba(255,255,255,0.92)";
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#1f5bd6";
  x.textBaseline = "middle";
  x.fillText(text, 20, c.height / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  s.scale.set((heightMm * c.width) / c.height, heightMm, 1);
  s.renderOrder = 10;
  return s;
}

function line(points: THREE.Vector3[]): THREE.Line {
  // transparent: drawn after the see-through studio floor (drawn before it, the floor hid the lines' lower half)
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: "#1f5bd6", depthTest: false, depthWrite: false, transparent: true }));
  l.renderOrder = 9;
  return l;
}

function dim(a: THREE.Vector3, b: THREE.Vector3, offset: THREE.Vector3, text: string, size: number): THREE.Group {
  const g = new THREE.Group();
  const a2 = a.clone().add(offset), b2 = b.clone().add(offset);
  const tick = offset.clone().normalize().multiplyScalar(size * 0.6);
  g.add(line([a, a2.clone().add(tick)]), line([b, b2.clone().add(tick)]), line([a2, b2]));
  const l = label(text, size);
  l.position.copy(a2.clone().add(b2).multiplyScalar(0.5).add(tick.clone().multiplyScalar(1.6)));
  g.add(l);
  return g;
}

/** Width at the top seal (exact in filled and flat state), height, gusset / side gusset depth. */
export function dimensionOverlay(g: GeometrySpec, filled: boolean): THREE.Group {
  const grp = new THREE.Group();
  const s = g.template === "shrink_sleeve" ? g.sleeve : null;
  if (s) {
    // a sleeved container: its diameter, its height, and the band the sleeve covers (laid flat: layflat)
    const R = s.diameter_mm / 2, H = s.container_height_mm;
    // drawn through the axis (the outline seen from the front), so no line hides behind the body when it turns
    const size = Math.max(2 * R, H) * 0.035, off = size * 2.2, z = 0;
    const y0 = s.sleeve_from * H, y1 = y0 + s.sleeve_height_mm;
    grp.add(dim(new THREE.Vector3(-R, H, z), new THREE.Vector3(R, H, z), new THREE.Vector3(0, off, 0), `Ø ${Math.round(s.diameter_mm * 10) / 10} mm`, size));
    grp.add(dim(new THREE.Vector3(-R, 0, z), new THREE.Vector3(-R, H, z), new THREE.Vector3(-off, 0, 0), `${Math.round(H * 10) / 10} mm`, size));
    grp.add(dim(new THREE.Vector3(R, y0, z), new THREE.Vector3(R, Math.min(y1, H), z), new THREE.Vector3(off, 0, 0), `sleeve ${Math.round(s.sleeve_height_mm * 10) / 10} mm`, size));
    const t = label(`layflat ${s.layflat_mm} mm`, size * 0.8);
    t.position.set(0, -size * 1.6, z);
    grp.add(t);
    return grp;
  }
  const W = g.width_mm, H = g.height_mm;
  const size = Math.max(W, H) * 0.035;
  const off = size * 2.2;
  const zf = 1;
  grp.add(dim(new THREE.Vector3(-W / 2, H, zf), new THREE.Vector3(W / 2, H, zf), new THREE.Vector3(0, off, 0), `${W} mm`, size));
  grp.add(dim(new THREE.Vector3(-W / 2, 0, zf), new THREE.Vector3(-W / 2, H, zf), new THREE.Vector3(-off, 0, 0), `${H} mm`, size));
  if (g.gusset_full_mm) {
    const d = filled ? g.gusset_depth_mm : 0;
    const t = label(`gusset ${g.gusset_full_mm} mm (fold ${g.gusset_depth_mm} mm)`, size * 0.8);
    t.position.set(W / 2 + off * 2.5, size, d);
    grp.add(t);
  }
  if (g.side_gusset_full_mm) {
    const t = label(`side gusset ${g.side_gusset_full_mm} mm`, size * 0.8);
    t.position.set(W / 2 + off * 2.5, H / 2, 0);
    grp.add(t);
  }
  return grp;
}
