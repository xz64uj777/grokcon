import { test } from "node:test";
import assert from "node:assert/strict";
import { heightAt, gradeAt, climbFactor, PIT_DEPTH } from "@/game/terrain";
import { pileFootprint, pileShape } from "@/game/piles";
import { DRILL_SECONDS, BORE_SECONDS, BLAST_COST } from "@/game/mining";
import { sideTipLimit, tipsOnSlope, ripTick, ops, RIP_SECONDS } from "@/game/ops";
import { X1, SWITCHBACKS } from "@/game/mountain";
import { freshGame, step, dumpsToFeed, homeClaim } from "@/game/sim";
import { sticksToCommand } from "@/game/controls";

test("terrain: pit floor is sunk, benches climb, valley is flat", () => {
  assert.ok(Math.abs(heightAt(-6, -30) + PIT_DEPTH) < 0.05);
  assert.ok(Math.abs(heightAt(0, 44)) < 0.05);
  assert.equal(heightAt(1000, 0), 0);
  const camp = heightAt(X1, 55);
  const summit = heightAt(X1, -50);
  assert.ok(summit - camp > 13, `${summit - camp}`);
  // A gap ramp is gentler than the bench wall step.
  const w = SWITCHBACKS[0];
  const ramp = Math.abs(gradeAt(w.gapX, w.z, 0).along);
  const wall = Math.abs(gradeAt(w.gapX - 40, w.z, 0).along);
  assert.ok(ramp < 0.25 && wall > ramp * 2, `${ramp} ${wall}`);
});

test("climbing is slower; downhill is not capped lower", () => {
  assert.ok(climbFactor(0.2, true) < 0.6);
  assert.equal(climbFactor(-0.2, true), 1);
  assert.ok(climbFactor(-0.2, false) < 1);
});

test("on a grade a coasting pickup rolls back, a hauler or braked machine holds", () => {
  const s = freshGame("T");
  const v = s.vehicles[0];
  const w = SWITCHBACKS[0];
  // Pointing uphill (north, yaw 0) in the middle of the first ramp.
  v.x = w.gapX; v.z = w.z; v.yaw = 0; v.speed = 0;
  const z0 = v.z;
  const coast = () => ({ throttle: 0, steer: 0, action: false, cmd: sticksToCommand(v.defId, { x: 0, y: 0 }, { x: 0, y: 0 }, false) });
  for (let i = 0; i < 60; i++) step(s, coast(), 1 / 30, true);
  assert.ok(v.z > z0 + 0.3, `rolled ${v.z - z0}`);
  // Simple controls brake when the stick is released.
  s.controlMode = "simple";
  v.z = w.z; v.speed = 0;
  for (let i = 0; i < 60; i++) step(s, { throttle: 0, steer: 0, action: false }, 1 / 30, true);
  assert.ok(Math.abs(v.z - w.z) < 0.3);
  s.controlMode = "real";
  v.defId = "truck";
  v.z = w.z; v.speed = 0;
  for (let i = 0; i < 60; i++) step(s, coast(), 1 / 30, true);
  assert.ok(Math.abs(v.z - w.z) < 0.3, `held ${v.z - w.z}`);
});

test("side slopes tip loaded trucks sooner; flat turns never tip", () => {
  assert.ok(sideTipLimit(1) < sideTipLimit(0));
  assert.equal(tipsOnSlope("truck", 0.3, 1, 5), true);
  assert.equal(tipsOnSlope("truck", 0.3, 0, 5), false);
  assert.equal(tipsOnSlope("loader", 0.6, 1, 5), false);
  assert.equal(tipsOnSlope("truck", 0, 1, 15), false);
});

test("piles grow with tonnage and change shape", () => {
  const a = pileShape(3), b = pileShape(30), c = pileShape(200);
  assert.equal(a.kind, "heap");
  assert.equal(b.kind, "cone");
  assert.equal(c.kind, "windrow");
  assert.ok(b.radius > a.radius && b.height > a.height);
  // Volume keeps rising with tons even when the windrow gets lower and longer.
  const vol = (p: ReturnType<typeof pileShape>) => p.radius * p.radius * p.stretch * p.height;
  assert.ok(vol(c) > vol(b) * 4);
});

test("a machine stops in a pile instead of driving through it", () => {
  const s = freshGame("Pile");
  const sample = s.deposits.find((d) => d.kind === "pile");
  assert.ok(sample);
  const pile = { ...sample, id: "block-pile", tons: 40, max: 40, regen: 0, x: 8, z: -28 };
  s.deposits.push(pile);
  const foot = pileFootprint(pile.tons);
  const v = s.vehicles[0];
  s.active = 0;
  v.x = pile.x;
  v.z = pile.z + foot.rz + 6;
  v.yaw = 0;
  v.speed = 10;
  let closest = Infinity;
  for (let i = 0; i < 30 * 4; i++) {
    step(s, { throttle: 1, steer: 0, action: false }, 1 / 30, true);
    closest = Math.min(closest, Math.hypot(v.x - pile.x, (v.z - pile.z) / (foot.rz / foot.rx || 1)));
  }
  assert.ok(closest > foot.rx * 0.5, `drove through the pile, closest ${closest.toFixed(2)} heart ${foot.rx.toFixed(2)}`);
});

test("blast: 12 s of boring then charging, still a flat $750", () => {
  assert.equal(DRILL_SECONDS, 12);
  assert.ok(BORE_SECONDS > 0 && BORE_SECONDS < DRILL_SECONDS);
  assert.equal(BLAST_COST, 750);
});

test("ripper drag: shank down and moving rips a hard face; raised does nothing", () => {
  const s = freshGame("T");
  ops(s).ripper = true;
  const v = s.vehicles[0];
  v.defId = "dozer";
  const hard = s.deposits.find((d) => d.hard)!;
  v.ripper = 0;
  v.speed = 1.5;
  ripTick(s, v, RIP_SECONDS + 1, { id: hard.id, hard: true });
  assert.equal(hard.hard, true);
  v.ripper = 1;
  v.speed = 5;
  for (let i = 0; i < Math.ceil(RIP_SECONDS / 0.5) + 1; i++) ripTick(s, v, 0.5, { id: hard.id, hard: hard.hard });
  assert.equal(hard.hard, false);
  assert.ok(Math.abs(v.speed) <= 2.2);
});

test("haul trucks tip at plant feed piles; other pads still buy straight", () => {
  assert.equal(dumpsToFeed("truck", "wash"), true);
  assert.equal(dumpsToFeed("heavy", "mill"), true);
  assert.equal(dumpsToFeed("truck", "crusher"), false);
  assert.equal(dumpsToFeed("loader", "wash"), false);
  assert.equal(homeClaim("mountain"), 8);
});
