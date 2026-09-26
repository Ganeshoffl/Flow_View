import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Point at workspace sources rather than built output. A stale `dist` must never be what the
    // dev server serves, and it keeps the edit-reload loop honest.
    alias: {
      "@flow-view/renderers/styles.css": fileURLToPath(
        new URL("../../packages/renderers/src/styles.css", import.meta.url),
      ),
      "@flow-view/renderers": pkg("renderers"),
      "@flow-view/trace-schema/validate": fileURLToPath(
        new URL("../../packages/trace-schema/src/validate.ts", import.meta.url),
      ),
      "@flow-view/trace-schema": pkg("trace-schema"),
      "@flow-view/trace-store": pkg("trace-store"),
      "@flow-view/trace-fixtures": pkg("trace-fixtures"),
    },
  },
  server: {
    // Localhost only. flow_view is a local tool, and binding wider by default would expose an
    // execution surface the user never asked to publish.
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // In development the UI and the server run separately. In production the server serves the
      // built UI from its own origin, so no proxy exists and none is needed.
      "/api": {
        target: "http://127.0.0.1:7474",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
