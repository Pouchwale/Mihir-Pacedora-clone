import { FormEvent, Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, Permission, Role, ROLE_LABELS, User } from "../api";
import { useSession } from "../App";
import { formatTime } from "../util";
import PasswordField, { generatePassword } from "../components/PasswordField";

const ROLES = Object.keys(ROLE_LABELS) as Role[];
const ROLE_HELP: Record<Role, string> = {
  admin: "Everything, including this page: accounts, roles, passwords.",
  head_designer: "Jobs, the whole index, keyline / dieline values and workflows.",
  designer: "Jobs and the index, but cannot change keyline / dieline values or workflows.",
  manager: "Jobs, approves finished mockups, sees the activity log; reads the index without changing it.",
};
const EMPTY = { email: "", name: "", role: "designer" as Role, password: "" };
// Rights the admin can give or take per person, over their role's (mirrors app.auth.OVERRIDABLE)
const ACCESS: [Permission, string][] = [
  ["edit_index", "Change the index (materials, clients, fields, sizes…)"],
  ["edit_keyline", "Change keyline / dieline values and workflows"],
  ["approve", "Approve finished jobs"],
  ["see_all_jobs", "See everyone's jobs"],
  ["view_activity", "See the activity log"],
  ["manage_errors", "Handle raised errors"],
];
interface Work { jobs: Record<string, number>; jobs_total: number; files: number; last_upload: string | null; errors_open: number; errors: number }

