// The bell: errors you raised that the admin has solved. Unread = solved since you last opened it.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { formatTime } from "../util";

interface Item { id: number; job_id: number | null; item_code: string | null; message: string; admin_note: string; resolved_by: string | null; resolved_at: string | null; unread: boolean }

/** `top`: in a page header (people other than the admin see it there, at a glance); else the sidebar foot. */
export default function Notifications({ top = false }: { top?: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const load = () => api.get<{ unread: number; items: Item[] }>("/api/errors/notifications").then((r) => { setItems(r.items); setUnread(r.unread); }).catch(() => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && unread) api.post("/api/errors/notifications/seen").then(() => setUnread(0)).catch(() => undefined); // (items keep their "new" mark until closed)
    if (!next) load();
  };
  return (
    <div className={`notif ${top ? "notif-top" : ""}`} ref={box}>
      <button className={`notif-bell ${top && unread ? "has-new" : ""}`} onClick={toggle} aria-expanded={open} aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span>Notifications</span>
        {unread > 0 && <span className="count alert">{unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head"><b>Notifications</b></div>
          {items.length === 0 && <div className="muted small notif-empty">Nothing yet. When the admin solves an error you raised, it shows here.</div>}
          {items.map((n) => (
            <div key={n.id} className={`notif-item ${n.unread ? "new" : ""}`}>
              <div className="small"><span className="badge ok">solved</span> <b>{n.resolved_by ?? "The admin"}</b> solved your error{n.item_code ? <> on {n.job_id ? <Link to={`/jobs/${n.job_id}`} onClick={() => setOpen(false)}>{n.item_code}</Link> : n.item_code}</> : ""}</div>
              {n.message && <div className="muted small clamp">You wrote: {n.message}</div>}
              {n.admin_note && <div className="small">Admin's note: {n.admin_note}</div>}
              {n.resolved_at && <div className="muted small">{formatTime(n.resolved_at)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
