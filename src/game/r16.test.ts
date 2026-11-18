import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, buyVehicle, buyClaim, toggleCrew } from "@/game/sim";

const idle = { throttle: 0, steer: 0, action: false };

function hireAt(s: ReturnType<typeof freshGame>, id: "loader" | "truck" | "excavator", x: number, z: number) {
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

test("a hired dump truck stays in the load bay while it waits to be filled", () => {
  const s = freshGame("BayWait");
  s.cash = 1e6;
  s.watching = true;
  const pile = s.deposits.find((d) => d.id === "starter")!;
  pile.tons = 40;
  const loader = hireAt(s, "loader", pile.x, pile.z + 4);
  const truck = hireAt(s, "truck", pile.x - 18, pile.z - 6);
  truck.yaw = Math.PI / 2;
  const plant = { x: loader.x, z: loader.z };
  s.active = 0;
  let inBay = false;
  for (let i = 0; i < 30 * 25 && !inBay; i++) {
    step(s, idle, 1 / 30, false);
    loader.x = plant.x;
    loader.z = plant.z;
    loader.speed = 0;
    inBay = truck.status === "In the load bay";
  }
  assert.equal(inBay, true, `never reached the bay: ${truck.status} at ${truck.x.toFixed(0)},${truck.z.toFixed(0)}`);
  const parked = { x: truck.x, z: truck.z };
  // Hold the loader still with an empty bucket so the bed is not filled, and
  // wait longer than the old 30s stall kick.
  loader.cargo = 0;
  loader.cargoOre = null;
  for (let i = 0; i < 30 * 40; i++) {
    step(s, idle, 1 / 30, false);
    loader.x = plant.x;
    loader.z = plant.z;
    loader.speed = 0;
    loader.cargo = 0;
    loader.cargoOre = null;
    assert.notEqual(truck.status, "Backing up", `kicked out of the bay at ${(i / 30).toFixed(1)}s`);
  }
  assert.equal(truck.status, "In the load bay", truck.status);
  assert.ok(Math.hypot(truck.x - parked.x, truck.z - parked.z) < 3, `rolled out of the bay to ${truck.x.toFixed(0)},${truck.z.toFixed(0)}`);
});

test("a hired dump truck stays in the bay when the digger's bucket changes ore", () => {
  const s = freshGame("OreSwap");
  s.cash = 1e6;
  s.watching = true;
  s.sluice = true;
  buyClaim(s, 3);
  const ex = hireAt(s, "excavator", -74, 18);
  const truck = hireAt(s, "truck", -50, 28);
  truck.yaw = Math.PI;
  s.active = 0;
  let inBay = false;
  for (let i = 0; i < 30 * 12 && !inBay; i++) {
    step(s, idle, 1 / 30, false);
    inBay = truck.status === "In the load bay" || truck.status.startsWith("Bed ");
  }
  assert.equal(inBay, true, `never reached the bay: ${truck.status}`);
  const parked = { x: truck.x, z: truck.z };
  // Give the truck a dirt bed and the excavator a gold bucket, the mismatch
  // that used to drop the partner and leave both machines sitting still.
  truck.cargo = 2.4;
  truck.cargoOre = "dirt";
  ex.cargo = 3.2;
  ex.cargoOre = "gold";
  let sawNeed = false;
  let backed = false;
  for (let i = 0; i < 30 * 20; i++) {
    step(s, idle, 1 / 30, false);
    if (truck.status === "Needs a payloader") sawNeed = true;
    if (truck.status === "Backing up") backed = true;
  }
  assert.equal(sawNeed, false, `dropped the excavator and sat still: ${truck.status}`);
  assert.equal(backed, false, `backed out after the ore swap: ${truck.status}`);
  assert.ok(Math.hypot(truck.x - parked.x, truck.z - parked.z) < 6, `wandered to ${truck.x.toFixed(0)},${truck.z.toFixed(0)} ${truck.status}`);
  assert.ok(/load bay|Bed |In line|Hauling|Dumping/i.test(truck.status), truck.status);
});
