// A sheet with several designs (FGPO6443: three flavours): one small picture of each design's front.
// `multi`: the pictures add or remove designs from the frame, and "All" shows every one side by side.
import type { SceneData } from "../three/types";

type Designs = NonNullable<SceneData["designs"]>;

export function designThumb(d: Designs[number]): string | undefined {
  const t = d.textures.front ?? Object.values(d.textures)[0];
  return t && !t.color ? t.url : undefined;
}

export default function DesignPicker({ designs, picked, onChange, multi = false }: { designs: Designs; picked: number[]; onChange: (p: number[]) => void; multi?: boolean }) {
  if (designs.length < 2) return null;
  const all = picked.length === designs.length;
  const click = (i: number) => {
    if (!multi) return onChange([i]);
    if (!picked.includes(i)) return onChange([...picked, i].sort((a, b) => a - b));
    if (picked.length > 1) onChange(picked.filter((p) => p !== i));
  };
  return (
    <div className="design-picker" role="group" aria-label="Designs on this sheet" title={multi ? "Click designs to add them to the frame or take them out" : "Show one of the sheet's designs"}>
      {designs.map((d) => {
        const src = designThumb(d), on = picked.includes(d.index);
        return (
          <button key={d.index} className={on ? "on" : ""} onClick={() => click(d.index)} aria-pressed={on} aria-label={`Design ${d.index}`}>
            {src ? <img src={src} alt="" loading="lazy" /> : <span>{d.index}</span>}
          </button>
        );
      })}
      {multi && <button className={`design-all ${all ? "on" : ""}`} onClick={() => onChange(all ? [picked[0]] : designs.map((d) => d.index))} aria-pressed={all}>All</button>}
    </div>
  );
}
