import { test } from "node:test";
import assert from "node:assert/strict";
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
  buildHud,
  sellVehicle,
} from "@/game/sim";
import { loadingZone } from "@/game/sim/bay";
import { readSaveText } from "@/game/save";

const idle = { throttle: 0, steer: 0, action: false };

function hireAt(s: ReturnType<typeof freshGame>, id: "loader" | "truck" | "hloader" | "excavator" | "skid" | "dozer", x: number, z: number) {
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

function loosePile(s: ReturnType<typeof freshGame>, ore: "dirt" | "iron" | "gold" | "copper", tons: number, x: number, z: number, claim: number) {
  s.deposits.push({
    id: `r19-${ore}-${s.deposits.length}`,
    kind: "pile",
    ore,
    tons,
    max: tons,
    x,
    z,
    regen: 0,
    claim,
    radius: 5,
    sign: "PILE",
    purity: 1,
    overburden: 0,
    grade: 1,
    stress: 0,
    bench: 1,
    benchProgress: 0,
    hard: false,
    tested: false,
    lastBlastDay: -1,
  });
  return s.deposits[s.deposits.length - 1];
}

function setupRidge() {
  const s = freshGame("R19");
  s.cash = 1e6;
  s.watching = true;
  s.sluice = true;
  s.preferSluice = true;
  buyClaim(s, 2);
  buyClaim(s, 3);
  const starter = s.deposits.find((d) => d.id === "starter");
  if (starter) {
    starter.tons = 0;
    starter.regen = 0;
  }
  return s;
}

test("new games default every machine to Auto and have no teams", () => {
  const s = freshGame("R19");
  assert.deepEqual(s.crews, []);
  for (const v of s.vehicles) assert.equal(v.crewId, null);
  const hud = buildHud(s, true);
  assert.equal(hud.teams.length, 0);
  for (const c of hud.crew) {
    if (!c.crewOptions.length) continue;
    assert.equal(c.crewValue, "auto");
    assert.ok(c.crewOptions.some((o) => o.value === "auto"));
    assert.ok(c.crewOptions.some((o) => o.value === "new"));
  }
});

test("assigning a loader and two trucks to a new team and a pile is saved on the HUD", () => {
  const s = setupRidge();
  const dirt = loosePile(s, "dirt", 24, -16, 18, 1);
  loosePile(s, "gold", 24, 20, 10, 3);
  const loader = hireAt(s, "loader", -14, 22);
  const t1 = hireAt(s, "truck", 8, 28);
  const t2 = hireAt(s, "truck", 10, 30);
  const autoLoader = hireAt(s, "loader", 22, 12);
  const li = s.vehicles.indexOf(loader);
  const i1 = s.vehicles.indexOf(t1);
  const i2 = s.vehicles.indexOf(t2);
  assert.equal(assignCrew(s, li, "new"), "");
  assert.equal(loader.crewId, 1);
  assert.equal(assignCrew(s, i1, "1"), "");
  assert.equal(assignCrew(s, i2, "1"), "");
  assert.equal(t1.crewId, 1);
  assert.equal(t2.crewId, 1);
  assert.equal(autoLoader.crewId, null);
  assert.equal(setCrewSource(s, 1, dirt.id), "");
  assert.equal(setCrewDest(s, 1, "sluice"), "");
  const job = crewAssignment(s, loader);
  assert.equal(job?.team, 1);
  assert.equal(job?.sourceId, dirt.id);
  assert.equal(job?.destKind, "sluice");
  assert.equal(crewAssignment(s, t1)?.team, 1);
  assert.equal(crewAssignment(s, t2)?.sourceId, dirt.id);
  assert.notEqual(crewAssignment(s, autoLoader)?.sourceId, dirt.id);
  const hud = buildHud(s, true);
  const team = hud.teams.find((t) => t.id === 1);
  assert.ok(team);
  assert.equal(team?.sourceValue, dirt.id);
  assert.equal(team?.destValue, "sluice");
  assert.ok(team?.members.includes("Payloader") || team?.members.toLowerCase().includes("loader"));
  const card = hud.crew.find((c) => c.index === li);
  assert.equal(card?.crewValue, "1");
});

test("a chosen pile that disappears keeps the team together on a new job", () => {
  const s = setupRidge();
  const dirt = loosePile(s, "dirt", 24, -16, 18, 1);
  const gold = loosePile(s, "gold", 24, 20, 10, 3);
  const loader = hireAt(s, "loader", -14, 22);
  const t1 = hireAt(s, "truck", 8, 28);
  const t2 = hireAt(s, "truck", 10, 30);
  assignCrew(s, s.vehicles.indexOf(loader), "new");
  assignCrew(s, s.vehicles.indexOf(t1), "1");
  assignCrew(s, s.vehicles.indexOf(t2), "1");
  setCrewSource(s, 1, dirt.id);
  assert.equal(crewAssignment(s, loader)?.sourceId, dirt.id);
  dirt.tons = 0;
  step(s, idle, 1, false);
  const job = crewAssignment(s, loader);
  assert.equal(loader.crewId, 1);
  assert.equal(t1.crewId, 1);
  assert.equal(t2.crewId, 1);
  assert.equal(job?.team, 1);
  assert.equal(job?.sourceId, gold.id);
  assert.equal(crewAssignment(s, t1)?.sourceId, gold.id);
  assert.equal(crewAssignment(s, t2)?.team, 1);
});

test("old saves without teams load on Auto", () => {
  const s = setupRidge();
  hireAt(s, "loader", -14, 22);
  const raw = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  delete raw.crews;
  for (const v of raw.vehicles as Record<string, unknown>[]) delete v.crewId;
  const loaded = readSaveText(JSON.stringify(raw));
  assert.ok(loaded);
  assert.deepEqual(loaded.crews, []);
  for (const v of loaded.vehicles) assert.equal(v.crewId, null);
});

test("manual crew membership and targets survive a reload", () => {
  const s = setupRidge();
  const dirt = loosePile(s, "dirt", 24, -16, 18, 1);
  const loader = hireAt(s, "loader", -14, 22);
  const truck = hireAt(s, "truck", 8, 28);
  assignCrew(s, s.vehicles.indexOf(loader), "new");
  assignCrew(s, s.vehicles.indexOf(truck), "1");
  setCrewSource(s, 1, dirt.id);
  setCrewDest(s, 1, "crusher");
  const loaded = readSaveText(JSON.stringify(s));
  assert.ok(loaded);
  const backLoader = loaded.vehicles.find((v) => v.uid === loader.uid);
  const backTruck = loaded.vehicles.find((v) => v.uid === truck.uid);
  assert.equal(backLoader?.crewId, 1);
  assert.equal(backTruck?.crewId, 1);
  assert.equal(loaded.crews.length, 1);
  assert.equal(loaded.crews[0].id, 1);
  assert.equal(loaded.crews[0].sourceId, dirt.id);
  assert.equal(loaded.crews[0].destKind, "crusher");
});

test("a dozer cannot join a haul crew, and selling the last member drops an empty team", () => {
  const s = setupRidge();
  const loader = hireAt(s, "loader", -14, 22);
  const dozer = hireAt(s, "dozer", 0, 20);
  assert.match(assignCrew(s, s.vehicles.indexOf(dozer), "new"), /does not join/);
  assert.equal(dozer.crewId, null);
  assert.equal(assignCrew(s, s.vehicles.indexOf(loader), "new"), "");
  assert.equal(s.crews.some((c) => c.id === 1), true);
  assert.equal(sellVehicle(s, s.vehicles.indexOf(loader)), "");
  assert.equal(s.crews.some((c) => c.id === 1), false);
});

test("a second New team gets the next free number", () => {
  const s = setupRidge();
  const a = hireAt(s, "loader", -14, 22);
  const b = hireAt(s, "loader", 10, 22);
  assert.equal(assignCrew(s, s.vehicles.indexOf(a), "new"), "");
  assert.equal(assignCrew(s, s.vehicles.indexOf(b), "new"), "");
  assert.equal(a.crewId, 1);
  assert.equal(b.crewId, 2);
});

test("changing the selected source sends the loading bay to Gold Creek even while the face replenishes", () => {
  const s = freshGame("Pinned Gold Creek");
  s.cash = 1_000_000;
  s.watching = true;
  s.claims = [1, 3];
  const loader = hireAt(s, "loader", -12, 22);
  const truck = hireAt(s, "truck", 10, 32);
  assert.equal(assignCrew(s, s.vehicles.indexOf(loader), "new"), "");
  assert.equal(assignCrew(s, s.vehicles.indexOf(truck), "1"), "");
  assert.equal(setCrewSource(s, 1, "starter"), "");
  assert.equal(loadingZone(s, loader).sourceId, "starter");

  s.deposits.find((d) => d.id === "gold")!.tons = 0;
  assert.equal(setCrewSource(s, 1, "gold"), "");
  assert.equal(crewAssignment(s, truck)?.sourceId, "gold");
  assert.equal(loadingZone(s, loader).sourceId, "gold");
});