export default function Users() {
  const { user: me } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [work, setWork] = useState<Record<string, Work>>({});
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<{ id: number; email: string; name: string } | null>(null);
  const [access, setAccess] = useState<{ id: number; perms: Partial<Record<Permission, boolean>> } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => {
    api.get<User[]>("/api/users").then(setUsers).catch((e) => setError(String(e)));
    api.get<{ users: Record<string, Work> }>("/api/users/summary").then((r) => setWork(r.users)).catch(() => undefined);
  };
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
  // setting a password: the admin sees it (and can generate / copy it) until they close the row;
  // saved passwords are one-way hashes, so this is the only moment it can be seen
  const [pw, setPw] = useState<{ id: number; value: string; saved: boolean } | null>(null);
  const resetPassword = (u: User) => setPw(pw?.id === u.id ? null : { id: u.id, value: generatePassword(), saved: false });
  const savePassword = async (u: User) => {
    if (pw!.value.length < 10) { setError("The password needs at least 10 characters."); return; }
    if (await patch(u, { password: pw!.value }, `Password changed for ${u.email}; their open sessions were ended. Copy it now: it cannot be shown again once you close this.`)) setPw({ ...pw!, saved: true });
  };
  const toggleActive = (u: User) => {
    if (u.active && !window.confirm(`Deactivate ${u.email}? They are signed out at once and cannot sign in until activated again.`)) return;
    patch(u, { active: !u.active }, `${u.email} ${u.active ? "deactivated and signed out" : "activated"}.`);
  };
  const openAccess = (u: User) => setAccess(access?.id === u.id ? null : { id: u.id, perms: Object.fromEntries(ACCESS.map(([p]) => [p, u.permissions.includes(p)])) });
  const saveAccess = async (u: User) => {
    const body = Object.fromEntries(ACCESS.map(([p]) => [p, access!.perms[p] ?? false]));
    if (await patch(u, { permissions: body }, `Access saved for ${u.email}; it applies on their next click.`)) setAccess(null);
  };
  const resetAccess = async (u: User) => {
    if (await patch(u, { permissions: Object.fromEntries(ACCESS.map(([p]) => [p, null])) }, `${u.email} is back to what the ${ROLE_LABELS[u.role]} role gives.`)) setAccess(null);
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
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th title="Jobs they uploaded: done / all">Jobs</th><th>Files</th><th title="Errors they raised">Errors</th><th>Last upload</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (<Fragment key={u.id}>
              <tr style={u.active ? undefined : { opacity: 0.6 }}>
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
                  <select style={{ minWidth: 150 }} value={u.role} onChange={(e) => changeRole(u, e.target.value as Role)} title={ROLE_HELP[u.role]} aria-label={`Role of ${u.email}`}>
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </td>
                <td>
                  {u.active ? <span className="badge ok">active</span> : <span className="badge warn">deactivated</span>}{" "}
                  {Object.keys(u.permission_overrides ?? {}).length > 0 && <span className="badge accent" title="The admin changed this person's access from what their role gives">custom access</span>}{" "}
                  {u.locked && <span className="badge bad" title="Too many wrong passwords">locked</span>}
                </td>
                <td>
                  {(work[u.id]?.jobs_total ?? 0) > 0
                    ? <Link to={`/jobs?user=${u.id}`} title={Object.entries(work[u.id].jobs).map(([s, n]) => `${s}: ${n}`).join(", ")}>{work[u.id].jobs.DONE ?? 0} / {work[u.id].jobs_total}</Link>
                    : <span className="muted">0</span>}
                </td>
                <td>{work[u.id]?.files ?? 0}</td>
                <td>{work[u.id]?.errors_open ? <Link to="/errors" className="badge bad">{work[u.id].errors_open} open</Link> : <span className="muted">{work[u.id]?.errors ?? 0}</span>}</td>
                <td className="small muted">{work[u.id]?.last_upload ? formatTime(work[u.id].last_upload!) : "—"}</td>
                <td className="small muted">{u.last_login_at ? formatTime(u.last_login_at) : "never"}</td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <button onClick={() => setEditing({ id: u.id, email: u.email, name: u.name })}>Edit</button>
                    <button className={access?.id === u.id ? "on" : ""} onClick={() => openAccess(u)} aria-expanded={access?.id === u.id}>Access</button>
                    <button className={pw?.id === u.id ? "on" : ""} onClick={() => resetPassword(u)} aria-expanded={pw?.id === u.id}>Set password</button>
                    {u.locked && <button onClick={() => patch(u, { unlock: true }, `${u.email} unlocked.`)}>Unlock</button>}
                    {u.id !== me.id && <button onClick={() => act(() => api.post(`/api/users/${u.id}/sign-out`), `${u.email} signed out everywhere.`)} title="End all their open sessions">Sign out</button>}
                    {u.id !== me.id && <button className={u.active ? "danger" : ""} onClick={() => toggleActive(u)}>{u.active ? "Deactivate" : "Activate"}</button>}
                  </div>
                </td>
              </tr>
              {pw?.id === u.id && (
                <tr className="access-row">
                  <td colSpan={9}>
                    <div className="access-editor">
                      <div className="small muted">New password for <b>{u.name || u.email}</b> (10+ characters). Saving signs them out everywhere. {pw.saved ? <b>Saved. Copy it now and send it to them; it cannot be shown again after you close this.</b> : "A strong one is ready; change it if you like."}</div>
                      <PasswordField value={pw.value} onChange={(v) => setPw({ ...pw, value: v, saved: false })} autoFocus />
                      <div className="row">
                        {!pw.saved && <button className="primary" onClick={() => savePassword(u)}>Save password</button>}
                        <button onClick={() => setPw(null)}>{pw.saved ? "Done" : "Cancel"}</button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              {access?.id === u.id && (
                <tr className="access-row">
                  <td colSpan={9}>
                    <div className="access-editor">
                      <div className="small muted">What <b>{u.name || u.email}</b> may do beyond using jobs. Ticked = allowed. Rights that differ from the {ROLE_LABELS[u.role]} role are marked; every change is written to the activity log with its old and new value.</div>
                      <div className="access-grid">
                        {ACCESS.map(([p, label]) => {
                          const on = access.perms[p] ?? false, byRole = (u.role_permissions ?? []).includes(p);
                          return (
                            <label key={p} className={`check access-item ${on !== byRole ? "changed" : ""}`}>
                              <input type="checkbox" checked={on} disabled={u.role === "admin"} onChange={(e) => setAccess({ ...access, perms: { ...access.perms, [p]: e.target.checked } })} />
                              <span>{label}</span>
                              {on !== byRole && <span className="badge accent">{on ? "given" : "taken away"}</span>}
                            </label>
                          );
                        })}
                      </div>
                      {u.role === "admin" ? <div className="small muted">An admin can do everything; change their role to set access one by one.</div> : (
                        <div className="row">
                          <button className="primary" onClick={() => saveAccess(u)}>Save access</button>
                          <button onClick={() => resetAccess(u)}>Back to the role's access</button>
                          <button onClick={() => setAccess(null)}>Cancel</button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>))}
          </tbody>
        </table>
      </div>

      <div className="grid2" style={{ marginTop: 14, alignItems: "start" }}>
        <form className="card grid2" onSubmit={create}>
          <h2 style={{ gridColumn: "1 / -1", margin: 0 }}>Add user</h2>
          <label className="field">Email (sign-in id)<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field">Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></label>
          <label className="field">Password (10+ characters; copy it to send to them)<PasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} /></label>
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
