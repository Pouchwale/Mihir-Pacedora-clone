import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, KEYLINE_KINDS, KindInfo, Permission, ROLE_LABELS, User } from "./api";
import Activity from "./pages/Activity";
import Notifications from "./components/Notifications";
import RaiseError from "./components/RaiseError";
import ErrorReports from "./pages/ErrorReports";
import EntryPage from "./pages/EntryPage";
import ImportExport from "./pages/ImportExport";
import JobDetail from "./pages/JobDetail";
import Jobs from "./pages/Jobs";
import KindList from "./pages/KindList";
import Login, { Welcome } from "./pages/Login";
import RenderPage from "./pages/RenderPage";
import RuleTester from "./pages/RuleTester";
import Upload from "./pages/Upload";
import Users from "./pages/Users";
import SharePage from "./pages/SharePage";
import WorkflowEditor from "./pages/WorkflowEditor";
import Workflows from "./pages/Workflows";

interface Session {
  user: User;
  /** The signed-in user's role allows this (app.auth.PERMISSIONS). */
  can: (permission: Permission) => boolean;
  /** May change entries of this index kind (keyline / dieline kinds and workflows need edit_keyline). */
  canEdit: (kind: string) => boolean;
  kinds: KindInfo[];
  refreshKinds: () => void;
}
const SessionContext = createContext<Session | null>(null);
export const useSession = () => useContext(SessionContext)!;

export default function App() {
  const location = useLocation();
  // Public share page: token-authenticated, no login required.
  if (location.pathname.startsWith("/share/")) {
    return (
      <Routes>
        <Route path="/share/:jobId" element={<SharePage />} />
      </Routes>
    );
  }
  // Headless render target: authorised by a signed token, no session or shell.
  if (location.pathname.startsWith("/render/")) {
    return (
      <Routes>
        <Route path="/render/:jobId" element={<RenderPage />} />
      </Routes>
    );
  }
  return <SignedIn />;
}

function SignedIn() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [welcome, setWelcome] = useState(false); // the greeting after a fresh sign-in (not a restored session)
  const [kinds, setKinds] = useState<KindInfo[]>([]);

  const refreshKinds = useCallback(() => {
    api.get<KindInfo[]>("/api/index/kinds").then(setKinds).catch(() => undefined);
  }, []);

  useEffect(() => {
    api.get<{ user: User | null }>("/api/auth/session").then((s) => setUser(s.user)).catch(() => setUser(null));
  }, []);
  useEffect(() => {
    if (user) refreshKinds();
  }, [user, refreshKinds]);
  // Every page the user opens goes to the activity log (with the API calls, their whole trail).
  const location = useLocation();
  useEffect(() => {
    if (user) api.post("/api/activity", { page: location.pathname + location.search }).catch(() => undefined);
  }, [user, location.pathname, location.search]);

  if (user === undefined) return <div className="boot muted">Loading…</div>;
  if (user === null) return <Login onLogin={(u) => { setUser(u); setWelcome(true); }} />;

  const can = (p: Permission) => user.permissions.includes(p);
  const canEdit = (kind: string) => can(KEYLINE_KINDS.has(kind) ? "edit_keyline" : "edit_index");
  return (
    <SessionContext.Provider value={{ user, can, canEdit, kinds, refreshKinds }}>
      <Shell>
        <Routes>
          <Route path="/" element={<Navigate to="/jobs" replace />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/workflows" element={<Workflows />} />
          <Route path="/workflows/:key" element={<WorkflowEditor />} />
          <Route path="/index/tools/import-export" element={<ImportExport />} />
          <Route path="/index/tools/test" element={<RuleTester />} />
          <Route path="/index/:kind" element={<KindList />} />
          <Route path="/index/:kind/:key" element={<EntryPage />} />
          <Route path="/users" element={can("manage_users") ? <Users /> : <Navigate to="/" />} />
          <Route path="/activity" element={can("view_activity") ? <Activity /> : <Navigate to="/" />} />
          <Route path="/errors" element={can("manage_errors") ? <ErrorReports /> : <Navigate to="/" />} />
          <Route path="*" element={<p className="muted">Page not found.</p>} />
        </Routes>
      </Shell>
      {welcome && <Welcome user={user} onClose={() => setWelcome(false)} />}
    </SessionContext.Provider>
  );
}

