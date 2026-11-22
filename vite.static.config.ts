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
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
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
