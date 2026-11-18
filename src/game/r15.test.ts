import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, buyVehicle, buyClaim, toggleCrew, faceOf, buildHud } from "@/game/sim";
import { X0 } from "@/game/river";
import { crewBoard, crewBoardLine } from "@/game/crew-help";

const idle = { throttle: 0, steer: 0, action: false };

function hireAt(s: ReturnType<typeof freshGame>, id: "excavator" | "loader" | "hloader" | "truck", x: number, z: number) {
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

test("the gold gravel face stays on the open creek side as it is mined", () => {
  const s = freshGame("GoldFace");
  const gold = s.deposits.find((d) => d.id === "gold")!;
  gold.tons = gold.max;
  assert.ok(faceOf(gold).x > -80);
  gold.tons = 1;
  const dug = faceOf(gold);
  assert.ok(dug.x >= -74, `dug gold face walked west to ${dug.x.toFixed(1)}`);
  assert.ok(dug.z >= 16, `dug gold face walked south to ${dug.z.toFixed(1)}`);
});

test("a crew excavator at gold gravel stays out of the west corner", () => {
  const s = freshGame("GoldCorner");
  s.cash = 1e6;
  s.watching = true;
  s.sluice = true;
  buyClaim(s, 3);
  const gold = s.deposits.find((d) => d.id === "gold")!;
  gold.tons = 20;
  const ex = hireAt(s, "excavator", -74, 18);
  hireAt(s, "loader", -70, 22);
  hireAt(s, "truck", -64, 24);
  s.active = 0;
  let west = false;
  let corner = false;
  for (let i = 0; i < 30 * 40; i++) {
    step(s, idle, 1 / 30, false);
    if (ex.x < -80) west = true;
    if (ex.x > -55 && ex.x < -25 && ex.z > 4.5 && ex.z < 12) corner = true;
    if (ex.x < -52 && ex.z < 12) corner = true;
  }
  assert.equal(west, false, `excavator walked into the west pocket at ${ex.x.toFixed(1)},${ex.z.toFixed(1)}`);
  assert.equal(corner, false, `excavator entered the southwest wall corner at ${ex.x.toFixed(1)},${ex.z.toFixed(1)}`);
});

test("the valley gold bar face stays clear of the south truck lineup", () => {
  const s = freshGame("BarFace");
  const bar = s.deposits.find((d) => d.id === "bar-gold")!;
  bar.tons = 1;
  assert.ok(faceOf(bar).z >= -44, `dug gold bar walked south to ${faceOf(bar).z.toFixed(1)}`);
});

test("a valley excavator at the gold bar does not sit heading in place", () => {
  const s = freshGame("ValleyJam");
  s.cash = 1e6;
  s.watching = true;
  s.washPlant = true;
  buyClaim(s, 4);
  buyClaim(s, 5);
  buyClaim(s, 6);
  const bar = s.deposits.find((d) => d.id === "bar-gold")!;
  bar.tons = 40;
  const ex = hireAt(s, "excavator", X0 + 22, -44);
  hireAt(s, "loader", X0 + 32, -46);
  hireAt(s, "truck", X0 + 36, -54);
  hireAt(s, "truck", X0 + 40, -58);
  s.active = 0;
  let streak = 0;
  let worst = 0;
  for (let i = 0; i < 30 * 45; i++) {
    step(s, idle, 1 / 30, false);
    const near = Math.hypot(ex.x - (X0 + 22), ex.z + 46) < 20;
    if (near && /^Heading/.test(ex.status) && Math.abs(ex.speed) < 0.35) streak++;
    else {
      if (streak > worst) worst = streak;
      streak = 0;
    }
  }
  if (streak > worst) worst = streak;
  assert.ok(worst < 30 * 12, `excavator sat heading for ${(worst / 30).toFixed(1)}s at ${((ex.x - X0).toFixed(0))},${ex.z.toFixed(0)} "${ex.status}"`);
  assert.ok(ex.z > -58, `excavator was pushed south to z=${ex.z.toFixed(1)}`);
});

test("a hired heavy loader digs a river gravel bar when no pile is left, and a dump truck loads", () => {
  const s = freshGame("BarCrew");
  s.cash = 1e6;
  s.watching = true;
  s.washPlant = true;
  buyClaim(s, 4);
  buyClaim(s, 5);
  // Clear loose piles so the loader has to dig the bar itself.
  for (const d of s.deposits) {
    if (d.kind === "pile" && d.x > 500) d.tons = 0;
  }
  const loader = hireAt(s, "hloader", X0 + 28, -46);
  const truck = hireAt(s, "truck", X0 + 40, -50);
  s.active = 0;
  const cash0 = s.cash;
  let scooped = 0;
  for (let i = 0; i < 30 * 90; i++) {
    step(s, idle, 1 / 30, false);
    if (loader.cargo > 1) scooped = Math.max(scooped, loader.cargo);
    if (truck.cargo > 1 || s.cash > cash0 + 50) scooped = Math.max(scooped, truck.cargo, 2);
  }
  assert.notEqual(loader.status, "Needs a pile (dozer, skid or blast)");
  assert.ok(scooped > 1, `heavy loader + truck never moved gravel, loader ${loader.cargo.toFixed(1)}t "${loader.status}", truck ${truck.cargo.toFixed(1)}t "${truck.status}"`);
});

test("the crew board lists what each hired machine is doing and skips parked ones", () => {
  const s = freshGame("Board");
  s.cash = 1e6;
  s.watching = true;
  const loader = hireAt(s, "loader", -8, 44);
  loader.status = "Scooping Gold gravel";
  const parked = hireAt(s, "truck", 12, 42);
  parked.operator = false;
  parked.status = "";
  const hud = buildHud(s, 0);
  const lines = crewBoard(hud.crew, "ridge").map((row) => row.line);
  assert.ok(lines.some((line) => /Payloader|Loader/i.test(line) && /Scooping Gold gravel/.test(line)));
  assert.equal(lines.some((line) => /Dump truck/i.test(line)), false);
  assert.equal(crewBoardLine({ name: "Dump truck", status: "Parked", cargo: "", where: "", hired: true, operator: false }), "");
});
