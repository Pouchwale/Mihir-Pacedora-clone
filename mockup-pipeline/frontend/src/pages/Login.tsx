import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, User } from "../api";
import LoginScene from "../components/LoginScene";

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(await api.post<User>("/api/auth/login", { email, password }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-stage">
        <LoginScene />
        <div className="login-stage-copy">
          <h2>Packaging mockups, in 3D.</h2>
          <p>Approval PDFs become pouches, rolls and sleeves you can turn, share and print.</p>
        </div>
        <div className="login-stage-hint">Drag to turn the table</div>
      </section>

      <section className="login-side">
        <form className="login-form" onSubmit={submit}>
          <img className="login-logo" src="/gp3-logo.png" alt="Gujarat Print Pack Publications Pvt. Ltd." />
          <div className="login-head">
            <h1 className="login-title">Sign in to GP3 Mockup</h1>
            <div className="muted">Use the email your administrator set up for you.</div>
          </div>
          <label className="field">Email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label className="field">Password
            <span className="password-row">
              <input type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="password-eye" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} title={show ? "Hide password" : "Show password"}>
                {show ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l18 18" /><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3.2 4.3M6.6 6.6A13.4 13.4 0 0 0 2 12c1 2.5 5 7 10 7a10 10 0 0 0 4.4-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </span>
          </label>
          {error && <div className="msg bad" role="alert">{error}</div>}
          <button className="primary login-submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          <div className="muted small login-foot">Gujarat Print Pack Publications Pvt. Ltd.</div>
        </form>
      </section>
    </div>
  );
}

/** Shown once, right after signing in: a short greeting with the person's name. */
export function Welcome({ user, onClose }: { user: User; onClose: () => void }) {
  const name = user.name?.trim() || user.email.split("@")[0];
  useEffect(() => { const t = window.setTimeout(onClose, 4000); return () => window.clearTimeout(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- closes itself once
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title" onClick={onClose} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="welcome-card" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-mark">
          <img src="/gp3-mark.png" alt="" />
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" /></svg>
        </div>
        <div className="muted small">Signed in</div>
        <h2 id="welcome-title">Welcome, {name}</h2>
        <div className="muted">Your mockups are ready when you are.</div>
        <button className="primary login-submit" onClick={onClose} autoFocus>Continue</button>
      </div>
    </div>
  );
}
