/**
 * Saves a stored base64 data URL (e.g. an attached brief) as a file.
 * The stored value is never used as a link: it is decoded into a Blob, so a malicious value
 * such as "javascript:..." or an external URL can't run script or navigate the user.
 */
export function downloadDataUrl(dataUrl: string | null | undefined, filename: string | null | undefined): boolean {
  const match = typeof dataUrl === "string" ? dataUrl.match(/^data:[^;,]*;base64,([A-Za-z0-9+/=]*)$/) : null;
  if (!match) return false;
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = (filename || "document").replace(/[\/:*?"<>|]+/g, "_");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
