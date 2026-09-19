"use client";

import { useEffect, useRef } from "react";
import { useEditorStore } from "@/store/useEditorStore";
import { renderSideTextures } from "@/lib/dieline/render";
import { pouchSizeFromScale } from "@/lib/dieline/layout";

// Keeps the 3D side textures (front, back, bottom) in step with the 2D dieline. Runs whenever the
// dieline, its keyline or the pouch size changes, a short moment after the last change.
export function DielineSync() {
  const dieline = useEditorStore((s) => s.dieline);
  const sizeScale = useEditorStore((s) => s.sizeScale);
  const runId = useRef(0);

  useEffect(() => {
    if (!dieline) return;
    const id = ++runId.current;
    const timer = setTimeout(async () => {
      try {
        const size = pouchSizeFromScale(sizeScale);
        const [outside, inside] = await Promise.all([
          renderSideTextures(dieline, size, "outside"),
          renderSideTextures(dieline, size, "inside"),
        ]);
        if (id !== runId.current) return; // a newer change is already being rendered
        const st = useEditorStore.getState();
        const same = (a: string | null, b: string | null) => a === b;
        const texturesChanged = !same(st.textures.front, outside.front) || !same(st.textures.back, outside.back) || !same(st.textures.bottom, outside.bottom);
        const insideChanged = !same(st.insideTextures.front, inside.front) || !same(st.insideTextures.back, inside.back) || !same(st.insideTextures.bottom, inside.bottom);
        if (!texturesChanged && !insideChanged) return;
        const identity = { rotation: 0, flipX: false, flipY: false };
        useEditorStore.setState({
          textures: { ...st.textures, front: outside.front, back: outside.back, bottom: outside.bottom },
          textureTransforms: { ...st.textureTransforms, front: identity, back: identity, bottom: identity },
          insideTextures: inside,
        });
      } catch (e) {
        console.error("Dieline render failed", e);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [dieline, sizeScale]);

  return null;
}
