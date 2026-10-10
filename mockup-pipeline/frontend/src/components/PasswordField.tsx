// A password the admin is setting: shown or hidden (eye), a strong one generated, copied to send to the person.
// (Saved passwords are one-way hashes and cannot be read back; this is the moment the admin can see one.)
import { useState } from "react";

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%+=";

export function generatePassword(n = 14): string {
  const r = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(r, (v) => CHARS[v % CHARS.length]).join("");
}

export default function PasswordField({ value, onChange, autoFocus = false }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard: the shown text can be selected */ }
  };
  return (
    <span className="pw-field">
      <span className="password-row">
        <input type={show ? "text" : "password"} minLength={10} required autoComplete="new-password" value={value} autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)} aria-label="Password" />
        <button type="button" className="password-eye" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} title={show ? "Hide" : "Show"}>
          {show ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l18 18" /><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3.2 4.3M6.6 6.6A13.4 13.4 0 0 0 2 12c1 2.5 5 7 10 7a10 10 0 0 0 4.4-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
      </span>
      <button type="button" onClick={() => { onChange(generatePassword()); setShow(true); }} title="A strong random password">Generate</button>
      <button type="button" onClick={copy} disabled={!value}>{copied ? "Copied" : "Copy"}</button>
    </span>
  );
}
