// Headless render target (opened by the worker's Playwright, authorised by a signed token).
// Builds exactly the scene the viewer shows and exposes window.__render.
import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { buildPouch, disposeObject, measure } from "../three/pouch";
import { Stage } from "../three/stage";
import type { SceneData } from "../three/types";

declare global {
  interface Window {
    __render?: {
      ready?: boolean;
      error?: string;
      renderView?: (view: string, w: number, h: number, transparent: boolean) => string;
      exportGLB?: () => Promise<string>;
      turntableFrame?: (i: number, n: number, w: number, h: number) => string;
      measure?: () => { flat: { x: number; y: number; z: number }; filled: { x: number; y: number; z: number } };
    };
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export default function RenderPage() {
  const { jobId } = useParams();
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    window.__render = {};
    (async () => {
      try {
        const token = new URLSearchParams(window.location.search).get("token") ?? "";
        const res = await fetch(`/api/jobs/${jobId}/scene?token=${encodeURIComponent(token)}`);
        if (!res.ok) throw new Error(`scene ${res.status}: ${await res.text()}`);
        const data = (await res.json()) as SceneData;
        const stage = new Stage(canvas.current!);
        stage.setPreset(data.geometry.preset);
        const q = new URLSearchParams(window.location.search);
        const num = (k: string) => (q.get(k) ? Number(q.get(k)) : null);
        stage.tune({ tm: q.get("tm"), exp: num("exp"), env: num("env"), key: num("key") });
        stage.setObject(await buildPouch(data.geometry, data.textures, { filled: true }));
        const transparent = data.geometry.preset.background.type === "transparent";
        // Measured size of the built model, flat (as manufactured) and filled, for the job record.
        const flatModel = await buildPouch(data.geometry, data.textures, { filled: false });
        const flat = measure(flatModel);
        disposeObject(flatModel);
        const filled = measure(stage.object!);
        window.__render = {
          ready: true,
          measure: () => ({ flat, filled }),
          renderView: (view, w, h, t) => stage.snapshot(view, w, h, t),
          exportGLB: async () => toBase64(await stage.exportGLB()),
          turntableFrame: (i, n, w, h) => stage.snapshot({ az: (360 * i) / n, el: 10 }, w, h, transparent),
        };
      } catch (err) {
        window.__render = { error: String((err as Error)?.stack ?? err) };
      }
    })();
  }, [jobId]);

  return <canvas ref={canvas} width={1024} height={1024} style={{ display: "block" }} />;
}
