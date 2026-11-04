import react from "@vitejs/plugin-react";
// @ts-ignore -- @types/node is not a dependency here; Vite runs this file under Node, where node:fs exists
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// In development the API runs on :8765 (uvicorn), or on the next free port: run_local.ps1 writes the one
// it used to backend/.work/port. In production FastAPI serves dist/ itself.
function apiPort(): number {
  try {
    const port = Number(readFileSync(new URL("../backend/.work/port", import.meta.url), "utf8").trim());
    if (Number.isInteger(port) && port > 0) return port;
  } catch { /* the app was not started with run_local.ps1 */ }
  return 8765;
}

export default defineConfig({
  plugins: [react()],
  // Own (empty) PostCSS config, so the parent Next.js app's Tailwind setup is not picked up.
  css: { postcss: { plugins: [] } },
  // 5173 when free, else Vite takes the next one itself (and prints it)
  server: { port: 5173, proxy: { "/api": `http://127.0.0.1:${apiPort()}` } },
  build: {
    outDir: "dist",
    sourcemap: false,
    // three and the flow-chart library in their own chunks: cached across releases, the app chunk stays small
    rollupOptions: { output: { manualChunks: (id) => (/node_modules[\\/]three[\\/]/.test(id) ? "three" : /node_modules[\\/]@xyflow[\\/]/.test(id) ? "xyflow" : undefined) } },
  },
});
