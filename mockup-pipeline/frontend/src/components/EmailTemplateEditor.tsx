// Email template: the Gmail message the job page's "Send to Mail" button opens beside a share link.
type Data = Record<string, unknown>;

const SAMPLE: Record<string, string> = {
  link: "https://gujprintpack.mockup.ngrok.app/share/123?token=…", item_code: "FGPO1234", client: "ABC Foods",
  pouch_type: "stand up pouch", days: "7", sender: "Your name",
};
const fill = (t: string) => Object.entries(SAMPLE).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), t);

export default function EmailTemplateEditor({ data, onChange }: { data: Data; onChange: (d: Data) => void }) {
  const set = (k: string, v: string) => onChange({ ...data, [k]: v });
  const subject = String(data.subject ?? "");
  const body = String(data.body ?? "");
  return (
    <div className="card">
      <label className="field">Subject<input value={subject} onChange={(e) => set("subject", e.target.value)} /></label>
      <label className="field">Body<textarea rows={12} value={body} onChange={(e) => set("body", e.target.value)} /></label>
      <div className="muted small" style={{ marginBottom: 12 }}>
        Filled in for each job: {Object.keys(SAMPLE).map((k) => <code key={k} style={{ marginRight: 6 }}>{`{${k}}`}</code>)}
        <br /><code>{"{client}"}</code> is the spec table's client name ("Sir/Madam" when none); <code>{"{sender}"}</code> is the signed-in user's name.
      </div>
      <div className="field">Preview (sample job)</div>
      <div className="card" style={{ whiteSpace: "pre-wrap", margin: 0 }}><b>{fill(subject)}</b>{"\n\n"}{fill(body)}</div>
    </div>
  );
}
