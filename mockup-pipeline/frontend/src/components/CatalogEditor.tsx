// Pouch catalog: the hierarchy Form -> Style -> Sealing type that groups the pouch types.
type Data = Record<string, unknown>;
interface Form { key: string; name: string; description: string }
interface Style { key: string; name: string; form: string; description: string }
interface Sealing { key: string; name: string; style: string; printed: string[]; description: string }

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export default function CatalogEditor({ data, onChange }: { data: Data; onChange: (d: Data) => void }) {
  const forms = (data.forms ?? []) as Form[];
  const styles = (data.styles ?? []) as Style[];
  const sealing = (data.sealing_types ?? []) as Sealing[];
  const set = (k: string, v: unknown) => onChange({ ...data, [k]: v });
  const update = <T,>(list: T[], i: number, patch: Partial<T>) => list.map((x, j) => (j === i ? { ...x, ...patch } : x));

  return (
    <div className="stack">
      <div className="muted small">Every pouch type sits under a sealing type, every sealing type under a style, every style under a form. The pouch type list is grouped this way and a workflow's SET POUCH TYPE node picks from it.</div>
      <div className="card stack">
        <h2>Forms</h2>
        <table className="kl-table"><thead><tr><th>Key</th><th>Name</th><th>Description</th><th /></tr></thead><tbody>
          {forms.map((f, i) => (
            <tr key={i}><td><input value={f.key} onChange={(e) => set("forms", update(forms, i, { key: slug(e.target.value) || e.target.value }))} /></td>
              <td><input value={f.name} onChange={(e) => set("forms", update(forms, i, { name: e.target.value }))} /></td>
              <td><input value={f.description} onChange={(e) => set("forms", update(forms, i, { description: e.target.value }))} /></td>
              <td><button className="link" onClick={() => set("forms", forms.filter((_, j) => j !== i))}>✕</button></td></tr>
          ))}
        </tbody></table>
        <div><button onClick={() => set("forms", [...forms, { key: "", name: "", description: "" }])}>+ form</button></div>
      </div>
      <div className="card stack">
        <h2>Styles</h2>
        <table className="kl-table"><thead><tr><th>Key</th><th>Name</th><th>Form</th><th>Description</th><th /></tr></thead><tbody>
          {styles.map((s, i) => (
            <tr key={i}><td><input value={s.key} onChange={(e) => set("styles", update(styles, i, { key: slug(e.target.value) || e.target.value }))} /></td>
              <td><input value={s.name} onChange={(e) => set("styles", update(styles, i, { name: e.target.value }))} /></td>
              <td><select value={s.form} onChange={(e) => set("styles", update(styles, i, { form: e.target.value }))}><option value="">—</option>{forms.map((f) => <option key={f.key} value={f.key}>{f.name || f.key}</option>)}</select></td>
              <td><input value={s.description} onChange={(e) => set("styles", update(styles, i, { description: e.target.value }))} /></td>
              <td><button className="link" onClick={() => set("styles", styles.filter((_, j) => j !== i))}>✕</button></td></tr>
          ))}
        </tbody></table>
        <div><button onClick={() => set("styles", [...styles, { key: "", name: "", form: forms[0]?.key ?? "", description: "" }])}>+ style</button></div>
      </div>
      <div className="card stack">
        <h2>Sealing types</h2>
        <table className="kl-table"><thead><tr><th>Key</th><th>Name</th><th>Style</th><th>Printed as (comma separated)</th><th /></tr></thead><tbody>
          {sealing.map((t, i) => (
            <tr key={i}><td><input value={t.key} onChange={(e) => set("sealing_types", update(sealing, i, { key: slug(e.target.value) || e.target.value }))} /></td>
              <td><input value={t.name} onChange={(e) => set("sealing_types", update(sealing, i, { name: e.target.value }))} /></td>
              <td><select value={t.style} onChange={(e) => set("sealing_types", update(sealing, i, { style: e.target.value }))}><option value="">—</option>{styles.map((s) => <option key={s.key} value={s.key}>{s.name || s.key}</option>)}</select></td>
              <td><input defaultValue={t.printed.join(", ")} onBlur={(e) => set("sealing_types", update(sealing, i, { printed: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }))} /></td>
              <td><button className="link" onClick={() => set("sealing_types", sealing.filter((_, j) => j !== i))}>✕</button></td></tr>
          ))}
        </tbody></table>
        <div><button onClick={() => set("sealing_types", [...sealing, { key: "", name: "", style: styles[0]?.key ?? "", printed: [], description: "" }])}>+ sealing type</button></div>
      </div>
    </div>
  );
}
