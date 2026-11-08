import { test } from "node:test";
import assert from "node:assert/strict";
import { ROAD_CLEAR_BONUS, buyVehicle, ensureLowboy, freshGame, step, opsAction, lotButtons, buildHud, spawnRockslide, toggleCrew } from "@/game/sim";
import { saveGame, currentSaveText, readSaveText } from "@/game/save";
import * as C from "@/game/career";
import { ops, saleMult } from "@/game/ops";

const idle = { throttle: 0, steer: 0, action: false };

test("seasons cycle summer, rain, winter and label is short", () => {
  assert.equal(C.seasonOf(0), "summer");
  assert.equal(C.seasonOf(3), "rain");
  assert.equal(C.seasonOf(6), "winter");
  assert.equal(C.seasonOf(9), "summer");
  assert.ok(C.seasonLabel(4).length <= 10);
});

test("winter cuts wash pay, summer does not", () => {
  const s = freshGame("T");
  s.market.day = 0;
  const sum = saleMult(s, "gold", "wash");
  s.market.day = 6;
  assert.ok(saleMult(s, "gold", "wash") < sum * 0.7);
  assert.equal(saleMult(s, "iron", "crusher"), saleMult({ ...s, market: { ...s.market, day: 0 } }, "iron", "crusher"));
});

test("wear slows, burns more and can break; overhaul fixes and saves", () => {
  assert.ok(C.wearSpeed(1) < 0.7 && C.wearSpeed(0.2) === 1);
  assert.ok(C.wearFuel(1) > 1.5);
  assert.equal(C.breakChance(0.4), 0);
  assert.ok(C.breakChance(1) > 0);
  assert.ok(C.wearRate(true, true) > C.wearRate(false, true) * 2);
  const s = freshGame("T");
  const v = s.vehicles[s.active];
  ops(s).wear[v.uid] = 0.8;
  ops(s).broke.push(v.uid);
  saveGame(s);
  const back = readSaveText(currentSaveText()!)!;
  assert.equal(ops(back).wear[v.uid], 0.8);
  assert.ok(ops(back).broke.includes(v.uid));
  s.cash = 1e6;
  assert.match(opsAction(s, "overhaul"), /overhaul/i);
  assert.equal(ops(s).wear[v.uid], 0);
  assert.equal(ops(s).broke.length, 0);
});

test("broken machine stays put", () => {
  const s = freshGame("T");
  const v = s.vehicles[s.active];
  ops(s).broke.push(v.uid);
  const x = v.x, z = v.z;
  for (let i = 0; i < 60; i++) step(s, { ...idle, throttle: 1 }, 1 / 30, true);
  assert.ok(Math.hypot(v.x - x, v.z - z) < 0.01);
});

test("story pays out in order", () => {
  const s = freshGame("T");
  s.lifetime = 1;
  const c0 = s.cash;
  step(s, idle, 1 / 30, true);
  assert.equal(ops(s).story, 1);
  assert.equal(s.cash - c0, C.STORY[0].pay);
  assert.ok(buildHud(s, false).objective.length > 0);
});

test("used lot sells worn machines cheap and takes trade-ins", () => {
  const s = freshGame("T");
  s.cash = 1e6;
  s.tutorial.bought = true;
  const btns = lotButtons(s);
  const buy = btns.find((b) => b.id.startsWith("lot:"))!;
  assert.ok(buy);
  const n = s.vehicles.length;
  assert.equal(opsAction(s, buy.id), "");
  assert.equal(s.vehicles.length, n + 1);
  assert.ok(ops(s).wear[s.vehicles[n].uid] >= 0.45);
  assert.ok(!lotButtons(s).some((b) => b.id === buy.id));
  for (const it of C.lotFor(1, 2, () => 100000)) assert.ok(it.price < 70000);
  assert.ok(C.tradeValue(1000, 0.9) < C.tradeValue(1000, 0.1));
});

