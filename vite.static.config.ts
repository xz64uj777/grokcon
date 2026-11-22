import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // This entry is a self-contained client-side build for static hosting.
  // The normal TanStack Start/Nitro app remains unchanged.
  // Pages live under /grokcon/. The Android build sets RIDGE_BASE=./ so the
  // same files load inside the app.
  base: process.env.RIDGE_BASE || "/grokcon/",
  plugins: [react(), tailwindcss()],
  resolve: {
    // The static game uses Preact's React compatibility layer to avoid
    // shipping the substantially larger react-dom runtime on mobile.
    // Keep this mapping in the standalone build only: TanStack Start
    // and the normal application build remain on real React 19.
    alias: [
      { find: "react-dom/client", replacement: "preact/compat/client" },
      { find: "react-dom", replacement: "preact/compat" },
      { find: "react/jsx-runtime", replacement: "preact/jsx-runtime" },
      { find: "react/jsx-dev-runtime", replacement: "preact/jsx-dev-runtime" },
      { find: "react", replacement: "preact/compat" },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  build: {
    outDir: "dist-static",
    emptyOutDir: true,
    manifest: true,
    // Three.js changes far less often than the mining rules/UI. Keep the
    // engine in a stable, cacheable chunk instead of retransferring ~800 KB of
    // combined engine + game code whenever gameplay is updated.
    rolldownOptions: {
      input: "static.html",
      output: {
        codeSplitting: {
          groups: [{ name: "three-vendor", test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
});
