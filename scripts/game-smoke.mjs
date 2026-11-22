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

  const response = await page.goto(url + "?qa=1", { waitUntil: "domcontentloaded", timeout: 45000 });
  ensure(response?.ok(), `Initial page request failed: ${response?.status()}`);
  await page.getByRole("button", { name: "Start", exact: true }).waitFor({ timeout: 45000 });
  ensure(await page.locator("canvas").count() >= 2, "3D world or HUD canvas not mounted");
  const companyInput = page.getByRole("textbox", { name: "Company" });
  ensure(await companyInput.inputValue() === "Ridge Ore Co.", "Default company name is not shown");
  await companyInput.fill("Ridge QA Mobile");

  const startup = await page.evaluate(() => ({
    readyMs: Math.round(performance.now()),
    preloads: Array.from(document.querySelectorAll('link[rel="modulepreload"]'), (node) => node.getAttribute("href")),
    assets: performance.getEntriesByType("resource")
      .filter((entry) => /\/assets\/(?:mount|three-vendor|static)-.*\.js$/.test(entry.name))
      .map((entry) => ({ name: entry.name.split("/").at(-1), startedMs: Math.round(entry.startTime), type: entry.initiatorType })),
    frames: window.__controlsTest?.renderStats(),
  }));
  ensure(startup.preloads.some((url) => /three-vendor-.*\.js$/.test(url)), "Three.js startup preload missing");
  ensure(startup.preloads.some((url) => /mount-.*\.js$/.test(url)), "Game startup preload missing");
  ensure(startup.frames?.triangles > 0, "No 3D geometry was rendered");
  ensure(startup.frames?.regions?.river === false && startup.frames?.regions?.mountain === false,
    "Locked distant scenery was built during the fresh ridge game startup");
  ensure(startup.frames?.resources > 0,
    "Tracked rendering resource count is missing");
  console.log("COLD START", JSON.stringify(startup));
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Office", exact: true }).waitFor({ timeout: 15000 });
  const first = await page.evaluate(() => JSON.parse(localStorage.getItem("ridge-ore.save") || "null"));
  ensure(first && first.company === "Ridge QA Mobile", "Edited company name was not persisted after start");
  ensure(first.saveRevision > 0, "Save revision was not persisted");

  // Exercise controlled inputs, icon buttons, panel switches and state
  // updates: these must work under both React and Preact compatibility.
  await page.getByRole("button", { name: "Office", exact: true }).click();
  const officePanel = page.locator("aside.office-panel");
  await officePanel.waitFor({ timeout: 15000 });
  for (const tab of ["Ground", "Crew", "Prices", "Machines"]) {
    await officePanel.getByRole("button", { name: tab, exact: true }).click();
  }
  await officePanel.getByRole("button", { name: "Controls: Realistic" }).click();
  await officePanel.getByRole("button", { name: "Controls: Simple" }).waitFor({ timeout: 15000 });
  await officePanel.getByRole("button", { name: "Controls: Simple" }).click();
  await officePanel.getByRole("button", { name: "Controls: Realistic" }).waitFor({ timeout: 15000 });
  await officePanel.getByRole("button", { name: "Close office" }).click();
  ensure(await officePanel.count() === 0, "Office panel did not close");
  ensure(pageErrors.length === 0, `Office interactions caused a page error: ${pageErrors.join("; ")}`);
  console.log("PASS: editable company, office tabs, control modes and icon button events");

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
  // Capturing WebGL in CI's SwiftShader sometimes hangs even after all layout
  // and gameplay assertions succeed. Screenshots are diagnostic, not a gate;
  // the layout and runtime error checks above remain mandatory.
  console.log("PASS: mobile start, saved resume, landscape resize and runtime errors");
  // Prove temporary ore piles free their GPU resources when removed.
  const original = await page.evaluate(() => window.__controlsTest?.renderStats());
  ensure(original && original.geometries > 0, "QA graphics statistics are missing");
  await page.evaluate(() => {
    const state = window.__controlsTest.getState();
    const active = state.vehicles[state.active];
    state.deposits.push({
      id: "gpu-smoke-temporary-pile",
      kind: "pile", ore: "dirt", tons: 8, max: 8,
      x: active.x + 2, z: active.z + 3,
      regen: 0, claim: 1, radius: 6, sign: "PILE", purity: 1,
      overburden: 0, grade: 1, stress: 0, bench: 1,
      benchProgress: 0, hard: false, tested: true, lastBlastDay: -1,
      paidTons: 0,
    });
  });
  await page.waitForFunction(
    (count) => window.__controlsTest.renderStats().geometries > count,
    original.geometries,
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const state = window.__controlsTest.getState();
    state.deposits = state.deposits.filter((d) => d.id !== "gpu-smoke-temporary-pile");
  });
  await page.waitForFunction(
    (count) => window.__controlsTest.renderStats().geometries <= count,
    original.geometries,
    { timeout: 30000 },
  );
  console.log("PASS: temporary ore piles release GPU geometries");

  // Incremental region creation must work without navigating or reloading,
  // and already-owned claims must not modify the player's persisted save.
  await page.evaluate(() => { window.__controlsTest.getState().claims.push(4); });
  await page.waitForFunction(
    () => window.__controlsTest.renderStats().regions.river,
    null, { timeout: 45000 },
  );
  await page.evaluate(() => { window.__controlsTest.getState().claims.push(6); });
  await page.waitForFunction(
    () => window.__controlsTest.renderStats().regions.mountain,
    null, { timeout: 45000 },
  );
  const expanded = await page.evaluate(() => window.__controlsTest.renderStats());
  ensure(expanded.resources > startup.frames.resources,
    "Region unlocks did not allocate their deferred scenery resources");
  console.log("PASS: locked region scenes deferred until unlock",
    JSON.stringify({ initialResources: startup.frames.resources, expandedResources: expanded.resources, initMs: startup.frames.initMs }));

  ensure(pageErrors.length === 0, `Uncaught GPU memory test errors: ${pageErrors.join("; ")}`);
  // Software WebGL is CPU-intensive: close the first 3D world before the retry test.
  await mobile.close();
  page = null;

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
  await failedPage.waitForFunction(
    () => document.querySelectorAll("canvas").length >= 2 &&
      !document.querySelector('[role="alert"]') &&
      Array.from(document.querySelectorAll("button")).some((b) => /^(Start|Continue)$/i.test(b.textContent?.trim() || "")),
    null, { timeout: 60000 },
  );
  console.log("PASS: failed module download displays an error and retry recovers");
  await recovery.close();
} catch (error) {
  console.error("Game browser smoke failed:", error);
  for (const [name, target] of [["mobile", page], ["startup-error", failedPage]]) {
    try {
      if (target && !target.isClosed()) {
        await target.screenshot({ path: `${artifactDir}/failure-${name}.png`, timeout: 5000 });
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
