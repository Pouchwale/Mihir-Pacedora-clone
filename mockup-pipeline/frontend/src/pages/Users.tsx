import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, Role, ROLE_LABELS, User } from "../api";
import { useSession } from "../App";
import { formatTime } from "../util";

const ROLES = Object.keys(ROLE_LABELS) as Role[];
const ROLE_HELP: Record<Role, string> = {
  admin: "Everything, including this page: accounts, roles, passwords.",
  head_designer: "Jobs, the whole index, keyline / dieline values and workflows.",
  designer: "Jobs and the index, but cannot change keyline / dieline values or workflows.",
  manager: "Jobs, approves finished mockups, sees the activity log; reads the index without changing it.",
};
const EMPTY = { email: "", name: "", role: "designer" as Role, password: "" };

export default function Users() {
  const { user: me } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<{ id: number; email: string; name: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => api.get<User[]>("/api/users").then(setUsers).catch((e) => setError(String(e)));
  useEffect(() => { load(); }, []);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(ok);
      load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      return false;
    }
  };
  const patch = (u: User, body: Record<string, unknown>, ok: string) => act(() => api.patch(`/api/users/${u.id}`, body), ok);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await act(() => api.post("/api/users", form), `Created ${form.email}.`)) setForm(EMPTY);
  };
  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    const u = users.find((x) => x.id === editing!.id)!;
    if (await patch(u, { email: editing!.email, name: editing!.name }, `Saved ${editing!.email}.`)) setEditing(null);
  };
  const resetPassword = (u: User) => {
    const password = window.prompt(`New password for ${u.email} (at least 10 characters). They are signed out everywhere.`);
    if (password) patch(u, { password }, `Password changed for ${u.email}; their open sessions were ended.`);
  };
  const toggleActive = (u: User) => {
    if (u.active && !window.confirm(`Deactivate ${u.email}? They are signed out at once and cannot sign in until activated again.`)) return;
    patch(u, { active: !u.active }, `${u.email} ${u.active ? "deactivated and signed out" : "activated"}.`);
  };
  const changeRole = (u: User, role: Role) => {
    if (u.id === me.id && role !== "admin" && !window.confirm("Remove your own admin role? You will lose this page.")) return;
    patch(u, { role }, `${u.email} is now ${ROLE_LABELS[role]}.`);
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Users</h1><div className="muted">Accounts, roles and passwords. Every change here is written to the activity log.</div></div>
      </div>
      {error && <div className="msg bad" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="msg ok" style={{ marginBottom: 12 }}>{notice}</div>}
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={u.active ? undefined : { opacity: 0.6 }}>
                <td>
                  {editing?.id === u.id ? (
                    <form className="row" onSubmit={saveEdit}>
                      <input value={editing.name} placeholder="Name" onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Name" />
                      <input type="email" required value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} aria-label="Sign-in email" />
                      <button className="primary">Save</button>
                      <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      <div><b>{u.name || "—"}</b> {u.id === me.id && <span className="badge">you</span>}</div>
                      <div className="muted small">{u.email}</div>
                    </>
                  )}
                </td>
                <td>
                  <select value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)} title={ROLE_HELP[u.role]} aria-label={`Role of ${u.email}`}>
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </td>
                <td>
                  {u.active ? <span className="badge ok">active</span> : <span className="badge warn">deactivated</span>}{" "}
                  {u.locked && <span className="badge bad" title="Too many wrong passwords">locked</span>}
                </td>
                <td className="small muted">{u.last_login_at ? formatTime(u.last_login_at) : "never"}</td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <button onClick={() => setEditing({ id: u.id, email: u.email, name: u.name })}>Edit</button>
                    <button onClick={() => resetPassword(u)}>Set password</button>
                    {u.locked && <button onClick={() => patch(u, { unlock: true }, `${u.email} unlocked.`)}>Unlock</button>}
                    {u.id !== me.id && <button onClick={() => act(() => api.post(`/api/users/${u.id}/sign-out`), `${u.email} signed out everywhere.`)} title="End all their open sessions">Sign out</button>}
                    {u.id !== me.id && <button className={u.active ? "danger" : ""} onClick={() => toggleActive(u)}>{u.active ? "Deactivate" : "Activate"}</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid2" style={{ marginTop: 14, alignItems: "start" }}>
        <form className="card grid2" onSubmit={create}>
          <h2 style={{ gridColumn: "1 / -1", margin: 0 }}>Add user</h2>
          <label className="field">Email (sign-in id)<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field">Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></label>
          <label className="field">Password (10+ characters)<input type="password" minLength={10} required autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <div><button className="primary">Add user</button></div>
        </form>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>What each role can do</h2>
          {ROLES.map((r) => <p key={r} style={{ margin: "0 0 8px" }}><b>{ROLE_LABELS[r]}</b> <span className="muted">— {ROLE_HELP[r]}</span></p>)}
          <p className="muted small" style={{ marginBottom: 0 }}>Everyone can upload PDFs, run and adjust jobs, share and download mockups.</p>
        </div>
      </div>
    </>
  );
}