// Small line icons for the sidebar (24px grid, stroked).
const NAV_ICONS: Record<string, string> = {
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  jobs: "M3 7h18M3 12h18M3 17h12",
  workflows: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  index: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14zM20 17v4H6.5",
  test: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  yaml: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  errors: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
};
export const NavIcon = ({ name, size = 17 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={NAV_ICONS[name] ?? NAV_ICONS.index} /></svg>
);

type Theme = "light" | "dark" | "system";
/** Light / dark / follow the system; remembered in this browser. */
function useTheme(): [Theme, (t: Theme) => void] {
  const read = (): Theme => { try { return (localStorage.getItem("theme") as Theme) || "system"; } catch { return "system"; } };
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("theme", theme); } catch { /* private window */ }
  }, [theme]);
  return [theme, setTheme];
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, kinds, can } = useSession();
  // open error reports, for the admin's sidebar badge (checked every half minute)
  const [openErrors, setOpenErrors] = useState(0);
  useEffect(() => {
    if (!can("manage_errors")) return;
    const load = () => api.get<{ counts: { open: number } }>("/api/errors?status=open").then((r) => setOpenErrors(r.counts.open)).catch(() => undefined);
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  const [theme, setTheme] = useTheme();
  const logout = async () => {
    await api.post("/api/auth/logout");
    // Full reload: no state from the previous user survives (open forms, cached lists).
    window.location.assign("/");
  };
  const indexKinds = kinds.filter((k) => !k.page);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/gp3-mark.png" alt="" />
          GP3 Mockup
        </div>
        <NavLink to="/upload" className="nav-cta"><NavIcon name="upload" /> Upload PDFs</NavLink>
        <nav className="nav">
          <NavLink to="/jobs" end><NavIcon name="jobs" /><span>Jobs</span></NavLink>
        </nav>
        <div className="nav-section">Workflow</div>
        <nav className="nav">
          <NavLink to="/workflows"><NavIcon name="workflows" /><span>Workflows</span></NavLink>
        </nav>
        <div className="nav-section">Indexing</div>
        <nav className="nav">
          {indexKinds.map((k) => (
            <NavLink key={k.kind} to={k.singleton ? `/index/${k.kind}/default` : `/index/${k.kind}`}>
              <NavIcon name="index" />
              <span>{k.label}</span>
              {!k.singleton && <span className="count">{k.count}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="nav-section">Tools</div>
        <nav className="nav">
          <NavLink to="/index/tools/test"><NavIcon name="test" /><span>Rule tester</span></NavLink>
          <NavLink to="/index/tools/import-export"><NavIcon name="yaml" /><span>YAML import / export</span></NavLink>
          {can("manage_users") && <NavLink to="/users"><NavIcon name="users" /><span>Users</span></NavLink>}
          {can("view_activity") && <NavLink to="/activity"><NavIcon name="activity" /><span>Activity log</span></NavLink>}
          {can("manage_errors") && <NavLink to="/errors"><NavIcon name="errors" /><span>Error reports</span>{openErrors > 0 && <span className="count alert">{openErrors}</span>}</NavLink>}
        </nav>
        <div className="sidebar-foot">
          {can("manage_users") && <Notifications />}
          <RaiseError className="raise-error-side" />
          <div className="theme-switch" role="group" aria-label="Theme">
            {(["light", "dark", "system"] as Theme[]).map((t) => (
              <button key={t} className={theme === t ? "on" : ""} onClick={() => setTheme(t)}>{{ light: "Light", dark: "Dark", system: "Auto" }[t]}</button>
            ))}
          </div>
          <div className="user-chip">
            <span className="avatar">{user.email.slice(0, 1)}</span>
            <span className="who" title={user.email}>{user.email}</span>
            <span className={`badge ${user.role === "admin" ? "accent" : ""}`}>{ROLE_LABELS[user.role] ?? user.role}</span>
          </div>
          <button className="link" style={{ textAlign: "left", padding: 0 }} onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
