import { useState, useEffect } from "react";
import Viewer from "./Viewer";
import { api, ApiError } from "../api";
import type { SceneData } from "../three/types";

type Dict = Record<string, any>;

interface KeylineWorkspaceProps {
  jobId: number;
  job: Dict;
  outputs: Dict;
  liveScene: SceneData | null;
  onRefresh: () => void;
  onSwitchTo3D: () => void;
}

const COLOR_SWATCHES = [
  { name: "White", hex: "#FFFFFF" },
  { name: "Cream", hex: "#F8F5EE" },
  { name: "Yellow", hex: "#FACC15" },
  { name: "Craft", hex: "#D97706" },
  { name: "Emerald", hex: "#059669" },
  { name: "Navy", hex: "#1E3A8A" },
  { name: "Silver", hex: "#94A3B8" },
  { name: "Black", hex: "#18181B" },
];

const fileUrl = (jobId: number, key: string) => `/api/jobs/${jobId}/file?key=${encodeURIComponent(key)}`;

interface PanelConfig {
  source: "auto" | "sheet" | "file" | "front" | "plain";
  sheet_panel: number | null;
  file_id: number | null;
  fit: "cover" | "contain" | "stretch";
  offset_x_mm: number;
  offset_y_mm: number;
  scale: number;
  rotation: number;
  flip_x: boolean;
  flip_y: boolean;
  color?: string;
}

const DEFAULT_PANEL_CONFIG: PanelConfig = {
  source: "auto",
  sheet_panel: null,
  file_id: null,
  fit: "cover",
  offset_x_mm: 0,
  offset_y_mm: 0,
  scale: 1.0,
  rotation: 0,
  flip_x: false,
  flip_y: false,
};

