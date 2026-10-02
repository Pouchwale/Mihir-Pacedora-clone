import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on :8765 (uvicorn); in production FastAPI serves dist/ itself.
export default defineConfig({
  plugins: [react()],
  // Own (empty) PostCSS config, so the parent Next.js app's Tailwind setup is not picked up.
  css: { postcss: { plugins: [] } },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8765" } },
  build: { outDir: "dist", sourcemap: false },
});
