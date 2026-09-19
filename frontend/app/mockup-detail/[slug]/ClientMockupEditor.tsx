"use client";

import dynamic from "next/dynamic";
import { Header } from "@/components/layout/Header";
import { useEditorStore } from "@/store/useEditorStore";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { CustomerDisclaimer } from "@/components/ui/CustomerDisclaimer";
import { DielineWorkspace } from "@/components/dieline/DielineWorkspace";
import { DielineSync } from "@/components/dieline/DielineSync";

// three.js and the editor panels are large, browser-only bundles. They are split out of the page,
// but their download starts together with the model fetch (see preloadEditorCode) instead of
// waiting until the model has loaded, which used to create a second, sequential loading step.
const loadCanvasArea = () => import("@/components/editor/CanvasArea").then((m) => m.CanvasArea);
const loadLeftPanel = () => import("@/components/editor/LeftPanel").then((m) => m.LeftPanel);
const loadRightPanel = () => import("@/components/editor/RightPanel").then((m) => m.RightPanel);
const preloadEditorCode = () => Promise.all([loadCanvasArea(), loadLeftPanel(), loadRightPanel()]);

const CanvasArea = dynamic(loadCanvasArea, {
  ssr: false,
  loading: () => <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Loading 3D viewer...</div>,
});
const LeftPanel = dynamic(loadLeftPanel, { ssr: false });
const RightPanel = dynamic(loadRightPanel, { ssr: false });

const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** Fetches the model in the same string format the editor store expects (OBJ text or GLB data URL). */
async function fetchModelData(template: any): Promise<{ data: string; fileName: string } | null> {
  // A model file shipped with the app takes priority (same as before); designs saved from a
  // built-in shape keep that shape's file name, which the editor uses to pick pouch features.
  if (template.modelFile && template.hasShippedModel) {
    const res = await fetch(`/models/${template.modelFile}`);
    if (res.ok) {
      const lower = template.modelFile.toLowerCase();
      const data = lower.endsWith(".glb") || lower.endsWith(".gltf")
        ? await blobToDataURL(await res.blob())
        : await res.text();
      return { data, fileName: template.modelFile };
    }
  }
  // User-uploaded models are stored in the database
  if (template.hasObjData) {
    const res = await fetch(`/api/templates/${encodeURIComponent(template.slug)}/model`);
    if (!res.ok) throw new Error("Failed to load model data");
    const data = await res.text();
    const baseName = template.modelFile || template.name || "custom-model";
    const lower = baseName.toLowerCase();
    const fileName = data.startsWith("data:") && !lower.endsWith(".glb") && !lower.endsWith(".gltf") ? `${baseName}.glb` : baseName;
    return { data, fileName };
  }
  if (template.modelFile) console.warn(`Model file not found: ${template.modelFile}`);
  return null;
}

async function fetchDocumentData(template: any): Promise<string | null> {
  if (!template.hasDocument) return null;
  const res = await fetch(`/api/templates/${encodeURIComponent(template.slug)}/document`);
  // Fail loudly: continuing without the brief would remove it on the next save
  if (!res.ok) throw new Error("Failed to load the attached brief. Please try again.");
  return (await res.json()).documentData ?? null;
}

