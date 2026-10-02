import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, Entry } from "../api";
import { useSession } from "../App";
import CatalogEditor from "../components/CatalogEditor";
import FieldEditor from "../components/FieldEditor";
import History from "../components/History";
import KeylineEditor from "../components/KeylineEditor";
import MaterialEditor from "../components/MaterialEditor";
import PouchTypeEditor from "../components/PouchTypeEditor";
import PresetEditor from "../components/PresetEditor";
import ProfileEditor from "../components/ProfileEditor";
import SizeEditor from "../components/SizeEditor";
import { clone, formatTime, STARTERS } from "../util";

type Tab = "form" | "yaml" | "history";
type Data = Record<string, unknown>;
const FORMS: Record<string, (p: { data: Data; onChange: (d: Data) => void }) => JSX.Element> = {
  pouch_type: PouchTypeEditor as never,
  keyline_template: KeylineEditor as never,
  output_preset: PresetEditor as never,
  field: FieldEditor as never,
  pouch_catalog: CatalogEditor as never,
  material: MaterialEditor as never,
  standard_size: SizeEditor as never,
  pdf_profile: ProfileEditor as never,
};

export default function EntryPage() {
  const { kind = "", key = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin, kinds, refreshKinds } = useSession();
  const state = (location.state ?? {}) as { isNew?: boolean; copyFrom?: string | null };
  const info = kinds.find((k) => k.kind === kind);
  const hasForm = kind in FORMS;

  const [entry, setEntry] = useState<Entry | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [data, setData] = useState<Data>({});
  const [yamlText, setYamlText] = useState("");
  const [tab, setTab] = useState<Tab>(hasForm ? "form" : "yaml");
  const [dirty, setDirty] = useState(false);
  const [reason, setReason] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    setProblems([]);
    setLoadError("");
    try {
      const e = await api.get<Entry>(`/api/index/${kind}/${key}`);
      setEntry(e);
      setIsNew(false);
      setData(clone(e.data));
      setYamlText(e.yaml);
      setLoaded(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && (state.isNew || info?.singleton)) {
        let start: Data = clone(STARTERS[kind] ?? {});
        if (state.copyFrom) start = clone((await api.get<Entry>(`/api/index/${kind}/${state.copyFrom}`)).data);
        setEntry(null);
        setIsNew(true);
        setData(start);
        setYamlText(toYamlish(start));
        setDirty(true);
        setLoaded(true);
      } else {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  useEffect(() => {
    setTab(kind in FORMS ? "form" : "yaml");
    setLoaded(false);
    setDirty(false);
    setNotice("");
    setReason("");
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, key]);

  const change = (d: Data) => {
    setData(d);
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    setProblems([]);
    setNotice("");
    try {
      const body = tab === "yaml" ? { yaml: yamlText, reason } : { data, reason };
      const e = await api.put<Entry>(`/api/index/${kind}/${key}`, body);
      const same = entry && e.version === entry.version;
      setEntry(e);
      setIsNew(false);
      setData(clone(e.data));
      setYamlText(e.yaml);
      setDirty(false);
      setReason("");
      setNotice(same ? "No changes: nothing was saved." : `Saved as version ${e.version}.`);
      refreshKinds();
    } catch (err) {
      setProblems(err instanceof ApiError && err.problems.length ? err.problems : [String((err as Error).message)]);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!reason.trim()) {
      setProblems(["Write a reason before archiving."]);
      return;
    }
    if (!window.confirm(`Archive ${kind} ${key}? Jobs that already used it keep their version.`)) return;
    try {
      await api.del(`/api/index/${kind}/${key}`, { reason });
      refreshKinds();
      navigate(`/index/${kind}`);
    } catch (err) {
      setProblems(err instanceof ApiError && err.problems.length ? err.problems : [String((err as Error).message)]);
    }
  };

  const duplicate = () => {
    const newKey = window.prompt("Key of the copy (lowercase, _ or -)", `${key}_copy`);
    if (newKey) navigate(`/index/${kind}/${newKey.trim().toLowerCase()}`, { state: { isNew: true, copyFrom: key } });
  };

  const title = useMemo(() => String(data.name ?? data.client_name ?? key), [data, key]);
  const Form = FORMS[kind];

  if (kind === "workflow") return <Navigate to={`/workflows/${key}`} replace />;
  if (loadError) return <div className="msg bad">{loadError}</div>;
  if (!loaded) return <div className="muted">Loading…</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="muted small">{info?.label} / <code>{key}</code></div>
          <h1>{title} {isNew && <span className="badge accent">new</span>} {entry?.archived && <span className="badge warn">archived</span>}</h1>
          {entry && <div className="muted small">Version {entry.version} · {entry.meta.action} by {entry.meta.author} · {formatTime(entry.meta.created_at)} · “{entry.meta.reason}”</div>}
        </div>
        {isAdmin && !isNew && (
          <div className="row">
            {!info?.singleton && <button onClick={duplicate}>Duplicate</button>}
            {!info?.singleton && !entry?.archived && <button className="danger" onClick={archive}>Archive</button>}
          </div>
        )}
      </div>

      <div className="tabs">
        {hasForm && <button className={tab === "form" ? "on" : ""} onClick={() => setTab("form")}>Edit</button>}
        <button className={tab === "yaml" ? "on" : ""} onClick={() => setTab("yaml")}>YAML</button>
        {!isNew && <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>History</button>}
      </div>

      {tab === "form" && Form && (
        <fieldset disabled={!isAdmin} style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}>
          <Form data={data} onChange={change} />
        </fieldset>
      )}
      {tab === "yaml" && (
        <div className="card stack">
          {dirty && hasForm && !isNew && <div className="msg warn">The form has unsaved changes. This YAML shows the saved version; saving here discards the form changes.</div>}
          <textarea className="code" spellCheck={false} value={yamlText} readOnly={!isAdmin}
            onChange={(e) => { setYamlText(e.target.value); setDirty(true); }} />
          <div className="muted small">Validated on save against the schema; every problem is listed.</div>
        </div>
      )}
      {tab === "history" && entry && <History kind={kind} entryKey={key} current={entry.current_version} onRestored={load} />}

      {isAdmin && tab !== "history" && (
        <>
          {problems.length > 0 && (
            <div className="msg bad" style={{ marginTop: 14 }}>
              Not saved:
              <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          {notice && <div className="msg ok" style={{ marginTop: 14 }}>{notice}</div>}
          <div className="savebar">
            <input placeholder="Reason for this change (required, kept in the history)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="primary" onClick={save} disabled={busy || !reason.trim() || (!dirty && !isNew)}>
              {busy ? "Saving…" : isNew ? "Create" : "Save new version"}
            </button>
          </div>
        </>
      )}
    </>
  );
}

// New entries start as JSON in the YAML tab (JSON is valid YAML); the server re-renders YAML after saving.
function toYamlish(d: Data) {
  return JSON.stringify(d, null, 2);
}
