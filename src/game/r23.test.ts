import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshGame,
  buyClaim,
  buyVehicle,
  plannedPad,
  teamDestOptions,
  assignCrew,
  setCrewSource,
  setCrewDest,
  crewAssignment,
  toggleCrew,
} from "@/game/sim";
import { X0 } from "@/game/river";

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

function load(v: ReturnType<typeof hireAt>, ore: "gold" | "iron" | "copper" | "dirt" | "silver", x: number, z: number) {
  v.x = x;
  v.z = z;
  v.cargo = 8;
  v.cargoOre = ore;
  v.cargoPurity = 1;
}

test("the team Plant list shows owned plants before the railroad or barge", () => {
  const s = freshGame("R23");
  s.cash = 1e6;
  buyClaim(s, 4);
  s.washPlant = true;
  s.sluice = true;
  const river = teamDestOptions(s, "river").map((d) => d.value);
  assert.deepEqual(river, ["wash", "loadout", "barge"]);
  const ridge = teamDestOptions(s, "ridge").map((d) => d.value);
  assert.deepEqual(ridge, ["crusher", "sluice", "reclaim"]);
  s.washPlant = false;
  assert.deepEqual(teamDestOptions(s, "river").map((d) => d.value), ["loadout", "barge"]);
});

test("auto and team hauls go to an owned plant that pays, and rail only when no plant takes the ore", () => {
  const s = freshGame("R23b");
  s.cash = 1e6;
  s.watching = true;
  s.washPlant = true;
  s.sluice = true;
  s.preferSluice = true;
  buyClaim(s, 4);
  buyClaim(s, 5);
  const truck = hireAt(s, "truck", X0 + 40, -20);
  load(truck, "gold", X0 + 40, -20);
  assert.equal(plannedPad(s, s.vehicles.indexOf(truck)), "wash");
  load(truck, "silver", X0 + 40, -20);
  assert.equal(plannedPad(s, s.vehicles.indexOf(truck)), "wash");
  load(truck, "dirt", X0 + 40, -20);
  assert.equal(plannedPad(s, s.vehicles.indexOf(truck)), "wash");
  load(truck, "iron", X0 + 40, -20);
  assert.equal(plannedPad(s, s.vehicles.indexOf(truck)), "loadout");
  load(truck, "copper", X0 + 40, -20);
  assert.equal(plannedPad(s, s.vehicles.indexOf(truck)), "loadout");

  const ridgeTruck = hireAt(s, "truck", 16, 36);
  load(ridgeTruck, "gold", 16, 36);
  assert.equal(plannedPad(s, s.vehicles.indexOf(ridgeTruck)), "sluice");
  load(ridgeTruck, "iron", 16, 36);
  assert.equal(plannedPad(s, s.vehicles.indexOf(ridgeTruck)), "crusher");
});

test("a team railroad pick does not override a plant that accepts the ore, on any map", () => {
  const s = freshGame("R23c");
  s.cash = 1e6;
  s.watching = true;
  s.washPlant = true;
  s.sluice = true;
  s.preferSluice = true;
  buyClaim(s, 4);
  buyClaim(s, 5);
  const gold = {
    id: "r23-gold",
    kind: "pile" as const,
    ore: "gold" as const,
    tons: 40,
    max: 40,
    x: X0 + 28,
    z: -40,
    regen: 0,
    claim: 5,
    radius: 5,
    sign: "GOLD GRAVEL",
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
  s.deposits.push(gold);
  const loader = hireAt(s, "loader", X0 + 32, -40);
  const t1 = hireAt(s, "truck", X0 + 40, -50);
  for (const v of [loader, t1]) assert.equal(assignCrew(s, s.vehicles.indexOf(v), "2"), "");
  assert.equal(setCrewSource(s, 2, gold.id), "");
  assert.equal(setCrewDest(s, 2, "loadout"), "");
  assert.equal(crewAssignment(s, t1)?.destKind, "wash");
  assert.equal(setCrewDest(s, 2, "barge"), "");
  assert.equal(crewAssignment(s, t1)?.destKind, "wash");

  const iron = { ...gold, id: "r23-iron", ore: "iron" as const, sign: "IRON", x: X0 + 20, z: -30 };
  s.deposits.push(iron);
  const l2 = hireAt(s, "loader", X0 + 22, -30);
  const t2 = hireAt(s, "truck", X0 + 24, -34);
  for (const v of [l2, t2]) assert.equal(assignCrew(s, s.vehicles.indexOf(v), "3"), "");
  assert.equal(setCrewSource(s, 3, iron.id), "");
  assert.equal(crewAssignment(s, t2)?.destKind, "loadout");
});
