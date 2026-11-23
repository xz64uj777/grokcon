#!/usr/bin/env node
/**
 * Reproducible *emulated* mobile-network startup and FPS reporting.
 * This is Chromium + software WebGL, NOT a physical phone benchmark.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const url = "http://127.0.0.1:4174/grokcon/";
const output = "artifacts/game-bench/mobile-network.json";
const server = spawn(process.execPath,
  ["node_modules/vite/bin/vite.js", "preview", "--config", "vite.static.config.ts",
    "--host", "127.0.0.1", "--port", "4174", "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => { serverLog += String(chunk); });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready() {
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw Error("Preview server exited: " + serverLog);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server is starting */ }
    await sleep(250);
  }
  throw Error("Preview server did not start: " + serverLog);
}

let browser;
try {
  await mkdir("artifacts/game-bench", { recursive: true });
  await ready();
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-webgl",
      "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // A fresh, uncached Chromium mobile context and explicit bandwidth/RTT cap.
  // Preview serves assets locally; transfer compression may differ from CDN.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 150,
    downloadThroughput: 200_000, uploadThroughput: 100_000,
    connectionType: "cellular4g",
  });

  const response = await page.goto(url + "?perf=1",
    { waitUntil: "domcontentloaded", timeout: 90_000 });
  if (!response?.ok()) throw Error("Throttled page failed HTTP " + response?.status());
  await page.getByRole("button", { name: "Start", exact: true })
    .waitFor({ timeout: 120_000 });
  const cold = await page.evaluate(() => ({
    titleReadyMs: Math.round(performance.now()),
    resourceEntries: performance.getEntriesByType("resource")
      .filter((r) => /\/assets\/.*\.(?:js|css)$/.test(r.name))
      .map((r) => ({
        file: r.name.split("/").at(-1),
        startedMs: Math.round(r.startTime),
        durationMs: Math.round(r.duration),
        encodedBytes: r.encodedBodySize,
        transferredBytes: r.transferSize,
      })),
  }));
  const panel = page.locator("[data-ridge-perf]");
  await panel.waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Office", exact: true })
    .waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => window.__ridgePerfReport?.()?.frame?.samples >= 30,
    null, { timeout: 30_000 },
  );
  const record = await page.evaluate(() => window.__ridgePerfReport?.());
  if (!record?.playing || record.frame.fps <= 0 || record.frame.samples < 30) {
    throw Error("On-device performance recorder returned an invalid gameplay sample");
  }

  // Verify the same report is available to a player as a local JSON file.
  const downloadEvent = page.waitForEvent("download", { timeout: 15_000 });
  await panel.getByRole("button", { name: "Download FPS report" }).click();
  const download = await downloadEvent;
  if (download.suggestedFilename() !== "ridge-ore-performance.json") {
    throw Error("Unexpected performance report filename");
  }
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  if (exported.app !== "Ridge Ore" || exported.frame.samples < 30) {
    throw Error("Downloaded performance report contents are invalid");
  }
  if (errors.length) throw Error("Browser page errors: " + errors.join("; "));

  const result = {
    environment: "Chromium mobile emulation / SwiftShader (NOT physical phone)",
    throttle: "150ms latency; 200,000 bytes/s download (~1.6 Mbps); no cache",
    note: "Local Vite preview compression may differ from the production CDN. Not an A/B speed claim.",
    cold, frame: record.frame,
    graphics: record.graphics,
    exported: download.suggestedFilename(),
  };
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log("MOBILE NETWORK BENCHMARK", JSON.stringify(result));
  console.log("PASS: throttled cold start, FPS report and downloaded on-device JSON");
  await context.close();
} catch (error) {
  console.error("Mobile network benchmark failed:", error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
