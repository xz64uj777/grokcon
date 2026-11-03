import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, opsAction, lotButtons, buildHud } from "@/game/sim";
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
