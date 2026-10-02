import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, Role, User } from "../api";
import { useSession } from "../App";

export default function Users() {
  const { user: me } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ email: "", name: "", role: "operator" as Role, password: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => api.get<User[]>("/api/users").then(setUsers);
  useEffect(() => { load(); }, []);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(ok);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    act(() => api.post("/api/users", form), `Created ${form.email}.`).then(() => setForm({ email: "", name: "", role: "operator", password: "" }));
  };

  const resetPassword = (u: User) => {
    const password = window.prompt(`New password for ${u.email} (at least 10 characters)`);
    if (password) act(() => api.patch(`/api/users/${u.id}`, { password }), `Password changed for ${u.email}.`);
  };

  return (
    <>
      <div className="page-head"><div><h1>Users</h1><div className="muted">Admins edit the index and approve; operators upload jobs and fix NEEDS_REVIEW.</div></div></div>
      {error && <div className="msg bad" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="msg ok" style={{ marginBottom: 12 }}>{notice}</div>}
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email} {u.id === me.id && <span className="badge">you</span>}</td>
                <td>{u.name}</td>
                <td>
                  <select value={u.role} onChange={(e) => act(() => api.patch(`/api/users/${u.id}`, { role: e.target.value }), `Role of ${u.email} changed.`)}>
                    <option value="operator">operator</option><option value="admin">admin</option>
                  </select>
                </td>
                <td>{u.active ? <span className="badge ok">active</span> : <span className="badge warn">inactive</span>}</td>
                <td className="row">
                  <button onClick={() => resetPassword(u)}>Set password</button>
                  <button onClick={() => act(() => api.patch(`/api/users/${u.id}`, { active: !u.active }), `${u.email} ${u.active ? "deactivated" : "activated"}.`)}>{u.active ? "Deactivate" : "Activate"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="card grid2" onSubmit={create} style={{ marginTop: 14 }}>
        <h2 style={{ gridColumn: "1 / -1" }}>Add user</h2>
        <label className="field">Email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label className="field">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field">Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}><option value="operator">operator</option><option value="admin">admin</option></select></label>
        <label className="field">Password (10+ characters)<input type="password" minLength={10} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <div><button className="primary">Add user</button></div>
      </form>
    </>
  );
}
