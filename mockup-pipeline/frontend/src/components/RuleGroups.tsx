import { Condition, OPS, RuleGroup, SPEC_FIELDS } from "../api";

const NO_VALUE = new Set(["exists", "missing", "is_true", "is_false"]);
const NUMERIC = new Set(["gt", "gte", "lt", "lte"]);

function showValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  return v === undefined || v === null ? "" : String(v);
}

function parseValue(op: string, text: string): unknown {
  if (NO_VALUE.has(op)) return null;
  if (NUMERIC.has(op)) return text === "" ? null : Number(text);
  if (op === "in" || op === "not_in" || ((op === "contains" || op === "not_contains") && text.includes(","))) {
    return text.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return text;
}

/** OR of groups; each group is an AND of conditions. `fields` widens the field suggestions (workflow decisions see job.* too). */
export default function RuleGroups({ groups, onChange, emptyText, fields }: { groups: RuleGroup[]; onChange: (g: RuleGroup[]) => void; emptyText?: string; fields?: string[] }) {
  const setCond = (gi: number, ci: number, c: Condition) =>
    onChange(groups.map((g, i) => (i !== gi ? g : { all: g.all.map((x, j) => (j === ci ? c : x)) })));
  const addCond = (gi: number) =>
    onChange(groups.map((g, i) => (i !== gi ? g : { all: [...g.all, { field: "spec.sealing_type", op: "eq", value: "" }] })));
  const removeCond = (gi: number, ci: number) =>
    onChange(groups.map((g, i) => (i !== gi ? g : { all: g.all.filter((_, j) => j !== ci) })).filter((g) => g.all.length > 0));
  const suggestions = fields ?? SPEC_FIELDS;

  return (
    <div className="stack">
      <datalist id="spec-fields">{suggestions.map((f) => <option key={f} value={f} />)}</datalist>
      {groups.length === 0 && <span className="muted small">{emptyText ?? "No rules."}</span>}
      {groups.map((g, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="or">— OR —</div>}
          <div className="group">
            {g.all.map((c, ci) => (
              <div className="cond" key={ci}>
                <input list="spec-fields" value={c.field} onChange={(e) => setCond(gi, ci, { ...c, field: e.target.value })} aria-label="field" />
                <select value={c.op} onChange={(e) => setCond(gi, ci, { ...c, op: e.target.value, value: parseValue(e.target.value, showValue(c.value)) })} aria-label="operator">
                  {OPS.map((o) => <option key={o}>{o}</option>)}
                </select>
                <input value={showValue(c.value)} disabled={NO_VALUE.has(c.op)} placeholder={c.op === "in" || c.op === "not_in" ? "a, b, c" : "value"}
                  onChange={(e) => setCond(gi, ci, { ...c, value: parseValue(c.op, e.target.value) })} aria-label="value" />
                <button className="link" onClick={() => removeCond(gi, ci)} title="Remove condition">✕</button>
              </div>
            ))}
            <button className="link small" onClick={() => addCond(gi)}>+ AND condition</button>
          </div>
        </div>
      ))}
      <div><button onClick={() => onChange([...groups, { all: [{ field: "spec.sealing_type", op: "eq", value: "" }] }])}>+ OR group</button></div>
    </div>
  );
}
