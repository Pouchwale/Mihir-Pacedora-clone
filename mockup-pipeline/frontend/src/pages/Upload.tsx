import { DragEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type WorkflowOut } from "../api";

interface UploadResult { batch_id: number; files: { id: number; filename: string; item_code: string | null }[]; jobs: number[]; resumed: number[] }

export default function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowOut[]>([]);
  const [workflow, setWorkflow] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useEffect(() => { api.get<WorkflowOut[]>("/api/workflows").then((w) => setWorkflows(w.filter((x) => x.published && !x.archived))).catch(() => undefined); }, []);

  const add = (list: FileList | null) => {
    if (!list) return;
    const ok = Array.from(list).filter((f) => /\.(pdf|zip)$/i.test(f.name));
    setFiles((cur) => [...cur, ...ok.filter((f) => !cur.some((c) => c.name === f.name && c.size === f.size))]);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(e.dataTransfer.files);
  };

  const upload = async () => {
    setBusy(true);
    setError("");
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    if (workflow) form.append("workflow", workflow);
    try {
      const res = await fetch("/api/uploads", { method: "POST", body: form, headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
      setResult(body);
      setFiles([]);
      if (body.jobs.length === 1) navigate(`/jobs/${body.jobs[0]}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Upload</h1>
          <div className="muted">ArtPro+ approval PDFs, several at once or as a ZIP. Each front PDF becomes a job; back, gusset and side PDFs are linked to it by the codes in its Remarks.</div>
        </div>
      </div>
      <div className={`dropzone ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
        onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && input.current?.click()}>
        <input ref={input} type="file" multiple accept=".pdf,.zip" hidden onChange={(e) => add(e.target.files)} />
        <div style={{ fontSize: 16, fontWeight: 600 }}>Drop PDFs or a ZIP here</div>
        <div className="muted">or click to choose files</div>
      </div>
      {files.length > 0 && (
        <div className="card stack" style={{ marginTop: 14 }}>
          <table>
            <thead><tr><th>File</th><th>Size</th><th /></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.name + f.size}>
                  <td>{f.name} {/front/i.test(f.name) && <span className="badge accent">front → job</span>}</td>
                  <td className="muted">{(f.size / 1024 / 1024).toFixed(1)} MB</td>
                  <td><button className="link" onClick={() => setFiles(files.filter((x) => x !== f))}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button className="primary" onClick={upload} disabled={busy}>{busy ? "Uploading…" : `Upload ${files.length} file(s)`}</button>
            {workflows.length > 1 && (
              <label className="row small muted">Workflow
                <select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
                  {workflows.map((w) => <option key={w.key} value={w.key === "default" ? "" : w.key}>{w.name} (v{w.published!.version})</option>)}
                </select>
              </label>
            )}
          </div>
        </div>
      )}
      {error && <div className="msg bad" style={{ marginTop: 14 }}>{error}</div>}
      {result && (
        <div className="msg ok" style={{ marginTop: 14 }}>
          {result.files.length} file(s) registered.{" "}
          {result.jobs.length > 0 && <>Jobs: {result.jobs.map((j) => <Link key={j} to={`/jobs/${j}`} style={{ marginRight: 8 }}>#{j}</Link>)}</>}
          {result.resumed.length > 0 && <> Resumed waiting jobs: {result.resumed.map((j) => <Link key={j} to={`/jobs/${j}`} style={{ marginRight: 8 }}>#{j}</Link>)}</>}
        </div>
      )}
    </>
  );
}
