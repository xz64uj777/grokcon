#!/usr/bin/env node
/** Keep the stable Three.js engine cacheable across gameplay-only releases. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = "dist-static";
const files = readdirSync(join(root, "assets")).filter((name) => name.endsWith(".js"));
const chunks = files.map((name) => {
  const source = readFileSync(join(root, "assets", name));
  return { name, bytes: source.length, gzipBytes: gzipSync(source).length };
});
const pick = (prefix) => chunks.filter((c) => c.name.startsWith(prefix + "-"));
const game = pick("mount");
const engine = pick("three-vendor");
const shell = pick("static");

function requireOne(chunks, label) {
  if (chunks.length !== 1) {
    throw new Error(`Expected exactly one ${label} chunk; found ${chunks.length}. Check code splitting.`);
  }
  return chunks[0];
}

const gameChunk = requireOne(game, "game");
const engineChunk = requireOne(engine, "Three.js engine");
requireOne(shell, "static shell");
const manifest = JSON.parse(readFileSync(join(root, ".vite", "manifest.json"), "utf8"));
if (!manifest["static.html"]) throw new Error("Vite's static entry is missing from the manifest");

const totalGzipBytes = chunks.reduce((n, c) => n + c.gzipBytes, 0);
const fmt = (bytes) => (bytes / 1000).toFixed(2) + " kB";
console.log("Static browser JS bundle (gzip):");
for (const chunk of chunks.sort((a, b) => b.gzipBytes - a.gzipBytes)) {
  console.log(`  ${chunk.name}: ${fmt(chunk.gzipBytes)} (${fmt(chunk.bytes)} minified)`);
}
console.log(`  Total: ${fmt(totalGzipBytes)}`);

// Previous build: 225.57 kB game chunk, 312.4 kB combined JS gzip.
// Preserve at least a 50% reduction in *game-only update* download cost.
// Keep total first-install transfer within ~9% of the previous baseline.
if (gameChunk.gzipBytes > 110_000) {
  throw new Error(`Game-specific update chunk regressed to ${fmt(gameChunk.gzipBytes)} (limit 110 kB)`);
}
if (engineChunk.gzipBytes > 170_000) {
  throw new Error(`Three.js engine chunk grew to ${fmt(engineChunk.gzipBytes)} (limit 170 kB)`);
}
if (totalGzipBytes > 340_000) {
  throw new Error(`First-load JavaScript grew to ${fmt(totalGzipBytes)} (limit 340 kB)`);
}
console.log("PASS: stable engine split and game update size budget");