export function ClientMockupEditor({
  template: initialTemplate,
  approvalRequestId,
}: {
  template: any;
  approvalRequestId?: string | null;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Template with the lazily fetched document attached (Header saves it back with the design)
  const [template, setTemplate] = useState<any>(initialTemplate);
  const { data: session } = useSession();

  // Custom models uploaded in the editor are kept in this browser's storage. Clear them when a
  // different account uses the browser, so one user never sees another user's uploads.
  const sessionUserId = (session?.user as any)?.id as string | undefined;
  useEffect(() => {
    if (!sessionUserId) return;
    const clearIfOtherUser = () => {
      try {
        const owner = localStorage.getItem("editor-storage-owner");
        if (owner !== sessionUserId) {
          if (owner) useEditorStore.setState({ customTemplates: [] });
          localStorage.setItem("editor-storage-owner", sessionUserId);
        }
      } catch {
        useEditorStore.setState({ customTemplates: [] });
      }
    };
    if (useEditorStore.persist.hasHydrated()) {
      clearIfOtherUser();
      return;
    }
    return useEditorStore.persist.onFinishHydration(clearIfOtherUser);
  }, [sessionUserId]);

  // Determine if logged-in user is a Customer
  const isCustomer = session && (session.user as any)?.accountType === "Customer";

  const isHeadOfDesigner = session && (session.user as any)?.accountType === "Head of Designer";
  const editorView = useEditorStore((s) => s.editorView);

  // Initialize store with template data
  useEffect(() => {
    const template = initialTemplate;
    if (!template) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    // Model, document and editor code all download in parallel; the editor renders once all are ready
    Promise.all([fetchModelData(template), fetchDocumentData(template), preloadEditorCode()]).then(([model, documentData]) => {
      if (cancelled) return;

      // Reset all customize settings to default to prevent parameters leaking between presets
      useEditorStore.getState().resetToDefault();

      // Set the OBJ and file name if available
      if (model) {
        useEditorStore.getState().setObjModel(model.data, model.fileName);
      }

      // If the template has editorState, apply it
      let state = template.editorState;
      if (typeof state === "string") {
        try {
          state = JSON.parse(state);
        } catch (e) {
          console.error("Failed to parse editor state", e);
        }
      }

      if (state && typeof state === "object") {
        // Background
        if (state.bgColor) useEditorStore.getState().setBgColor(state.bgColor);
        if (state.bgType) useEditorStore.getState().setBgType(state.bgType);
        if (state.showGrid !== undefined) useEditorStore.getState().setToggle("showGrid", state.showGrid);
        if (state.showShadow !== undefined) useEditorStore.getState().setToggle("showShadow", state.showShadow);
        if (state.enableFloat !== undefined) useEditorStore.getState().setToggle("enableFloat", state.enableFloat);

        // Lighting
        if (state.keyLightIntensity !== undefined) useEditorStore.getState().setLightIntensity("keyLightIntensity", state.keyLightIntensity);
        if (state.fillLightIntensity !== undefined) useEditorStore.getState().setLightIntensity("fillLightIntensity", state.fillLightIntensity);
        if (state.rimLightIntensity !== undefined) useEditorStore.getState().setLightIntensity("rimLightIntensity", state.rimLightIntensity);
        if (state.ambientLightIntensity !== undefined) useEditorStore.getState().setLightIntensity("ambientLightIntensity", state.ambientLightIntensity);

        // Model transform
        if (state.scale !== undefined) useEditorStore.getState().setScale(state.scale);
        if (state.rotation !== undefined) useEditorStore.getState().setRotation(state.rotation);
        if (state.sizeScale !== undefined) useEditorStore.getState().setSizeScale(state.sizeScale);

        // Modifications
        if (state.punchType !== undefined) useEditorStore.getState().setToggle("punchType", state.punchType);
        if (state.punchSize !== undefined) useEditorStore.getState().setToggle("punchSize", state.punchSize);
        if (state.punchPositionY !== undefined) useEditorStore.getState().setToggle("punchPositionY", state.punchPositionY);
        if (state.cornerStyles !== undefined) useEditorStore.getState().setToggle("cornerStyles", state.cornerStyles);
        if (state.cornerSizes !== undefined) useEditorStore.getState().setToggle("cornerSizes", state.cornerSizes);
        if (state.linkCorners !== undefined) useEditorStore.getState().setToggle("linkCorners", state.linkCorners);
        if (state.isAnimationFrozen !== undefined) useEditorStore.getState().setToggle("isAnimationFrozen", state.isAnimationFrozen);
        if (state.isClearPlastic !== undefined) useEditorStore.getState().setToggle("isClearPlastic", state.isClearPlastic);
        if (state.spoutSize !== undefined) useEditorStore.getState().setToggle("spoutSize", state.spoutSize);
        if (state.isOneSideClearPlastic !== undefined) useEditorStore.getState().setToggle("isOneSideClearPlastic", state.isOneSideClearPlastic);
        if (state.windowCutouts !== undefined && Array.isArray(state.windowCutouts)) {
          state.windowCutouts.forEach((w: any) => {
            // Older designs stored the window's top-left corner; windows are now centre-anchored
            const migrated = w.anchor === 'center'
              ? w
              : { ...w, x: (w.x ?? 0) + (w.width ?? 0) / 2, y: (w.y ?? 0) + (w.height ?? 0) / 2, anchor: 'center' };
            useEditorStore.getState().addWindowCutout(migrated);
          });
        }

        // Background image, table, light colours/positions, model position and artwork transforms
        const extraKeys = [
          "bgImage", "showTable", "tableTexture", "floorImage", "floorFit", "floorSize", "floorTiles",
          "filmFinish", "innerLayer",
          "floorOffsetX", "floorOffsetZ", "floorRotation", "bgScale", "bgOffsetX", "bgOffsetY",
          "dieline", "insideTextures",
          "keyLightColor", "keyLightPosition", "keyLightFocus",
          "fillLightColor", "fillLightPosition", "fillLightFocus",
          "rimLightColor", "rimLightPosition", "rimLightFocus",
          "ambientLightColor", "modelPosition",
        ];
        const extras: Record<string, any> = {};
        extraKeys.forEach((key) => {
          if (state[key] !== undefined) extras[key] = state[key];
        });
        useEditorStore.setState(extras);

        // Textures
        if (state.textures) {
          Object.keys(state.textures).forEach((slot) => {
            useEditorStore.getState().setTexture(
              slot as any,
              state.textures[slot]
            );
          });
        }

        // Materials
        if (state.materials) {
          Object.keys(state.materials).forEach((group) => {
            useEditorStore.getState().updateMaterial(
              group,
              state.materials[group]
            );
          });
        }

        // The old "Transparent" add-ons faded the whole print (opacity 0.4); they are now frosted film
        if (!state.isClearPlastic && !state.isOneSideClearPlastic && state.materials && !state.filmFinish) {
          const opacity = (side: string) => state.materials[side]?.opacity ?? 1;
          if (opacity("Front") < 1) {
            const allSides = opacity("Back") < 1;
            ["Front", "Back", "Left", "Right", "Top", "Bottom"].forEach((side) => useEditorStore.getState().updateMaterial(side, { opacity: 1 }));
            useEditorStore.getState().setToggle(allSides ? "isClearPlastic" : "isOneSideClearPlastic", true);
            useEditorStore.setState({ filmFinish: "frosted" });
          }
        }

        if (state.textureTransforms && typeof state.textureTransforms === "object") {
          useEditorStore.setState({ textureTransforms: state.textureTransforms });
        }
      }

      // Initialize attached document from template if present
      if (template.documentName || documentData) {
        useEditorStore.getState().setDocument(template.documentName || null, documentData);
      } else {
        useEditorStore.getState().setDocument(null, null);
      }

      setTemplate({ ...template, documentData });
      setLoading(false);
    }).catch((err) => {
      console.error("Failed to load template assets:", err);
      if (!cancelled) setLoadError(err.message || "Failed to load template");
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTemplate?.id]);

  if (loadError) {
    return (
      <div className="flex flex-col h-screen w-screen items-center justify-center gap-3 bg-background">
        <div className="text-red-500 text-sm">{loadError}</div>
        <button onClick={() => window.location.reload()} className="text-xs font-bold text-brand-600 hover:underline">
          Try again
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col h-screen w-screen items-center justify-center gap-3 bg-background">
        <div className="h-8 w-8 rounded-full border-2 border-slate-200 border-t-brand-600 animate-spin" />
        <div className="text-sm text-slate-500">Loading template...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-white">
      <Header template={template} />
      <div className="flex flex-1 overflow-hidden relative">
        {!isCustomer && editorView === '3d' && <LeftPanel />}
        {!isCustomer && editorView === 'dieline' && <DielineWorkspace />}
        {!isCustomer && <DielineSync />}
        <CanvasArea template={template} compact={editorView === 'dieline'} />
        {isCustomer && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-slate-900/90 text-white px-3.5 py-1.5 rounded-full text-[10px] font-bold tracking-wider uppercase flex items-center gap-1.5 shadow backdrop-blur-sm border border-slate-700 animate-pulse">
            🔒 Viewer Mode (Read-Only)
          </div>
        )}
        {isHeadOfDesigner && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-teal-700/90 text-white px-3.5 py-1.5 rounded-full text-[10px] font-bold tracking-wider uppercase flex items-center gap-1.5 shadow backdrop-blur-sm border border-teal-600 select-none">
            🎨 Head of Designer
          </div>
        )}
        {session && (session.user as any)?.accountType === "Administrator" && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-brand-600/90 text-white px-3.5 py-1.5 rounded-full text-[10px] font-bold tracking-wider uppercase flex items-center gap-1.5 shadow backdrop-blur-sm border border-brand-500 select-none">
            👑 Administrator (Full Access)
          </div>
        )}
        {!isCustomer && editorView === '3d' && <RightPanel />}
        {isCustomer && (
          <CustomerDisclaimer className="absolute bottom-0 inset-x-0 z-40 bg-white/95 border-t border-red-200 py-2 shadow-sm" />
        )}
      </div>
    </div>
  );
}
