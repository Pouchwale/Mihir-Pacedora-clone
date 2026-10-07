/** A server timestamp as a Date. The server sends UTC; one without a zone (an old record) is UTC too,
 * never the browser's local time. */
export const parseTime = (iso: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);

/** "07 Oct 2026, 09:32 am" in this computer's time zone, the same on every page. */
export const formatTime = (iso: string, seconds = false) =>
  parseTime(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: true,
  });

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

// Starting data for a brand-new entry that is not copied from another one.
export const STARTERS: Record<string, Record<string, unknown>> = {
  client: { client_name: "", default_output_preset: null, include_eyemarks: false, keyline_overrides: {}, notes: "" },
  item_override: { pouch_type: null, keyline_overrides: {}, output_preset: null, notes: "" },
  output_preset: { name: "", is_default: false, views: ["front"], width_px: 2000, height_px: 2000, background: { type: "studio_white", colors: [] }, formats: ["png"] },
  material: { name: "", priority: 100, when: [], surface: "base", settings: { roughness: 0.5 } },
  field: { name: "", label: "", aliases: [], kind: "text", options: [], synonyms: {}, unit: "", min: null, max: null, required: false, optional: true, min_confidence: null, section: false, multiline: false, stop: false, source: "spec_table", order: 100, description: "" },
  standard_size: { name: "", pouch_type: null, width_mm: 240, height_mm: 312, gusset_mm: null, tolerance_mm: 2, notes: "" },
};
