import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  freshGame,
  step,
  buyVehicle,
  buyClaim,
  toggleCrew,
  assignCrew,
  setCrewSource,
  setCrewDest,
  crewAssignment,
  plannedPad,
} from "@/game/sim";
import { X0 } from "@/game/river";

const idle = { throttle: 0, steer: 0, action: false };

function hireAt(s: ReturnType<typeof freshGame>, id: "loader" | "truck", x: number, z: number) {
  assert.equal(buyVehicle(s, id), "");
  const v = s.vehicles[s.vehicles.length - 1];
  v.x = x;
  v.z = z;
  v.yaw = 0;
  v.speed = 0;
  v.cargo = 0;
  v.cargoOre = null;
  const i = s.vehicles.length - 1;
  if (!v.hired) toggleCrew(s, i);
  v.hired = true;
  v.operator = true;
  return v;
}

function valleyTeam(ore: "gold" | "copper", wash: boolean, dest: string | null) {
  const s = freshGame("R22");
  s.cash = 1e6;
  s.watching = true;
  s.washPlant = wash;
  buyClaim(s, 4);
  buyClaim(s, 5);
  const pile = {
    id: `r22-${ore}-pile`,
    kind: "pile" as const,
    ore,
    tons: 80,
    max: 80,
    x: X0 + 28,
    z: -40,
    regen: 0,
    claim: 5,
    radius: 5,
    sign: ore === "gold" ? "GOLD GRAVEL" : "COPPER",
    purity: 1,
    overburden: 0,
    grade: 1,
    stress: 0,
    bench: 1,
    benchProgress: 0,
    hard: false,
    tested: false,
    lastBlastDay: -1,
  };
  s.deposits.push(pile);
  const loader = hireAt(s, "loader", X0 + 32, -40);
  const t1 = hireAt(s, "truck", X0 + 40, -50);
  const t2 = hireAt(s, "truck", X0 + 44, -54);
  for (const v of [loader, t1, t2]) {
    assert.equal(assignCrew(s, s.vehicles.indexOf(v), "2"), "");
  }
  assert.equal(setCrewSource(s, 2, pile.id), "");
  if (dest) assert.equal(setCrewDest(s, 2, dest), "");
  s.active = 0;
  return { s, loader, t1, t2, pile };
}

function loadTruck(t: ReturnType<typeof hireAt>, ore: "gold" | "copper", x: number, z: number) {
  t.x = x;
  t.z = z;
  t.yaw = 0;
  t.speed = 0;
  t.cargo = 18;
  t.cargoOre = ore;
  t.cargoPurity = 1;
}

function haulOnce(s: ReturnType<typeof freshGame>, t: ReturnType<typeof hireAt>, seconds = 45) {
  const loadout = { x: X0 + 74, z: 30 };
  const wash = { x: X0 + 58, z: 18 };
  let firstDrop: { x: number; z: number } | null = null;
  let worstStuck = 0;
  let still = 0;
  let last = { x: t.x, z: t.z, cargo: t.cargo };
  const path: string[] = [];
  for (let i = 0; i < 30 * seconds; i++) {
    const prevCargo = t.cargo;
    step(s, idle, 1 / 30, false);
    if (!firstDrop && prevCargo > 5 && t.cargo < 1) firstDrop = { x: t.x, z: t.z };
    const nearRail = Math.hypot(t.x - loadout.x, t.z - loadout.z) < 22;
    const moved = Math.hypot(t.x - last.x, t.z - last.z) > 0.5 || Math.abs(t.cargo - last.cargo) > 0.05;
    if (nearRail && t.cargo > 1 && !moved) still += 1;
    else still = 0;
    if (still > worstStuck) worstStuck = still;
    last = { x: t.x, z: t.z, cargo: t.cargo };
    if (i % (30 * 10) === 0) path.push(`${i / 30}s ${t.status} cargo=${t.cargo.toFixed(1)} @${(t.x - X0).toFixed(0)},${t.z.toFixed(0)}`);
  }
  const drop = firstDrop ?? { x: t.x, z: t.z };
  const dWash = Math.hypot(drop.x - wash.x, drop.z - wash.z);
  const dRail = Math.hypot(drop.x - loadout.x, drop.z - loadout.z);
  return {
    cargo: t.cargo,
    droppedAtWash: firstDrop != null && dWash < 16 && dWash <= dRail,
    droppedAtRail: firstDrop != null && dRail < 16 && dRail < dWash,
    worstStuck: worstStuck / 30,
    path: path.join(" | ") + ` drop@${(drop.x - X0).toFixed(0)},${drop.z.toFixed(0)} wash=${dWash.toFixed(1)} rail=${dRail.toFixed(1)}`,
  };
}

test("gold trucks go to the wash plant even if the team plant is still set to the railroad", () => {
  const { s, t1, t2 } = valleyTeam("gold", true, "loadout");
  assert.equal(crewAssignment(s, t1)?.destKind, "wash");
  assert.equal(crewAssignment(s, t2)?.destKind, "wash");
  loadTruck(t1, "gold", X0 + 40, -50);
  const result = haulOnce(s, t1, 50);
  assert.ok(result.droppedAtWash, result.path);
  assert.equal(result.droppedAtRail, false, result.path);
  assert.ok(result.worstStuck < 12, `stuck at rail with cargo for ${result.worstStuck.toFixed(1)}s`);
});

test("gold trucks sell at the railroad when the wash plant is not built", () => {
  const { s, t1 } = valleyTeam("gold", false, null);
  assert.equal(crewAssignment(s, t1)?.destKind, "loadout");
  loadTruck(t1, "gold", X0 + 40, -50);
  const result = haulOnce(s, t1, 50);
  assert.ok(result.droppedAtRail, result.path);
  assert.equal(result.droppedAtWash, false, result.path);
  assert.ok(result.worstStuck < 12, `stuck at rail with cargo for ${result.worstStuck.toFixed(1)}s`);
});

test("copper still sells at the railroad after the wash plant is built", () => {
  const { s, t1 } = valleyTeam("copper", true, null);
  assert.equal(crewAssignment(s, t1)?.destKind, "loadout");
  loadTruck(t1, "copper", X0 + 40, -50);
  const result = haulOnce(s, t1, 50);
  assert.ok(result.droppedAtRail, result.path);
  assert.equal(result.droppedAtWash, false, result.path);
  assert.ok(result.worstStuck < 12, `stuck at rail with cargo for ${result.worstStuck.toFixed(1)}s`);
});

test("Watch cards, On duty board, and crew list wrap machine status instead of cutting it off", () => {
  const src = readFileSync(fileURLToPath(new URL("../components/mine-screen.tsx", import.meta.url)), "utf8");
  const watchStart = src.indexOf("{hud.watching ? (");
  const watchEnd = src.indexOf(") : hud.twoSticks ? (");
  assert.ok(watchStart >= 0 && watchEnd > watchStart);
  const watch = src.slice(watchStart, watchEnd);
  assert.equal(watch.includes("truncate"), false, "Watch cards must not truncate name, status, or cargo");
  assert.ok(watch.includes("[overflow-wrap:anywhere]"));
  assert.ok(watch.includes("min-h-20"));
  assert.match(src, /crewBoard[\s\S]{0,500}overflow-wrap:anywhere/);
  assert.match(src, /overflow-wrap:anywhere\]">\{c\.status\}/);
});
