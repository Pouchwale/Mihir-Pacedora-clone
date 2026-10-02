import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, KindInfo, User } from "./api";
import EntryPage from "./pages/EntryPage";
import ImportExport from "./pages/ImportExport";
import JobDetail from "./pages/JobDetail";
import Jobs from "./pages/Jobs";
import KindList from "./pages/KindList";
import Login from "./pages/Login";
import RenderPage from "./pages/RenderPage";
import RuleTester from "./pages/RuleTester";
import Upload from "./pages/Upload";
import Users from "./pages/Users";
import SharePage from "./pages/SharePage";
import WorkflowEditor from "./pages/WorkflowEditor";
import Workflows from "./pages/Workflows";

interface Session {
  user: User;
  isAdmin: boolean;
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

  if (user === undefined) return <div className="login muted">Loadingâ€¦</div>;
  if (user === null) return <Login onLogin={setUser} />;

  return (
    <SessionContext.Provider value={{ user, isAdmin: user.role === "admin", kinds, refreshKinds }}>
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
          <Route path="/users" element={user.role === "admin" ? <Users /> : <Navigate to="/" />} />
          <Route path="*" element={<p className="muted">Page not found.</p>} />
        </Routes>
      </Shell>
    </SessionContext.Provider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, kinds, isAdmin } = useSession();
  const logout = async () => {
    await api.post("/api/auth/logout");
    // Full reload: no state from the previous user survives (open forms, cached lists).
    window.location.assign("/");
  };
  const indexKinds = kinds.filter((k) => !k.page);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" /> Pouch Mockups</div>
        <nav className="nav">
          <NavLink to="/upload">Upload</NavLink>
          <NavLink to="/jobs" end>Jobs</NavLink>
        </nav>
        <div className="nav-section">Workflow</div>
        <nav className="nav">
          <NavLink to="/workflows">Workflows</NavLink>
        </nav>
        <div className="nav-section">Indexing</div>
        <nav className="nav">
          {indexKinds.map((k) => (
            <NavLink key={k.kind} to={k.singleton ? `/index/${k.kind}/default` : `/index/${k.kind}`}>
              <span>{k.label}</span>
              {!k.singleton && <span className="count">{k.count}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="nav-section">Tools</div>
        <nav className="nav">
          <NavLink to="/index/tools/test">Rule tester</NavLink>
          <NavLink to="/index/tools/import-export">YAML import / export</NavLink>
          {isAdmin && <NavLink to="/users">Users</NavLink>}
        </nav>
        <div className="sidebar-foot">
          <span>{user.email}</span>
          <span><span className={`badge ${isAdmin ? "accent" : ""}`}>{user.role}</span></span>
          <button className="link" style={{ textAlign: "left", padding: 0 }} onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