test("hired lowboy packs two machines assigned to the same destination onto its 3-spot deck", () => {
  const s = freshGame("Pack");
  s.cash = 200000;
  s.claims.push(4, 5, 6, 8);
  ensureLowboy(s);
  buyVehicle(s, "skid");
  const skid = s.vehicles[s.vehicles.length - 1];
  buyVehicle(s, "dozer");
  const dozer = s.vehicles[s.vehicles.length - 1];
  const rig = s.vehicles.find((v) => v.defId === "lowboy")!;
  skid.x = -8; skid.z = 44; skid.workClaim = 8;
  dozer.x = -5; dozer.z = 44; dozer.workClaim = 8;
  rig.x = -7; rig.z = 44; rig.workFace = "map:mountain";
  s.watching = true;
  toggleCrew(s, s.vehicles.indexOf(rig));
  for (let i = 0; i < 60; i++) step(s, idle, 1 / 30, false);
  assert.ok(s.deck.includes(skid.uid) && s.deck.includes(dozer.uid), `deck=${JSON.stringify(s.deck)}`);
  // Machines strapped on the deck do not burn fuel or tire tread while carried.
  const skidTread = ops(s).tread[skid.uid] ?? 1;
  for (let i = 0; i < 60; i++) step(s, idle, 1 / 30, false);
  assert.equal(ops(s).tread[skid.uid] ?? 1, skidTread);
});

test("mountain switchback rockslide slows trucks and pays a bonus when cleared", () => {
  const s = freshGame("Slide");
  s.cash = 100000;
  s.claims.push(4, 5, 6, 8);
  spawnRockslide(s, 0);
  const slide = s.deposits.find((d) => d.id === "slide-gap")!;
  assert.ok(slide && slide.tons >= 16);
  buyVehicle(s, "dozer");
  const dozer = s.vehicles[s.vehicles.length - 1];
  s.active = s.vehicles.length - 1;
  dozer.x = slide.x; dozer.z = slide.z + 3; dozer.yaw = 0;
  slide.tons = 0.25;
  const c0 = s.cash;
  for (let i = 0; i < 30; i++) step(s, { throttle: 0.3, steer: 0, action: true }, 1 / 30, true);
  assert.ok(!s.deposits.some((d) => d.id === "slide-gap"));
  assert.ok(s.cash >= c0 + ROAD_CLEAR_BONUS);
});

test("an idle dozer heads for a rockslide and a pinned excavator stays on the face", () => {
  const s = freshGame("Road");
  s.cash = 1e6;
  s.claims.push(4, 5, 6, 8);
  s.watching = true;
  spawnRockslide(s, 2);
  const slide = s.deposits.find((d) => d.id === "slide-gap")!;
  buyVehicle(s, "dozer");
  const dozer = s.vehicles[s.vehicles.length - 1];
  dozer.x = slide.x;
  dozer.z = slide.z + 24;
  toggleCrew(s, s.vehicles.indexOf(dozer));
  buyVehicle(s, "excavator");
  const ex = s.vehicles[s.vehicles.length - 1];
  const face = s.deposits.find((d) => d.id === "summit-gold")!;
  ex.x = face.x;
  ex.z = face.z + 6;
  ex.workFace = "summit-gold";
  toggleCrew(s, s.vehicles.indexOf(ex));
  step(s, idle, 1 / 30, false);
  assert.match(dozer.status, /rockslide/);
  assert.doesNotMatch(ex.status, /rockslide/);
});

test("downhill brake heat builds on a steep grade and cools at the pass summit pull-out", () => {
  const s = freshGame("Brakes");
  s.cash = 100000;
  buyVehicle(s, "truck");
  const t = s.vehicles[s.vehicles.length - 1];
  s.active = s.vehicles.length - 1;
  // Steep downhill on the first mountain switchback ramp (z = 30, gapX = 2062, heading south yaw = Math.PI).
  t.x = 2062; t.z = 30; t.yaw = Math.PI; t.cargo = 12; t.cargoOre = "gold"; t.speed = 6;
  for (let i = 0; i < 60; i++) {
    t.x = 2062; t.z = 30; t.yaw = Math.PI; t.speed = 6;
    step(s, { throttle: 0.4, steer: 0, action: false }, 1 / 30, true);
  }
  const hot = ops(s).brakeHeat[t.uid] ?? 0;
  assert.ok(hot > 0.2, `expected brake heat > 0.2, got ${hot}`);
  // Park the lowboy in the Pass Summit pull-out (x = 512, z = 112) to cool brakes quickly.
  s.claims.push(4);
  ensureLowboy(s);
  const rig = s.vehicles.find((v) => v.defId === "lowboy")!;
  s.active = s.vehicles.indexOf(rig);
  ops(s).brakeHeat[rig.uid] = 0.5;
  rig.x = 512; rig.z = 104; rig.speed = 0;
  for (let i = 0; i < 30; i++) step(s, idle, 1 / 30, true);
  assert.ok((ops(s).brakeHeat[rig.uid] ?? 0) < 0.2);
  assert.ok(s.log.some((m) => m.includes("summit pull-out")));
});
