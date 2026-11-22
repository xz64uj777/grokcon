#!/usr/bin/env node
/**
 * Preload the game entry and its stable Three.js engine on the first HTML fetch.
 *
 * Vite keeps the game import asynchronous so the React title is quick to parse,
 * but without hints the game and graphics bytes are requested only after React
 * starts mounting. Resolve filenames from the generated manifest to preserve
 * content hashing, /grokcon/ hosting and RIDGE_BASE=./ Android builds.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export function injectCriticalPreloads(html, manifest) {
  const entry = manifest?.["static.html"];
  const game = manifest?.["src/game/mount.ts"];
  const engineId = game?.imports?.find((id) => manifest[id]?.name === "three-vendor");
  const engine = engineId && manifest[engineId];
  if (!entry?.file || !game?.file || !engine?.file ||
      !entry.dynamicImports?.includes("src/game/mount.ts")) {
    throw new Error("Unexpected Vite manifest: game or Three.js entry was not found");
  }

  // Match the compiled script, not a hard-coded hosting path or hash.
  const matches = Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g));
  const script = matches.find((m) => m[1].endsWith(entry.file));
  if (!script || script.index === undefined) throw new Error("Built HTML entry script not found");

  const base = script[1].slice(0, -entry.file.length);
  if (base.startsWith("//") || /:/.test(base) || base.includes("..")) {
    throw new Error("Unsafe built asset base path");
  }
  const urls = [engine.file, game.file].map((file) => {
    if (!file.startsWith("assets/") || file.includes("..")) {
      throw new Error("Unexpected asset path in Vite manifest");
    }
    return base + file;
  });

  const links = urls
    .filter((url) => !html.includes(`rel="modulepreload" crossorigin href="${url}"`))
    .map((url) => `    <link rel="modulepreload" crossorigin href="${url}">`);
  return links.length
    ? html.slice(0, script.index) + links.join("\n") + "\n    " + html.slice(script.index)
    : html;
}

export function prepareStaticEntries(dir = "dist-static") {
  const manifest = JSON.parse(readFileSync(join(dir, ".vite", "manifest.json"), "utf8"));
  for (const name of ["static.html", "index.html"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const html = readFileSync(path, "utf8");
    const next = injectCriticalPreloads(html, manifest);
    writeFileSync(path, next);
    console.log(`PASS: critical game module preloads in ${path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareStaticEntries();
}
