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
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: "#1f5bd6", depthTest: false }));
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
