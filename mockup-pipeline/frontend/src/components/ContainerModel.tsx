// A sleeve container's own 3D model (GLB): uploaded here, saved as a new version of the container at once.
// Jobs whose "Goes on" picks this container then show the model, the sleeve shrunk onto its outline.
import { useState } from "react";
import { api, ApiError } from "../api";

export default function ContainerModel({ kind, entryKey, data, editable, dirty = false, onSaved }: {
  kind: string; entryKey: string; data: Record<string, unknown>; editable: boolean; dirty?: boolean; onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const model = typeof data.model === "string" ? data.model : null;
  const save = async (next: string | null, reason: string) => {
    // (saved at once and the page reloaded: unsaved edits on the page would be lost without a word)
    if (dirty && !window.confirm("This page has unsaved changes; saving the 3D model now discards them. Continue?")) throw new Error("Not saved: the page's own changes are kept.");
    const rest = { ...data };
    delete rest.model;
    await api.put(`/api/index/${kind}/${entryKey}`, { data: next ? { ...rest, model: next } : rest, reason });
    onSaved();
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      if (!file.name.toLowerCase().endsWith(".glb")) throw new Error("Choose a .glb file (binary glTF with its textures embedded).");
      const up = await api.upload<{ key: string; size: number }>("/api/index/container/model", { file });
      await save(up.key, `3D model uploaded: ${file.name}`);
      setMsg({ ok: true, text: `${file.name} (${(up.size / 1048576).toFixed(1)} MB) saved. Jobs on this container show it after "Apply and re-render" (or a rerun).` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError || e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack" style={{ marginBottom: 14 }}>
      <h3 style={{ margin: 0 }}>3D model (GLB)</h3>
      <div className="muted small">
        {model ? <>This container uses its own 3D model <code>{model.slice(11, 23)}…</code>. </> : "Drawn from its shape. "}
        Upload a .glb of the real container (standing upright, any size): it is scaled to the print's girth and the sleeve is shrunk onto its outline.
        Round containers work best; a square or oval body leaves the round sleeve standing off its flat sides.
      </div>
      {editable && (
        <div className="row">
          <label className={`btn ${busy ? "disabled" : ""}`}>
            {busy ? "Uploading…" : model ? "Replace model…" : "Upload .glb…"}
            <input type="file" accept=".glb,model/gltf-binary" hidden disabled={busy} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {model && <button disabled={busy} onClick={() => save(null, "3D model removed: back to the drawn shape").then(() => setMsg({ ok: true, text: "Model removed." })).catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }))}>Remove model</button>}
        </div>
      )}
      {msg && <div className={`msg ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}
    </div>
  );
}

/** The one-step way: a key name and a .glb, and the container exists (it shows in every sleeve job's
 *  "Goes on" list at once). Its other settings start at the usual defaults and can be edited later. */
export function GlbContainerAdd({ onAdded }: { onAdded: (key: string) => void }) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pickKey, setPickKey] = useState(0); // a new file box after each add (a file input cannot be cleared)
  const key = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 120);
  const add = async () => {
    if (!key || !file) return;
    if (!file.name.toLowerCase().endsWith(".glb")) { setMsg({ ok: false, text: "Choose a .glb file (binary glTF with its textures embedded)." }); return; }
    setBusy(true);
    setMsg(null);
    try {
      // (asked by key, not the list: an archived container is not listed, and saving over it unasked replaced
      // its sizes with the defaults)
      const found = await api.get<{ data: Record<string, unknown>; archived: boolean }>(`/api/index/container/${key}`).catch((e) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      });
      if (found && !window.confirm(`A container "${key}" exists${found.archived ? " (archived: it is restored)" : ""}. Give it this 3D model?`)) return;
      const current = found?.data ?? null;
      const up = await api.upload<{ key: string }>("/api/index/container/model", { file });
      const data = current ? { ...current, model: up.key } : { name: name.trim(), shape: "bottle", material: "plastic", priority: 50, model: up.key };
      await api.put(`/api/index/container/${key}`, { data, reason: `3D model ${file.name}${current ? "" : ": container added"}` });
      setMsg({ ok: true, text: `"${key}" is ready: pick it under "Goes on" on any shrink sleeve job.` });
      setName("");
      setFile(null);
      setPickKey((n) => n + 1);
      onAdded(key);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError || e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack" style={{ marginBottom: 14 }}>
      <h3 style={{ margin: 0 }}>Add a container from a 3D model</h3>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="field" style={{ flex: "1 1 220px" }}>Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gulab oil 1L bottle" />
          {key && <span className="muted small">key: <code>{key}</code></span>}
        </label>
        <label className="field" style={{ flex: "1 1 220px" }}>3D model (.glb)
          <input key={pickKey} type="file" accept=".glb,model/gltf-binary" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button className="primary" onClick={add} disabled={busy || !key || !file}>{busy ? "Adding…" : "Add"}</button>
      </div>
      <div className="muted small">The model stands upright, any size: it is scaled to each sleeve's print and the sleeve is shrunk onto its outline. Round containers fit best.</div>
      {msg && <div className={`msg ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}
    </div>
  );
}