export default function KeylineWorkspace({
  jobId,
  job,
  outputs,
  liveScene,
  onRefresh,
  onSwitchTo3D,
}: KeylineWorkspaceProps) {
  // Extract resolved keyline & geometry parameters
  const keylineOutput = outputs?.resolve_keyline?.keyline?.fields || {};
  const geoOutput = outputs?.build_geometry?.geometry || {};
  const specSheet = outputs?.validate?.sheet?.spec_table || {};
  const trimArtworkOut = outputs?.trim_artwork || {};

  // Form State for Keyline & Pouch dimensions
  const [width, setWidth] = useState<number>(
    Number(keylineOutput?.pouch_closed_width_mm?.value ?? geoOutput?.width_mm ?? specSheet?.pouch_closed_width_mm?.value ?? 120)
  );
  const [height, setHeight] = useState<number>(
    Number(keylineOutput?.pouch_height_mm?.value ?? geoOutput?.height_mm ?? specSheet?.pouch_height_mm?.value ?? 180)
  );
  const [gusset, setGusset] = useState<number>(
    Number(keylineOutput?.gusset_full_width_mm?.value ?? geoOutput?.gusset_full_mm ?? specSheet?.gusset_full_width_mm?.value ?? 60)
  );
  const [gussetType, setGussetType] = useState<string>(
    specSheet?.gusset_type?.value || (geoOutput?.shape === "stand_up_bottom_gusset" ? "Bottom" : "None")
  );
  const [topSeal, setTopSeal] = useState<number>(
    Number(keylineOutput?.top_seal_mm?.value ?? geoOutput?.seals?.top ?? 10)
  );
  const [sideSeal, setSideSeal] = useState<number>(
    Number(keylineOutput?.side_seal_mm?.value ?? geoOutput?.seals?.side ?? 8)
  );
  const [bottomSeal, setBottomSeal] = useState<number>(
    Number(keylineOutput?.bottom_seal_mm?.value ?? geoOutput?.seals?.bottom ?? 10)
  );
  const [zipperEnabled, setZipperEnabled] = useState<boolean>(
    Boolean(keylineOutput?.zipper?.value ?? geoOutput?.zipper?.enabled ?? true)
  );
  const [zipperY, setZipperY] = useState<number>(
    Number(keylineOutput?.zipper_offset_from_top_mm?.value ?? geoOutput?.zipper?.y_from_top_mm ?? 25)
  );
  const [notchType, setNotchType] = useState<string>(
    keylineOutput?.tear_notch_type?.value ?? geoOutput?.tear_notch?.type ?? "v_notch"
  );
  const [notchY, setNotchY] = useState<number>(
    Number(keylineOutput?.tear_notch_offset_mm?.value ?? geoOutput?.tear_notch?.y_from_top_mm ?? 15)
  );
  const [cornerRadius, setCornerRadius] = useState<number>(
    Number(keylineOutput?.corner_radius_mm?.value ?? geoOutput?.corner_radius_mm ?? 4)
  );

  // Panel Selection & Adjustment State
  const [selectedPanel, setSelectedPanel] = useState<string>("front");
  const [swapFrontBack, setSwapFrontBack] = useState<boolean>(
    Boolean((liveScene?.adjust as any)?.swap_front_back ?? false)
  );
  const [panelConfigs, setPanelConfigs] = useState<Record<string, PanelConfig>>(() => {
    const existing: Record<string, any> = (liveScene?.adjust as any)?.panels || {};
    return {
      front: { ...DEFAULT_PANEL_CONFIG, ...(existing.front || {}) },
      back: { ...DEFAULT_PANEL_CONFIG, ...(existing.back || {}) },
      gusset: { ...DEFAULT_PANEL_CONFIG, ...(existing.gusset || {}) },
      side_left: { ...DEFAULT_PANEL_CONFIG, ...(existing.side_left || {}) },
      side_right: { ...DEFAULT_PANEL_CONFIG, ...(existing.side_right || {}) },
    };
  });

  // Sync panelConfigs when liveScene updates
  useEffect(() => {
    const panelsObj = (liveScene?.adjust as any)?.panels;
    if (panelsObj) {
      setPanelConfigs((prev) => ({
        ...prev,
        ...Object.fromEntries(
          Object.entries(panelsObj).map(([role, cfg]: [string, any]) => [
            role,
            { ...DEFAULT_PANEL_CONFIG, ...cfg },
          ])
        ),
      }));
    }
  }, [liveScene?.adjust]);

  // Auto-sync fetched keyline & dieline specifications whenever job outputs arrive
  useEffect(() => {
    if (!outputs) return;
    const kl = outputs.resolve_keyline?.keyline?.fields || {};
    const geo = outputs.build_geometry?.geometry || {};
    const spec = outputs.validate?.sheet?.spec_table || {};

    if (kl.pouch_closed_width_mm?.value || geo.width_mm || spec.pouch_closed_width_mm?.value) {
      setWidth(Number(kl.pouch_closed_width_mm?.value ?? geo.width_mm ?? spec.pouch_closed_width_mm?.value));
    }
    if (kl.pouch_height_mm?.value || geo.height_mm || spec.pouch_height_mm?.value) {
      setHeight(Number(kl.pouch_height_mm?.value ?? geo.height_mm ?? spec.pouch_height_mm?.value));
    }
    if (kl.gusset_full_width_mm?.value || geo.gusset_full_mm || spec.gusset_full_width_mm?.value) {
      setGusset(Number(kl.gusset_full_width_mm?.value ?? geo.gusset_full_mm ?? spec.gusset_full_width_mm?.value));
    }
    if (spec.gusset_type?.value || geo.shape) {
      setGussetType(spec.gusset_type?.value || (geo.shape === "stand_up_bottom_gusset" ? "Bottom" : "None"));
    }
    if (kl.top_seal_mm?.value || geo.seals?.top) {
      setTopSeal(Number(kl.top_seal_mm?.value ?? geo.seals?.top));
    }
    if (kl.side_seal_mm?.value || geo.seals?.side) {
      setSideSeal(Number(kl.side_seal_mm?.value ?? geo.seals?.side));
    }
    if (kl.bottom_seal_mm?.value || geo.seals?.bottom) {
      setBottomSeal(Number(kl.bottom_seal_mm?.value ?? geo.seals?.bottom));
    }
    if (kl.zipper?.value !== undefined || geo.zipper?.enabled !== undefined) {
      setZipperEnabled(Boolean(kl.zipper?.value ?? geo.zipper?.enabled));
    }
    if (kl.zipper_offset_from_top_mm?.value || geo.zipper?.y_from_top_mm) {
      setZipperY(Number(kl.zipper_offset_from_top_mm?.value ?? geo.zipper?.y_from_top_mm));
    }
    if (kl.tear_notch_type?.value || geo.tear_notch?.type) {
      setNotchType(kl.tear_notch_type?.value ?? geo.tear_notch?.type);
    }
    if (kl.tear_notch_offset_mm?.value || geo.tear_notch?.y_from_top_mm) {
      setNotchY(Number(kl.tear_notch_offset_mm?.value ?? geo.tear_notch?.y_from_top_mm));
    }
    if (kl.corner_radius_mm?.value || geo.corner_radius_mm) {
      setCornerRadius(Number(kl.corner_radius_mm?.value ?? geo.corner_radius_mm));
    }
  }, [outputs]);

  // Surface view & Package Color & Canvas Display controls
  const [surfaceView, setSurfaceView] = useState<"outside" | "inside">("outside");
  const [pkgColor, setPkgColor] = useState<string>("#FFFFFF");
  const [activeTool, setActiveTool] = useState<"select" | "pan" | "uploads" | "text" | "elements">("select");
  const [showArtwork, setShowArtwork] = useState<boolean>(true);
  const [artworkOpacity, setArtworkOpacity] = useState<number>(1.0);
  const [zoom, setZoom] = useState<number>(75);
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [rotation, setRotation] = useState<number>(0);

  // Status & saving & upload progress
  const [saving, setSaving] = useState<boolean>(false);
  const [uploadingRole, setUploadingRole] = useState<string>("");
  const [msg, setMsg] = useState<string>("");

  // Extracted sheet panel slices from PDF (after trim_artwork)
  const sheetSlices: Dict[] = trimArtworkOut?.panels || outputs?.extract_specs?.sheet?.panels || [];

  // Helper to get active panel config
  const activeCfg = panelConfigs[selectedPanel] || DEFAULT_PANEL_CONFIG;

  const updateActiveConfig = (patch: Partial<PanelConfig>) => {
    setPanelConfigs((prev) => ({
      ...prev,
      [selectedPanel]: { ...(prev[selectedPanel] || DEFAULT_PANEL_CONFIG), ...patch },
    }));
  };

  // Derive panel artwork texture URLs from liveScene or outputs
  // Priority: liveScene (most up-to-date, post-adjustment) > texture step outputs > trim_artwork bleed
  // IMPORTANT: spec_image_key is the SPEC TABLE image (plain/white), NOT the artwork. Never use it for artwork display.
  const getPanelTextureUrl = (role: string): string | null => {
    if (!showArtwork) return null;
    
    // 1. Check liveScene first (the live, post-adjustment scene from the 3D viewer)
    if (liveScene?.textures?.[role]) {
      const tex = liveScene.textures[role];
      if (tex.raw_url) return tex.raw_url;  // before overlays/colour correction – best for editing
      if (tex.url) return tex.url;
    }
    
    // 2. Fall back to job texture step outputs (finished panel images)
    const texData = outputs?.texture?.textures?.[role];
    if (texData) {
      // Prefer the preview SVG-based preview, then web texture, then full resolution
      if (texData.web_key) return fileUrl(jobId, texData.web_key);
      if (texData.finished_key) return fileUrl(jobId, texData.finished_key);
      if (texData.preview_key) return fileUrl(jobId, texData.preview_key);
    }

    // 3. Fall back to the raw bleed image from trim_artwork (the actual artwork, not the spec image!)
    // trim_artwork.bleed_key = the front artwork rendered from the PDF (sRGB, correct)
    // NEVER use extract_specs.spec_image_key — that is the spec TABLE image (a blank/white page)
    if (role === "front") {
      const trimOut = outputs?.trim_artwork;
      if (trimOut?.bleed_key) return fileUrl(jobId, trimOut.bleed_key);
    }

    return null;
  };

  // Determine artwork source status for UI display
  const getArtworkSource = (role: string): string => {
    if (liveScene?.textures?.[role]) return "live-scene";
    const texData = outputs?.texture?.textures?.[role];
    if (texData) return `texture (${texData.source || "pdf"})`;
    if (role === "front" && outputs?.trim_artwork?.bleed_key) return "trim artwork (raw)";
    return "none";
  };

  const frontTextureUrl = getPanelTextureUrl("front");
  const backTextureUrl = getPanelTextureUrl("back") || (swapFrontBack ? frontTextureUrl : null);
  const gussetTextureUrl = getPanelTextureUrl("gusset") || getPanelTextureUrl("side_left") || getPanelTextureUrl("bottom");

  // Calculate layout coordinates for 2D keyline canvas
  const canvasWidth = width * 2 + (gussetType === "Side" ? gusset * 2 : 20);
  const canvasHeight = height + (gussetType === "Bottom" ? gusset / 2 : 0) + 40;

  // Upload Panel Artwork File
  const handlePanelUpload = async (role: string, file: File) => {
    setUploadingRole(role);
    setMsg(`Uploading artwork for ${role.toUpperCase()} panel...`);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/jobs/${jobId}/artwork`, {
        method: "POST",
        body: formData,
        headers: { "X-Requested-With": "fetch" },
      });
      
      if (!res.ok) throw new Error("Failed to upload artwork file");
      const upData = await res.json();

      const newConfigs = {
        ...panelConfigs,
        [role]: { ...panelConfigs[role], source: "file" as const, file_id: upData.file_id, fit: "cover" as const },
      };
      setPanelConfigs(newConfigs);

      await api.post(`/api/jobs/${jobId}/adjust`, {
        adjust: { panels: newConfigs, swap_front_back: swapFrontBack },
      });

      setMsg(`✨ Artwork for ${role.toUpperCase()} panel uploaded & applied!`);
      onRefresh();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setUploadingRole("");
    }
  };

  // Apply Keyline & Panel Assignments
  const handleApplyKeyline = async () => {
    setSaving(true);
    setMsg("");
    try {
      const keylineOverrides = {
        pouch_closed_width_mm: width,
        pouch_height_mm: height,
        gusset_full_width_mm: gusset,
        top_seal_mm: topSeal,
        side_seal_mm: sideSeal,
        bottom_seal_mm: bottomSeal,
        zipper_offset_from_top_mm: zipperY,
        tear_notch_offset_mm: notchY,
        corner_radius_mm: cornerRadius,
      };

      const specCorrections = {
        "spec_table.pouch_closed_width_mm": width,
        "spec_table.pouch_height_mm": height,
        "spec_table.gusset_full_width_mm": gusset,
        "spec_table.gusset_type": gussetType,
        "spec_table.zipper": zipperEnabled,
      };

      await api.post(`/api/jobs/${jobId}/adjust`, {
        adjust: {
          panels: panelConfigs,
          swap_front_back: swapFrontBack,
          specs: specCorrections,
          keyline: keylineOverrides,
          material: { plain_color: pkgColor },
        },
      });

      setMsg("✨ Keyline & Panel Artwork assignments updated! Re-building 3D mockup...");
      onRefresh();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="kl-workspace-container" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 120px)", background: "var(--bg)", borderRadius: 12, overflow: "hidden", border: "1px solid var(--border)" }}>
      {/* Top Banner Bar */}
      <div style={{ padding: "10px 18px", background: "var(--panel)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ background: "var(--accent-soft)", color: "var(--accent)", padding: "4px 10px", borderRadius: 6, fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Step 1: Keyline & Dieline Visual Studio
          </span>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            Assign & inspect Front, Back, and Gusset artwork panels visually right after trimming
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {msg && <span style={{ fontSize: 12, color: msg.startsWith("✨") ? "var(--ok)" : "var(--bad)", fontWeight: 600 }}>{msg}</span>}
          
          <button
            onClick={() => {
              const nextSwap = !swapFrontBack;
              setSwapFrontBack(nextSwap);
              api.post(`/api/jobs/${jobId}/adjust`, { adjust: { panels: panelConfigs, swap_front_back: nextSwap } }).then(onRefresh);
            }}
            className="btn small"
            style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
          >
            🔄 {swapFrontBack ? "Unswap Front/Back" : "Swap Front & Back"}
          </button>

          <button onClick={handleApplyKeyline} disabled={saving} className="primary" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {saving ? "Updating..." : "⚡ Save Keyline & Re-build 3D"}
          </button>
          
          <button onClick={onSwitchTo3D} className="btn" style={{ fontWeight: 600, background: "var(--accent)", color: "#fff" }}>
            View 3D Mockup →
          </button>
        </div>
      </div>

      {/* Main Workspace Body */}
      <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 340px", flex: 1, minHeight: 0, overflow: "hidden" }}>
        
        {/* Left Toolbar (Pacdora-style) */}
        <div style={{ background: "var(--panel)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 0", gap: 16 }}>
          <button
            title="Select tool"
            onClick={() => setActiveTool("select")}
            style={{ width: 40, height: 40, borderRadius: 8, border: "none", background: activeTool === "select" ? "var(--accent-soft)" : "transparent", color: activeTool === "select" ? "var(--accent)" : "var(--text)", cursor: "pointer", fontSize: 18 }}
          >
            ↖
          </button>
          <button
            title="Pan tool"
            onClick={() => setActiveTool("pan")}
            style={{ width: 40, height: 40, borderRadius: 8, border: "none", background: activeTool === "pan" ? "var(--accent-soft)" : "transparent", color: activeTool === "pan" ? "var(--accent)" : "var(--text)", cursor: "pointer", fontSize: 18 }}
          >
            ✋
          </button>
          <button
            title="Uploads"
            onClick={() => setActiveTool("uploads")}
            style={{ width: 40, height: 40, borderRadius: 8, border: "none", background: activeTool === "uploads" ? "var(--accent-soft)" : "transparent", color: activeTool === "uploads" ? "var(--accent)" : "var(--text)", cursor: "pointer", fontSize: 16, display: "flex", flexDirection: "column", alignItems: "center" }}
          >
            <span>☁️</span>
            <span style={{ fontSize: 9, marginTop: 2 }}>Uploads</span>
          </button>
          <button
            title="Text Overlay"
            onClick={() => setActiveTool("text")}
            style={{ width: 40, height: 40, borderRadius: 8, border: "none", background: activeTool === "text" ? "var(--accent-soft)" : "transparent", color: activeTool === "text" ? "var(--accent)" : "var(--text)", cursor: "pointer", fontSize: 16, display: "flex", flexDirection: "column", alignItems: "center" }}
          >
            <span>T</span>
            <span style={{ fontSize: 9, marginTop: 2 }}>Text</span>
          </button>
          <button
            title="Elements & Windows"
            onClick={() => setActiveTool("elements")}
            style={{ width: 40, height: 40, borderRadius: 8, border: "none", background: activeTool === "elements" ? "var(--accent-soft)" : "transparent", color: activeTool === "elements" ? "var(--accent)" : "var(--text)", cursor: "pointer", fontSize: 16, display: "flex", flexDirection: "column", alignItems: "center" }}
          >
            <span>🔲</span>
            <span style={{ fontSize: 9, marginTop: 2 }}>Tools</span>
          </button>
        </div>

        {/* Center Canvas Area: 2D Keyline Vector Canvas with Floating 3D Preview Modal */}
        <div style={{ position: "relative", background: surfaceView === "outside" ? "#F1F5F9" : "#E2E8F0", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          
          {/* Auto-fetch status banner: shows when trim_artwork has run but texture not yet complete */}
          {outputs?.trim_artwork && !outputs?.texture && (
            <div style={{
              padding: "5px 16px", background: "linear-gradient(90deg, #ecfdf5, #f0fdf4)",
              borderBottom: "1px solid #bbf7d0", display: "flex", alignItems: "center", gap: 8,
              fontSize: 11, color: "#065f46", fontWeight: 600, flexShrink: 0,
            }}>
              <span>✅</span>
              <span>
                Front artwork auto-fetched from uploaded PDF
                {outputs.trim_artwork.trim_width_mm ? ` — detected: ${Number(outputs.trim_artwork.trim_width_mm).toFixed(1)} × ${Number(outputs.trim_artwork.trim_height_mm).toFixed(1)} mm` : ""}.
                {outputs.trim_artwork.mode === "separation" && <span style={{ color: "#92400e", marginLeft: 6 }}>⚠️ Dieline is visible — it will be auto-removed when pipeline finishes.</span>}
                {" "}Click <b>Save Keyline &amp; Re-build 3D</b> above to finish.
              </span>
            </div>
          )}

          {/* Visual Extracted Trimmed Panels Gallery (Post trim_artwork) */}
          <div style={{ position: "absolute", top: 16, left: 16, background: "rgba(255, 255, 255, 0.95)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 14px", display: "flex", alignItems: "center", gap: 14, boxShadow: "0 4px 14px rgba(0,0,0,0.08)", zIndex: 10, backdropFilter: "blur(8px)" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase" }}>
                🎯 Selected Panel: <span style={{ color: "#0F172A", textTransform: "uppercase", background: "#E2E8F0", padding: "2px 6px", borderRadius: 4 }}>{selectedPanel}</span>
              </span>
              <span style={{ fontSize: 10, color: "var(--muted)" }}>Click any panel on canvas to select & map artwork</span>
            </div>

            <div style={{ width: 1, height: 24, background: "var(--border)" }} />

            {/* Panel Artwork Thumbnail Strip with Source Status & Upload */}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              {([
                { role: "front" as const, url: frontTextureUrl, label: "Front" },
                { role: "back" as const, url: backTextureUrl, label: "Back" },
                { role: "gusset" as const, url: gussetTextureUrl, label: "Gusset" },
              ]).map(({ role, url, label }) => {
                const src = getArtworkSource(role);
                const isSelected = selectedPanel === role;
                const isUploading = uploadingRole === role;
                return (
                  <div key={role} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    <div
                      onClick={() => setSelectedPanel(role)}
                      style={{
                        width: 42, height: 50, borderRadius: 5, overflow: "hidden", cursor: "pointer",
                        border: isSelected ? "2.5px solid var(--accent)" : "1.5px solid var(--border)",
                        background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center",
                        boxShadow: isSelected ? "0 0 0 3px rgba(37,99,235,0.14)" : "none",
                        transition: "all 0.15s", position: "relative",
                      }}
                    >
                      {url ? (
                        <img src={url} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        <span style={{ fontSize: 7, color: "#94a3b8", textAlign: "center", padding: 2, lineHeight: 1.2 }}>No<br/>art</span>
                      )}
                      {src !== "none" && (
                        <div style={{ position: "absolute", bottom: 2, right: 2, background: "#10b981", borderRadius: "50%", width: 8, height: 8, border: "1.5px solid white" }} title={`Auto-detected: ${src}`} />
                      )}
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: isSelected ? "var(--accent)" : "#64748b" }}>{label}</span>
                    <label style={{ fontSize: 9, color: isUploading ? "var(--muted)" : "var(--accent)", cursor: "pointer", textDecoration: "underline" }}>
                      {isUploading ? "⏳" : url ? "↺ replace" : "+ upload"}
                      <input type="file" accept="image/*,.pdf" style={{ display: "none" }} disabled={isUploading} onChange={(e) => e.target.files?.[0] && handlePanelUpload(role, e.target.files[0])} />
                    </label>
                  </div>
                );
              })}
            </div>

            {/* Sheet Panel Slices (if PDF sheet was trimmed into panels) */}
            {sheetSlices.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, borderLeft: "1px solid var(--border)", paddingLeft: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)" }}>PDF Slices:</span>
                {sheetSlices.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      updateActiveConfig({ source: "sheet", sheet_panel: idx });
                      handleApplyKeyline();
                    }}
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      border: activeCfg.source === "sheet" && activeCfg.sheet_panel === idx ? "2px solid var(--accent)" : "1px solid var(--border)",
                      background: activeCfg.source === "sheet" && activeCfg.sheet_panel === idx ? "var(--accent-soft)" : "#fff",
                      cursor: "pointer",
                    }}
                    title={`Map Trimmed Sheet Slice #${idx} to ${selectedPanel}`}
                  >
                    Slice #{idx + 1}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Top-Right Floating 3D Thumbnail Modal */}
          <div style={{ position: "absolute", top: 16, right: 16, width: 220, height: 220, background: "var(--panel)", borderRadius: 12, border: "2px solid var(--border)", boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.15)", overflow: "hidden", zIndex: 10 }}>
            <div style={{ padding: "6px 10px", background: "rgba(15, 23, 42, 0.85)", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center", backdropFilter: "blur(4px)" }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 4 }}>
                <span>📦</span> 3D Preview
              </span>
              <button onClick={onSwitchTo3D} style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 4, padding: "2px 8px", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>
                Expand 3D ↗
              </button>
            </div>
            <div style={{ width: "100%", height: "calc(100% - 28px)", background: "#fafafa" }}>
              {liveScene ? (
                <Viewer scene={liveScene} name={job?.item_code} />
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: 11, color: "var(--muted)", padding: 12, textAlign: "center" }}>
                  Generating 3D model...
                </div>
              )}
            </div>
          </div>

          {/* Interactive SVG Keyline Canvas with Panel Selection */}
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 40 }}>
            <div style={{ transform: `scale(${zoom / 100}) rotate(${rotation}deg)`, transformOrigin: "center center", transition: "transform 0.2s ease" }}>
              <svg
                width={canvasWidth * 2.5 + 100}
                height={canvasHeight * 2.5 + 100}
                viewBox={`-50 -50 ${canvasWidth * 2.5 + 100} ${canvasHeight * 2.5 + 100}`}
                style={{ background: "#ffffff", borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.08)", border: "1px solid #cbd5e1" }}
              >
                {/* SVG Definitions */}
                <defs>
                  <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke={showGrid ? "#F1F5F9" : "transparent"} strokeWidth="1" />
                  </pattern>
                  <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#1F5BD6" />
                  </marker>
                  <pattern id="sealHatch" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                    <line x1="0" y1="0" x2="0" y2="8" stroke="#EF4444" strokeWidth="1.5" strokeOpacity="0.4" />
                  </pattern>

                  {/* Panel Clip Paths */}
                  <clipPath id="frontClip">
                    <rect x="0" y="0" width={width * 1.5} height={height * 1.5} rx={cornerRadius * 1.5} />
                  </clipPath>
                  <clipPath id="backClip">
                    <rect x="0" y="0" width={width * 1.5} height={height * 1.5} rx={cornerRadius * 1.5} />
                  </clipPath>
                  <clipPath id="gussetClip">
                    <rect x="0" y="0" width={width * 1.5} height={gusset * 0.75} />
                  </clipPath>
                </defs>

                {/* Canvas Background Grid */}
                <rect x="-50" y="-50" width={canvasWidth * 2.5 + 100} height={canvasHeight * 2.5 + 100} fill="url(#grid)" />

                {/* Keyline Drawing Container */}
                <g transform="translate(40, 40)">
                  
                  {/* FRONT PANEL */}
                  <g
                    transform="translate(0, 0)"
                    onClick={() => setSelectedPanel("front")}
                    style={{ cursor: "pointer" }}
                  >
                    {/* Background Surface */}
                    <rect
                      x="0"
                      y="0"
                      width={width * 1.5}
                      height={height * 1.5}
                      rx={cornerRadius * 1.5}
                      fill={pkgColor}
                    />

                    {/* FRONT PANEL ARTWORK IMAGE */}
                    {frontTextureUrl ? (
                      <g clipPath="url(#frontClip)">
                        <g transform={`translate(${panelConfigs.front?.offset_x_mm || 0}, ${panelConfigs.front?.offset_y_mm || 0}) scale(${panelConfigs.front?.scale || 1})`}>
                          <image
                            href={frontTextureUrl}
                            x="0"
                            y="0"
                            width={width * 1.5}
                            height={height * 1.5}
                            preserveAspectRatio="none"
                            opacity={artworkOpacity}
                          />
                        </g>
                      </g>
                    ) : (
                      <g clipPath="url(#frontClip)">
                        <rect x="0" y="0" width={width * 1.5} height={height * 1.5} fill="#F8FAFC" opacity="0.6" />
                        <text x={width * 0.75} y={height * 0.75 - 15} fill="#64748B" fontSize="13" fontWeight="600" textAnchor="middle">
                          (No Front Artwork Uploaded)
                        </text>
                      </g>
                    )}

                    {/* Panel Dieline Outer Border & Selection Indicator */}
                    <rect
                      x="0"
                      y="0"
                      width={width * 1.5}
                      height={height * 1.5}
                      rx={cornerRadius * 1.5}
                      fill="none"
                      stroke={selectedPanel === "front" ? "#2563EB" : "#1F5BD6"}
                      strokeWidth={selectedPanel === "front" ? "3.5" : "2"}
                      strokeDasharray={selectedPanel === "front" ? "8 4" : "none"}
                    />

                    {/* Top Seal */}
                    <rect x="0" y="0" width={width * 1.5} height={topSeal * 1.5} fill="url(#sealHatch)" stroke="#EF4444" strokeWidth="1" strokeDasharray="3 2" />
                    {/* Side Seals */}
                    <rect x="0" y="0" width={sideSeal * 1.5} height={height * 1.5} fill="url(#sealHatch)" stroke="#EF4444" strokeWidth="1" strokeDasharray="3 2" />
                    <rect x={width * 1.5 - sideSeal * 1.5} y="0" width={sideSeal * 1.5} height={height * 1.5} fill="url(#sealHatch)" stroke="#EF4444" strokeWidth="1" strokeDasharray="3 2" />
                    
                    {/* Zipper Line */}
                    {zipperEnabled && (
                      <>
                        <line x1={sideSeal * 1.5} y1={zipperY * 1.5} x2={width * 1.5 - sideSeal * 1.5} y2={zipperY * 1.5} stroke="#10B981" strokeWidth="2.5" strokeDasharray="5 3" />
                        <rect x={width * 0.75 - 75} y={zipperY * 1.5 - 14} width="150" height="16" fill="rgba(255,255,255,0.85)" rx="3" />
                        <text x={width * 0.75} y={zipperY * 1.5 - 3} fill="#059669" fontSize="11" fontWeight="700" textAnchor="middle">
                          Zipper Line ({zipperY} mm from top)
                        </text>
                      </>
                    )}

                    {/* Tear Notch Cutouts */}
                    {notchType !== "none" && (
                      <>
                        <path d={`M 0 ${notchY * 1.5 - 4} L 8 ${notchY * 1.5} L 0 ${notchY * 1.5 + 4} Z`} fill="#FFFFFF" stroke="#1F5BD6" strokeWidth="1.5" />
                        <path d={`M ${width * 1.5} ${notchY * 1.5 - 4} L ${width * 1.5 - 8} ${notchY * 1.5} L ${width * 1.5} ${notchY * 1.5 + 4} Z`} fill="#FFFFFF" stroke="#1F5BD6" strokeWidth="1.5" />
                      </>
                    )}

                    {/* Panel Title Badge */}
                    <rect x="10" y="10" width="110" height="22" fill={selectedPanel === "front" ? "#2563EB" : "rgba(15, 23, 42, 0.75)"} rx="4" />
                    <text x="65" y="25" fill="#FFFFFF" fontSize="11" fontWeight="700" textAnchor="middle">
                      {selectedPanel === "front" ? "✓ FRONT PANEL" : "FRONT PANEL"}
                    </text>
                  </g>

                  {/* BACK PANEL */}
                  <g
                    transform={`translate(${width * 1.5 + 15}, 0)`}
                    onClick={() => setSelectedPanel("back")}
                    style={{ cursor: "pointer" }}
                  >
                    {/* Background Surface */}
                    <rect
                      x="0"
                      y="0"
                      width={width * 1.5}
                      height={height * 1.5}
                      rx={cornerRadius * 1.5}
                      fill={pkgColor}
                    />

                    {/* BACK PANEL ARTWORK IMAGE */}
                    {backTextureUrl ? (
                      <g clipPath="url(#backClip)">
                        <g transform={`translate(${panelConfigs.back?.offset_x_mm || 0}, ${panelConfigs.back?.offset_y_mm || 0}) scale(${panelConfigs.back?.scale || 1})`}>
                          <image
                            href={backTextureUrl}
                            x="0"
                            y="0"
                            width={width * 1.5}
                            height={height * 1.5}
                            preserveAspectRatio="none"
                            opacity={artworkOpacity}
                          />
                        </g>
                      </g>
                    ) : (
                      <g clipPath="url(#backClip)">
                        <rect x="0" y="0" width={width * 1.5} height={height * 1.5} fill="#F8FAFC" opacity="0.6" />
                        <text x={width * 0.75} y={height * 0.75 - 15} fill="#64748B" fontSize="13" fontWeight="600" textAnchor="middle">
                          (No Back Artwork Uploaded)
                        </text>
                      </g>
                    )}

                    {/* Panel Dieline Outer Border & Selection Indicator */}
                    <rect
                      x="0"
                      y="0"
                      width={width * 1.5}
                      height={height * 1.5}
                      rx={cornerRadius * 1.5}
                      fill="none"
                      stroke={selectedPanel === "back" ? "#2563EB" : "#1F5BD6"}
                      strokeWidth={selectedPanel === "back" ? "3.5" : "2"}
                      strokeDasharray={selectedPanel === "back" ? "8 4" : "none"}
                    />

                    {/* Top Seal */}
                    <rect x="0" y="0" width={width * 1.5} height={topSeal * 1.5} fill="url(#sealHatch)" stroke="#EF4444" strokeWidth="1" strokeDasharray="3 2" />
                    {/* Side Seals */}
                    <rect x="0" y="0" width={sideSeal * 1.5} height={height * 1.5} fill="url(#sealHatch)" stroke="#EF4444" strokeWidth="1" strokeDasharray="3 2" />
                    <rect x={width * 1.5 - sideSeal * 1.5} y="0" width={sideSeal * 1.5} height={height * 1.5} fill="url(#sealHatch)" stroke="#EF4444" strokeWidth="1" strokeDasharray="3 2" />
                    
                    {/* Panel Title Badge */}
                    <rect x="10" y="10" width="110" height="22" fill={selectedPanel === "back" ? "#2563EB" : "rgba(15, 23, 42, 0.75)"} rx="4" />
                    <text x="65" y="25" fill="#FFFFFF" fontSize="11" fontWeight="700" textAnchor="middle">
                      {selectedPanel === "back" ? "✓ BACK PANEL" : "BACK PANEL"}
                    </text>
                  </g>

                  {/* BOTTOM GUSSET (if applicable) */}
                  {gussetType === "Bottom" && (
                    <g
                      transform={`translate(0, ${height * 1.5 + 10})`}
                      onClick={() => setSelectedPanel("gusset")}
                      style={{ cursor: "pointer" }}
                    >
                      {/* Background Surface */}
                      <rect
                        x="0"
                        y="0"
                        width={width * 1.5}
                        height={gusset * 0.75}
                        fill={pkgColor}
                      />

                      {/* GUSSET PANEL ARTWORK IMAGE */}
                      {gussetTextureUrl ? (
                        <g clipPath="url(#gussetClip)">
                          <g transform={`translate(${panelConfigs.gusset?.offset_x_mm || 0}, ${panelConfigs.gusset?.offset_y_mm || 0}) scale(${panelConfigs.gusset?.scale || 1})`}>
                            <image
                              href={gussetTextureUrl}
                              x="0"
                              y="0"
                              width={width * 1.5}
                              height={gusset * 0.75}
                              preserveAspectRatio="none"
                              opacity={artworkOpacity}
                            />
                          </g>
                        </g>
                      ) : (
                        <g clipPath="url(#gussetClip)">
                          <rect x="0" y="0" width={width * 1.5} height={gusset * 0.75} fill="#F8FAFC" opacity="0.6" />
                        </g>
                      )}

                      {/* Panel Dieline Outer Border & Selection Indicator */}
                      <rect
                        x="0"
                        y="0"
                        width={width * 1.5}
                        height={gusset * 0.75}
                        fill="none"
                        stroke={selectedPanel === "gusset" ? "#2563EB" : "#1F5BD6"}
                        strokeWidth={selectedPanel === "gusset" ? "3" : "1.5"}
                        strokeDasharray={selectedPanel === "gusset" ? "8 4" : "4 2"}
                      />
                      <line x1="0" y1={gusset * 0.375} x2={width * 1.5} y2={gusset * 0.375} stroke="#1F5BD6" strokeWidth="1.5" strokeDasharray="6 3" />
                      
                      {/* Panel Title Badge */}
                      <rect x="10" y="6" width="180" height="20" fill={selectedPanel === "gusset" ? "#2563EB" : "rgba(15, 23, 42, 0.75)"} rx="4" />
                      <text x="100" y="20" fill="#FFFFFF" fontSize="10" fontWeight="700" textAnchor="middle">
                        {selectedPanel === "gusset" ? "✓ BOTTOM GUSSET" : "BOTTOM GUSSET"} ({gusset} mm)
                      </text>
                    </g>
                  )}

                  {/* DIMENSION LINES & CALLOUTS */}
                  {/* Width Callout */}
                  <g transform={`translate(0, ${-20})`}>
                    <line x1="0" y1="0" x2={width * 1.5} y2="0" stroke="#1F5BD6" strokeWidth="1.5" markerStart="url(#arrow)" markerEnd="url(#arrow)" />
                    <rect x={width * 0.75 - 35} y="-12" width="70" height="20" fill="#1F5BD6" rx="4" />
                    <text x={width * 0.75} y="2" fill="#FFFFFF" fontSize="12" fontWeight="700" textAnchor="middle">
                      {width} mm
                    </text>
                  </g>

                  {/* Height Callout */}
                  <g transform={`translate(${-25}, 0)`}>
                    <line x1="0" y1="0" x2="0" y2={height * 1.5} stroke="#1F5BD6" strokeWidth="1.5" markerStart="url(#arrow)" markerEnd="url(#arrow)" />
                    <rect x="-45" y={height * 0.75 - 10} width="60" height="20" fill="#1F5BD6" rx="4" />
                    <text x="-15" y={height * 0.75 + 4} fill="#FFFFFF" fontSize="12" fontWeight="700" textAnchor="middle">
                      {height} mm
                    </text>
                  </g>
                </g>
              </svg>
            </div>
          </div>

          {/* Bottom Zoom & View & Artwork Controls Bar */}
          <div style={{ padding: "8px 16px", background: "var(--panel)", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontWeight: 600, color: "var(--text)" }}>
                <input type="checkbox" checked={showArtwork} onChange={(e) => setShowArtwork(e.target.checked)} />
                Show Panel Artworks
              </label>

              {showArtwork && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>Art Opacity:</span>
                  <input
                    type="range"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={artworkOpacity}
                    onChange={(e) => setArtworkOpacity(Number(e.target.value))}
                    style={{ width: 80 }}
                  />
                  <span style={{ fontSize: 11, fontWeight: 700, width: 30 }}>{Math.round(artworkOpacity * 100)}%</span>
                </div>
              )}

              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "var(--muted)" }}>
                <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Show Grid
              </label>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => setRotation((r) => (r + 90) % 360)} className="btn small" title="Rotate 90°">
                🔄 Rotate
              </button>
              <button onClick={() => setZoom((z) => Math.max(30, z - 10))} className="btn small">
                -
              </button>
              <span style={{ fontSize: 12, fontWeight: 700, width: 45, textAlign: "center" }}>{zoom}%</span>
              <button onClick={() => setZoom((z) => Math.min(200, z + 10))} className="btn small">
                +
              </button>
              <button onClick={() => { setZoom(75); setRotation(0); }} className="btn small">
                Reset View
              </button>
            </div>
          </div>

        </div>

        {/* Right Sidebar: Keyline Specs & Selected Panel Visual Inspector Panel */}
        <div style={{ background: "var(--panel)", borderLeft: "1px solid var(--border)", padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 18 }}>
          
          {/* Selected Panel Inspector Header */}
          <div style={{ background: "var(--panel-2)", padding: 12, borderRadius: 8, border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>
                Active Selection
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, background: "var(--accent)", color: "#fff", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase" }}>
                {selectedPanel}
              </span>
            </div>

            {/* Panel Selector Tab Buttons */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginTop: 8 }}>
              <button
                onClick={() => setSelectedPanel("front")}
                style={{ fontSize: 11, fontWeight: 700, padding: "5px", borderRadius: 4, border: "none", background: selectedPanel === "front" ? "var(--accent)" : "var(--panel)", color: selectedPanel === "front" ? "#fff" : "var(--text)", cursor: "pointer" }}
              >
                Front
              </button>
              <button
                onClick={() => setSelectedPanel("back")}
                style={{ fontSize: 11, fontWeight: 700, padding: "5px", borderRadius: 4, border: "none", background: selectedPanel === "back" ? "var(--accent)" : "var(--panel)", color: selectedPanel === "back" ? "#fff" : "var(--text)", cursor: "pointer" }}
              >
                Back
              </button>
              <button
                onClick={() => setSelectedPanel("gusset")}
                style={{ fontSize: 11, fontWeight: 700, padding: "5px", borderRadius: 4, border: "none", background: selectedPanel === "gusset" ? "var(--accent)" : "var(--panel)", color: selectedPanel === "gusset" ? "#fff" : "var(--text)", cursor: "pointer" }}
              >
                Gusset
              </button>
            </div>
          </div>

          {/* Visual Panel Alignment & Offset Inspector */}
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 700, margin: "0 0 8px 0", color: "var(--text)" }}>
              🖼️ Panel Artwork Alignment ({selectedPanel.toUpperCase()})
            </h4>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Source Mapping */}
              <label className="field" style={{ fontSize: 11 }}>
                <span>Artwork Source</span>
                <select
                  value={activeCfg.source}
                  onChange={(e) => updateActiveConfig({ source: e.target.value as any })}
                >
                  <option value="auto">Automatic (Extracted PDF)</option>
                  <option value="front">Same Artwork as Front Panel</option>
                  <option value="plain">Plain Film Color</option>
                  {sheetSlices.map((_, i) => (
                    <option key={i} value="sheet">Trimmed Sheet Slice #{i + 1}</option>
                  ))}
                </select>
              </label>

              {/* Offset X & Y Nudge Controls */}
              <div style={{ borderTop: "1px dashed var(--border)", paddingTop: 8 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 4, display: "block" }}>
                  Position Offset (mm)
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <label style={{ fontSize: 11 }}>
                    X Offset
                    <input
                      type="number"
                      value={activeCfg.offset_x_mm}
                      onChange={(e) => updateActiveConfig({ offset_x_mm: Number(e.target.value) })}
                    />
                  </label>
                  <label style={{ fontSize: 11 }}>
                    Y Offset
                    <input
                      type="number"
                      value={activeCfg.offset_y_mm}
                      onChange={(e) => updateActiveConfig({ offset_y_mm: Number(e.target.value) })}
                    />
                  </label>
                </div>
              </div>

              {/* Scale & Orientation */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <label style={{ fontSize: 11 }}>
                  Artwork Scale
                  <input
                    type="range"
                    min="0.5"
                    max="2.5"
                    step="0.05"
                    value={activeCfg.scale}
                    onChange={(e) => updateActiveConfig({ scale: Number(e.target.value) })}
                  />
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>{activeCfg.scale.toFixed(2)}x</span>
                </label>

                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>Flip & Turn</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      onClick={() => updateActiveConfig({ flip_x: !activeCfg.flip_x })}
                      style={{ fontSize: 10, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border)", background: activeCfg.flip_x ? "var(--accent-soft)" : "var(--panel)" }}
                    >
                      Flip ↔
                    </button>
                    <button
                      onClick={() => updateActiveConfig({ flip_y: !activeCfg.flip_y })}
                      style={{ fontSize: 10, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border)", background: activeCfg.flip_y ? "var(--accent-soft)" : "var(--panel)" }}
                    >
                      Flip ↕
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Surface View Toggle (Outside / Inside) */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6, display: "block" }}>
              Surface View
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, background: "var(--panel-2)", padding: 3, borderRadius: 8 }}>
              <button
                onClick={() => setSurfaceView("outside")}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "none",
                  background: surfaceView === "outside" ? "var(--panel)" : "transparent",
                  color: surfaceView === "outside" ? "var(--accent)" : "var(--muted)",
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: "pointer",
                  boxShadow: surfaceView === "outside" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                Outside
              </button>
              <button
                onClick={() => setSurfaceView("inside")}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "none",
                  background: surfaceView === "inside" ? "var(--panel)" : "transparent",
                  color: surfaceView === "inside" ? "var(--accent)" : "var(--muted)",
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: "pointer",
                  boxShadow: surfaceView === "inside" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                Inside
              </button>
            </div>
          </div>

          {/* Package Base Color Swatches */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8, display: "block" }}>
              Package Color
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <input
                type="color"
                value={pkgColor}
                onChange={(e) => setPkgColor(e.target.value)}
                style={{ width: 28, height: 28, borderRadius: 6, border: "1px solid var(--border)", cursor: "pointer", padding: 0 }}
                title="Custom color picker"
              />
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch.name}
                  onClick={() => setPkgColor(swatch.hex)}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    background: swatch.hex,
                    border: pkgColor === swatch.hex ? "2px solid var(--accent)" : "1px solid #cbd5e1",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  }}
                  title={swatch.name}
                />
              ))}
            </div>
          </div>

          {/* Keyline & Dieline Specifications Form */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 12px 0", color: "var(--text)" }}>
              📐 Keyline Dimensions (mm)
            </h3>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label className="field" style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span>Width (Closed)</span>
                  <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
                </label>
                <label className="field" style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span>Height</span>
                  <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} />
                </label>
              </div>

              {/* Gusset Parameters */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label className="field" style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span>Gusset Type</span>
                  <select value={gussetType} onChange={(e) => setGussetType(e.target.value)}>
                    <option value="Bottom">Bottom Gusset</option>
                    <option value="Side">Side Gusset</option>
                    <option value="None">None (Flat)</option>
                  </select>
                </label>
                <label className="field" style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span>Gusset Depth</span>
                  <input type="number" value={gusset} onChange={(e) => setGusset(Number(e.target.value))} />
                </label>
              </div>

              {/* Seals */}
              <div style={{ borderTop: "1px dashed var(--border)", paddingTop: 10 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", marginBottom: 6, display: "block" }}>
                  Seal Margins (mm)
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                  <label style={{ fontSize: 11 }}>
                    Top
                    <input type="number" value={topSeal} onChange={(e) => setTopSeal(Number(e.target.value))} />
                  </label>
                  <label style={{ fontSize: 11 }}>
                    Side
                    <input type="number" value={sideSeal} onChange={(e) => setSideSeal(Number(e.target.value))} />
                  </label>
                  <label style={{ fontSize: 11 }}>
                    Bottom
                    <input type="number" value={bottomSeal} onChange={(e) => setBottomSeal(Number(e.target.value))} />
                  </label>
                </div>
              </div>

              {/* Zipper & Notch */}
              <div style={{ borderTop: "1px dashed var(--border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontWeight: 600 }}>
                  <input type="checkbox" checked={zipperEnabled} onChange={(e) => setZipperEnabled(e.target.checked)} />
                  Include Zipper
                </label>
                {zipperEnabled && (
                  <label className="field" style={{ fontSize: 11 }}>
                    Zipper Distance from Top (mm)
                    <input type="number" value={zipperY} onChange={(e) => setZipperY(Number(e.target.value))} />
                  </label>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <label className="field" style={{ fontSize: 11 }}>
                    Tear Notch
                    <select value={notchType} onChange={(e) => setNotchType(e.target.value)}>
                      <option value="v_notch">V Notch</option>
                      <option value="straight_notch">Straight Notch</option>
                      <option value="none">None</option>
                    </select>
                  </label>
                  <label className="field" style={{ fontSize: 11 }}>
                    Notch Y (mm)
                    <input type="number" value={notchY} onChange={(e) => setNotchY(Number(e.target.value))} />
                  </label>
                </div>

                <label className="field" style={{ fontSize: 11 }}>
                  Corner Radius (mm)
                  <input type="number" value={cornerRadius} onChange={(e) => setCornerRadius(Number(e.target.value))} />
                </label>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div style={{ marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              onClick={handleApplyKeyline}
              disabled={saving}
              className="primary"
              style={{ width: "100%", padding: "10px", fontWeight: 700 }}
            >
              {saving ? "Saving..." : "Apply & Update Keyline"}
            </button>
            <button
              onClick={onSwitchTo3D}
              className="btn"
              style={{ width: "100%", padding: "8px", fontWeight: 600, background: "var(--panel-2)" }}
            >
              Go to 3D Viewer →
            </button>
          </div>

        </div>

      </div>
    </div>
  );
}
