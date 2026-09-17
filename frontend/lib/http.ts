import { NextResponse } from "next/server";

/** Maximum sizes accepted from clients (characters of the JSON/base64 strings). */
export const LIMITS = {
  body: 60 * 1024 * 1024, // whole request body
  objData: 40 * 1024 * 1024, // uploaded 3D model (base64 GLB or OBJ text)
  editorState: 40 * 1024 * 1024, // design settings incl. uploaded artwork images
  documentData: 20 * 1024 * 1024, // attached brief (base64)
  thumbnail: 3 * 1024 * 1024,
  name: 120,
  description: 1000,
  remarks: 2000,
  fileName: 255,
};

export const badRequest = (message: string) => NextResponse.json({ message, error: message }, { status: 400 });

/**
 * Parses a JSON object body. Returns a 400/413 response instead of throwing on malformed or
 * oversized input, so bad requests never surface as 500 errors.
 */
export async function readJson(
  req: Request,
  maxBytes = LIMITS.body
): Promise<{ body: Record<string, any>; error?: undefined } | { body?: undefined; error: NextResponse }> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    return { error: NextResponse.json({ message: "Request is too large" }, { status: 413 }) };
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { error: badRequest("Could not read request body") };
  }
  if (text.length > maxBytes) {
    return { error: NextResponse.json({ message: "Request is too large" }, { status: 413 }) };
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: badRequest("Invalid request body") };
    return { body };
  } catch {
    return { error: badRequest("Invalid JSON body") };
  }
}

/** Returns an error message when an optional string field is not a string or too long. */
export function checkString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return `${field} must be text`;
  if (value.length > max) return `${field} is too long`;
  return null;
}

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** Thumbnails must be a real raster image data URL (never HTML/SVG, which could run scripts). */
export function isSafeThumbnail(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.length <= LIMITS.thumbnail && IMAGE_DATA_URL.test(value);
}

// Attached briefs: PDF / Word only, as base64 data URLs (never HTML, SVG or other links)
const DOCUMENT_DATA_URL =
  /^data:(|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/octet-stream);base64,[A-Za-z0-9+/=]*$/;

export function isSafeDocument(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return typeof value === "string" && value.length <= LIMITS.documentData && DOCUMENT_DATA_URL.test(value);
}
