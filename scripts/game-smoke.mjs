#!/usr/bin/env node
/** Real-browser smoke test for the built GitHub Pages version of Ridge Ore. */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const url = "http://127.0.0.1:4173/grokcon/";
const artifactDir = "artifacts/game-smoke";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "preview", "--config", "vite.static.config.ts",
    "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });

async function ready() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite preview exited: ${serverOutput}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // The preview process is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite preview never became ready: ${serverOutput}`);
}

function ensure(ok, message) {
  if (!ok) throw new Error(message);
}

let browser;
let page;
let failedPage;
try {
  await mkdir(artifactDir, { recursive: true });
  await ready();
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-webgl",
      "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

  // Real mobile layout: initial game launch, save, restart and resume.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
  });
  page = await mobile.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  ensure(response?.ok(), `Initial page request failed: ${response?.status()}`);
  await page.getByRole("button", { name: "Start", exact: true }).waitFor({ timeout: 45000 });
  ensure(await page.locator("canvas").count() >= 2, "3D world or HUD canvas not mounted");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Office", exact: true }).waitFor({ timeout: 15000 });
  const first = await page.evaluate(() => JSON.parse(localStorage.getItem("ridge-ore.save") || "null"));
  ensure(first && first.company === "Ridge Ore Co.", "Starting a game did not persist the company");
  ensure(first.saveRevision > 0, "Save revision was not persisted");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByRole("button", { name: "Continue", exact: true }).waitFor({ timeout: 45000 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Office", exact: true }).waitFor({ timeout: 15000 });
  const resumed = await page.evaluate(() => JSON.parse(localStorage.getItem("ridge-ore.save") || "null"));
  ensure(resumed && resumed.company === first.company, "Company changed after reloading");
  ensure(resumed.saveRevision > first.saveRevision, "Resume did not make a newer save");

  await page.setViewportSize({ width: 844, height: 390 });
  await sleep(250);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  ensure(!overflow, "Landscape game layout has horizontal overflow");
  ensure(pageErrors.length === 0, `Uncaught game errors: ${pageErrors.join("; ")}`);
  await page.screenshot({ path: `${artifactDir}/mobile-landscape.png` });
  console.log("PASS: mobile start, saved resume, landscape resize and runtime errors");

  // A broken network chunk should show a recoverable error instead of hanging forever.
  const recovery = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  failedPage = await recovery.newPage();
  const chunkPattern = "**/assets/mount-*.js";
  await failedPage.route(chunkPattern, (route) => route.abort("failed"));
  await failedPage.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await failedPage.getByRole("alert").getByText("Game could not start").waitFor({ timeout: 30000 });
  await failedPage.unroute(chunkPattern);
  await failedPage.getByRole("button", { name: "Retry loading" }).click();
  await failedPage.getByRole("button", { name: "Start", exact: true }).waitFor({ timeout: 45000 });
  console.log("PASS: failed module download displays an error and retry recovers");
  await recovery.close();
  await mobile.close();
} catch (error) {
  console.error("Game browser smoke failed:", error);
  for (const [name, target] of [["mobile", page], ["startup-error", failedPage]]) {
    try {
      if (target && !target.isClosed()) {
        await target.screenshot({ path: `${artifactDir}/failure-${name}.png` });
      }
    } catch {
      // Preserve the original assertion failure.
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
