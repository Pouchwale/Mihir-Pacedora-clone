// Thin fetch wrapper. Every mutating call sends X-Requested-With (the server's CSRF check).

export class ApiError extends Error {
  status: number;
  problems: string[];
  constructor(status: number, message: string, problems: string[] = []) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Requested-With": "fetch",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") ?? "";
  const payload = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const detail = typeof payload === "object" ? payload.detail : payload;
    if (detail && typeof detail === "object" && Array.isArray(detail.problems)) {
      throw new ApiError(res.status, detail.problems.join("; "), detail.problems);
    }
    if (Array.isArray(detail)) {
      const problems = detail.map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg}`);
      throw new ApiError(res.status, problems.join("; "), problems);
    }
    throw new ApiError(res.status, String(detail ?? res.statusText));
  }
  return payload as T;
}

/** A multipart upload (files + fields) with the same error handling as JSON calls. */
async function upload<T>(url: string, files: Record<string, File>, fields: Record<string, string> = {}): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, f] of Object.entries(files)) fd.append(k, f, f.name);
  const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "fetch" }, body: fd });
  const type = res.headers.get("content-type") ?? "";
  const payload = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const detail = typeof payload === "object" ? payload.detail : payload;
    throw new ApiError(res.status, Array.isArray(detail) ? detail.map((d: { msg?: string }) => d.msg).join("; ") : String(detail ?? res.statusText));
  }
  return payload as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string, body: unknown) => request<T>("DELETE", url, body),
  upload,
};

export type Role = "admin" | "head_designer" | "designer" | "manager";
export type Permission = "manage_users" | "view_activity" | "edit_index" | "edit_keyline" | "approve" | "see_all_jobs" | "manage_errors";
export const ROLE_LABELS: Record<Role, string> = { admin: "Admin", head_designer: "Head of Designer", designer: "Designer", manager: "Manager" };
/** Index kinds holding keyline / dieline values (mirrors app.auth.KEYLINE_KINDS): edit_keyline only. */
export const KEYLINE_KINDS = new Set(["keyline_template", "pouch_type", "standard_size", "workflow"]);
export interface User {
  id: number; email: string; name: string; role: Role; active: boolean;
  permissions: Permission[]; locked: boolean; created_at: string | null; last_login_at: string | null;
}
export interface KindInfo { kind: string; label: string; singleton: boolean; count: number; page?: string | null }
export interface EntrySummary { kind: string; key: string; name: string; version: number; archived: boolean; updated_at: string; author: string; extra?: Record<string, unknown> }

// Workflow graphs (mirrors app/index/graph.py) and what a job records while walking one.
export type NodeType = "start" | "prepare" | "decision" | "fetch" | "validate" | "set_pouch_type" | "resolve_keyline" | "link_panels" | "build_3d" | "artwork" | "render" | "review" | "sub_workflow" | "end";
export interface FetchField { key: string; required: boolean; min_confidence: number | null }
export interface WfNode {
  id: string; type: NodeType; label: string; position: { x: number; y: number }; question: string; fields: FetchField[];
  pouch_type: string | null; message: string; workflow: string | null; notes: string;
}
export interface WfEdge { id: string; source: string; target: string; label: string; when: RuleGroup[]; otherwise: boolean; order: number }
export interface WfGraph { name: string; description: string; nodes: WfNode[]; edges: WfEdge[] }
export interface PathStep { step: string; implicit: boolean; status: string; seconds: number | null }
export interface PathRecord {
  node: string; type: string; label: string; status: "running" | "passed" | "review" | "failed"; started_at: string; finished_at: string | null;
  steps: PathStep[]; branch: string | null; edge: string | null; reason: string; parent: string | null; cached: boolean;
}
export interface JobWorkflow { key: string | null; version: number | null; kind: string; path: PathRecord[]; current_node: string | null; graph: WfGraph }
export interface WorkflowMeta {
  node_types: { type: NodeType; label: string; help: string; steps: string[] }[];
  steps: string[];
  pouch_types: Record<string, string>;
  fields: { key: string; name: string; kind: string; required: boolean; order: number }[];
  condition_fields: string[];
  workflows: Record<string, string>;
}
export interface WorkflowOut {
  key: string; name: string; archived: boolean; problems: string[];
  published: { version: number; graph: WfGraph; author: string; reason: string; created_at: string } | null;
  draft: { graph: WfGraph; updated_by: string; updated_at: string } | null;
}

export const emptyNode = (id: string, type: NodeType, x: number, y: number): WfNode => ({
  id, type, label: "", position: { x, y }, question: "", fields: [], pouch_type: null, message: "", workflow: null, notes: "",
});
export interface VersionMeta { version: number; action: string; reason: string; author: string; created_at: string }
export interface Entry { kind: string; key: string; version: number; current_version: number; archived: boolean; data: Record<string, unknown>; yaml: string; meta: VersionMeta }

// Index data shapes (mirrors app/index/schemas.py).
export interface Condition { field: string; op: string; value?: unknown }
export interface RuleGroup { all: Condition[] }
export interface KeylineField {
  type: "number" | "bool" | "enum" | "text";
  unit: string;
  default: unknown;
  pin: boolean;
  min: number | null;
  max: number | null;
  options: string[];
  formula: string | null;
  from_measured: string | null;
  from_spec: string | null;
  value_map: Record<string, unknown>;
  enabled_when: RuleGroup[];
  description: string;
}

export const OPS = ["eq", "ne", "in", "not_in", "contains", "not_contains", "gt", "gte", "lt", "lte", "exists", "missing", "is_true", "is_false"];
export const GEOMETRY_TEMPLATES = [
  "three_side_seal", "center_seal_pillow", "center_seal_side_gusset", "stand_up_bottom_gusset",
  "flat_bottom_box_pouch", "quad_seal", "spout_pouch", "shaped_diecut", "roll_stock",
];
export const PANELS = ["front", "back", "gusset", "side_left", "side_right", "bottom", "top"];
export const VIEWS = ["front", "back", "three_quarter_left", "three_quarter_right", "top_down", "turntable"];
export const SPEC_FIELDS = [
  "spec.client_name", "spec.item_no", "spec.pouch_or_roll_form", "spec.sealing_type", "spec.gusset_type",
  "spec.gusset_full_width_mm", "spec.zipper", "spec.round_corner", "spec.transparent_window", "spec.tear_notch",
  "spec.butterfly_notch", "spec.finish", "spec.layers_text", "spec.raw_remarks", "spec.pouch_height_mm",
  "spec.pouch_closed_width_mm", "spec.pouch_open_width_mm", "spec.sealing_width_mm", "panels",
];
