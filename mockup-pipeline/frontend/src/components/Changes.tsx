// What an index / workflow change did, value by value: the field, its old value struck through, the new one in bold.
export interface Change { path: string; old: unknown; new: unknown }

function show(v: unknown): string {
  if (v === null || v === undefined) return "(none)";
  if (typeof v === "string") return v === "" ? '""' : v;
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

export default function Changes({ changes, max = 50 }: { changes: Change[]; max?: number }) {
  if (!changes.length) return <span className="muted small">No values changed.</span>;
  return (
    <ul className="changes">
      {changes.slice(0, max).map((c, i) => (
        <li key={i}>
          <code>{c.path}</code>{" "}
          {c.old !== null && c.old !== undefined && <><s className="muted">{show(c.old)}</s> → </>}
          <b>{c.new === null || c.new === undefined ? "(removed)" : show(c.new)}</b>
        </li>
      ))}
      {changes.length > max && <li className="muted">…and {changes.length - max} more</li>}
    </ul>
  );
}
