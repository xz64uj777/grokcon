import { test } from "node:test";
import assert from "node:assert/strict";
import { MOUNTAIN_CLAIM, MOUNTAIN_HAUL_FEE, X1, benchAt, coldFactor, switchbackBlocks, switchbackWaypoint, SWITCHBACKS } from "@/game/mountain";
import { areaOf } from "@/game/river";
import { boundsFor, CLAIMS, PADS } from "@/game/catalog";
import { buyClaim, freshGame, groundFactor, haulMachine, haulTarget, currentArea, step } from "@/game/sim";
import { bookWorth, readSaveText } from "@/game/save";

test("mountain is its own area with its own bounds, lease and mill", () => {
  assert.equal(areaOf(X1), "mountain");
  assert.equal(areaOf(1000), "river");
  assert.equal(boundsFor(X1).minX, X1 - 80);
  assert.ok(CLAIMS.some((c) => c.id === MOUNTAIN_CLAIM && c.price === 150000));
  assert.ok(PADS.some((p) => areaOf(p.x) === "mountain"));
});

test("switchback walls each leave one gap, alternating sides", () => {
  assert.equal(switchbackBlocks().length, 6);
  assert.ok(SWITCHBACKS[0].gapX > X1 && SWITCHBACKS[1].gapX < X1);
  const w = switchbackWaypoint(X1 - 40, 50, X1 - 40, -50)!;
  assert.equal(w.x, SWITCHBACKS[0].gapX);
  assert.equal(switchbackWaypoint(X1, 10, X1, 20), null);
  assert.equal(benchAt(50), 0);
  assert.equal(benchAt(-50), 3);
});

test("cold slows machines a bit, snow a bit more", () => {
  assert.ok(coldFactor(0) < 1 && coldFactor(0) > 0.8);
  assert.ok(coldFactor(1) < coldFactor(0) && coldFactor(1) > 0.7);
  const s = freshGame("T");
  s.vehicles[0].x = X1;
  s.vehicles[0].z = 50;
  assert.ok(groundFactor(s, s.vehicles[0]) < 1);
});

test("mountain unlocks only after a valley lease, haul costs more, and it survives a reload", () => {
  const s = freshGame("T");
  s.cash = 1e6;
  s.claims.push(4, 5);
  assert.match(buyClaim(s, MOUNTAIN_CLAIM), /opens once/);
  s.claims.push(6);
  assert.equal(buyClaim(s, MOUNTAIN_CLAIM), "");
  const v = s.vehicles[0];
  v.x = 1000;
  v.z = 40;
  assert.equal(haulTarget(s), "mountain");
  const cash = s.cash;
  assert.equal(haulMachine(s), "");
  assert.equal(currentArea(s), "mountain");
  assert.equal(cash - s.cash, MOUNTAIN_HAUL_FEE);
  for (let i = 0; i < 60; i++) step(s, { throttle: 1, steer: 0, action: false }, 1 / 30, true);
  assert.equal(currentArea(s), "mountain");
  const back = readSaveText(JSON.stringify({ ...s, version: 4 }))!;
  assert.ok(back.claims.includes(MOUNTAIN_CLAIM));
  assert.ok(back.claims.includes(6));
  assert.equal(areaOf(back.vehicles[0].x), "mountain");
  assert.equal(haulTarget(s), "ridge");
});

test("leasing the mountain never lowers the save score", () => {
  const s = freshGame("T");
  s.cash = 400000;
  s.claims.push(4, 5, 7);
  const w = bookWorth(s);
  buyClaim(s, MOUNTAIN_CLAIM);
  assert.ok(bookWorth(s) >= w);
});
