import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The client is a plain Vite SPA. In dev it runs on :5173 and proxies agent
// traffic (HTTP + WebSocket) to `wrangler dev` on :8787. In production the
// built assets in dist/client are served by the Worker itself (see
// wrangler.jsonc -> assets).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/agents": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
