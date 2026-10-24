import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // This entry is a self-contained client-side build for static hosting.
  // The normal TanStack Start/Nitro app remains unchanged.
  base: "/grokcon/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist-static",
    emptyOutDir: true,
    rollupOptions: {
      input: "static.html",
    },
  },
});
