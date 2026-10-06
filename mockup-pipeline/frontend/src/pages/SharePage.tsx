/**
 * SharePage — public 3D mockup viewer, accessible without login.
 * URL: /share/:jobId?token=<signed-token>
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Viewer from "../components/Viewer";
import { draftFrom } from "../three/draft";
import type { SceneData } from "../three/types";

type Dict = Record<string, any>;

const getToken = () => new URLSearchParams(window.location.search).get("token") ?? "";

export default function SharePage() {
  const { jobId } = useParams();
  const [scene, setScene] = useState<SceneData | null>(null);
  const [job, setJob] = useState<Dict | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    const tk = getToken();
    const suffix = tk ? `?token=${encodeURIComponent(tk)}` : "";
    fetch(`/api/jobs/${jobId}/scene${suffix}`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) {
          const text = await r.text();
          throw new Error(r.status === 401 ? "This share link has expired or is invalid." : `Error ${r.status}: ${text}`);
        }
        return r.json() as Promise<SceneData>;
      })
      .then(setScene)
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
    fetch(`/api/jobs/${jobId}${suffix}`, { credentials: "include", headers: { "X-Requested-With": "fetch" } })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d && setJob(d.job))
      .catch(() => undefined);
  }, [jobId]);

  const draft = scene ? draftFrom(scene.adjust as any) : null;

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)",
      display: "flex", flexDirection: "column",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <header style={{
        padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(15,23,42,0.7)",
        backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#3b82f6,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: "#fff" }}>
            3D
          </div>
          <div>
            <div style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>{job?.item_code || "3D Pouch Mockup"}</div>
            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>{job?.client_name ? `${job.client_name} · ` : ""}Interactive Preview</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 20, padding: "4px 12px", color: "#10b981", fontSize: 11, fontWeight: 700 }}>
            ● Live 3D
          </div>
          <button onClick={copyLink} style={{ background: copied ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.08)", border: `1px solid ${copied ? "rgba(16,185,129,0.4)" : "rgba(255,255,255,0.15)"}`, borderRadius: 8, padding: "6px 14px", color: copied ? "#10b981" : "rgba(255,255,255,0.85)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}>
            {copied ? "✓ Copied" : "Copy link"}
          </button>
        </div>
      </header>

      <main style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "32px 24px" }}>
        {loading && (
          <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, marginTop: 80, textAlign: "center" }}>
                        Loading 3D mockup…
          </div>
        )}
        {error && (
          <div style={{ marginTop: 80, maxWidth: 480, textAlign: "center", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 16, padding: "32px 24px" }}>
                        <div style={{ color: "#fca5a5", fontWeight: 600, fontSize: 16, marginBottom: 8 }}>Unable to load mockup</div>
            <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, lineHeight: 1.6 }}>{error}</div>
            <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, marginTop: 16 }}>Share links expire after 7 days. Ask the sender for a new link.</div>
          </div>
        )}
        {!loading && !error && scene && (
          <div style={{ width: "100%", maxWidth: 1100, display: "flex", flexDirection: "column", gap: 24 }}>
            <Viewer scene={scene} draft={draft} name={job?.item_code} customer />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
              {job?.pouch_type && <InfoCard label="Pouch type" value={job.pouch_type.replace(/_/g, " ")} />}
              {job?.item_code && <InfoCard label="Item code" value={job.item_code} />}
              {job?.client_name && <InfoCard label="Client" value={job.client_name} />}
              {job?.approved_by && <InfoCard label="Approved" value={job.approved_by} />}
            </div>
          </div>
        )}
      </main>

      <footer style={{ padding: "12px 24px", borderTop: "1px solid rgba(255,255,255,0.06)", textAlign: "center", color: "rgba(255,255,255,0.2)", fontSize: 11 }}>
        Powered by Pouch Mockup Pipeline · Share links expire in 7 days
      </footer>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      <div style={{ color: "rgba(255,255,255,0.85)", fontSize: 14, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
