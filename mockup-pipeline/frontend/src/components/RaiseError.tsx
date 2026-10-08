import { useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api, ApiError } from "../api";

/** "Raise an error": tell the admin something went wrong. On a job page the report carries the job
 *  (and the server keeps its state); anywhere else it is a general report. The note is optional. */
export default function RaiseError({ jobId, className = "" }: { jobId?: number; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const location = useLocation();
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  const open = () => { setState("idle"); setError(""); setMessage(""); dialog.current?.showModal(); };
  const send = async () => {
    setState("sending");
    setError("");
    try {
      await api.post("/api/errors", { job_id: jobId ?? null, message, page: location.pathname });
      setState("sent");
      setTimeout(() => dialog.current?.close(), 1600);
    } catch (e) {
      setState("idle");
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <>
      <button type="button" className={`raise-error ${className}`} onClick={open} title="Tell the admin about a problem">⚠ Raise an error</button>
      <dialog ref={dialog} className="dialog" onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
        <div className="dialog-body">
          <h2 style={{ margin: 0 }}>Raise an error</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {jobId ? <>The admin sees this job (#{jobId}) as it is right now, with your note.</> : <>The admin gets this report with the page you are on.</>}
          </p>
          {state === "sent" ? (
            <div className="msg ok">Sent. The admin will look at it.</div>
          ) : (
            <>
              <label className="field">What went wrong? <span className="muted">(optional)</span>
                <textarea rows={4} value={message} maxLength={4000} autoFocus placeholder="e.g. the back panel shows the front artwork"
                  onChange={(e) => setMessage(e.target.value)} />
              </label>
              {error && <div className="msg bad">{error}</div>}
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
                <button type="button" className="primary" disabled={state === "sending"} onClick={send}>{state === "sending" ? "Sending…" : "Send to admin"}</button>
              </div>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
