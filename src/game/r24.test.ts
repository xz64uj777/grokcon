import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, buyVehicle, buyClaim, toggleCrew } from "@/game/sim";
import { BOUNDS } from "@/game/catalog";

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

function atFence(x: number, z: number) {
  return x < BOUNDS.minX + 14 || x > BOUNDS.maxX - 14 || z < BOUNDS.minZ + 14 || z > BOUNDS.maxZ - 14 || z < -50;
}

test("a dump truck at the ridge fence drives back to its team's loader", () => {
  const s = freshGame("R24");
  s.cash = 1e6;
  s.watching = true;
  buyClaim(s, 2);
  const iron = s.deposits.find((d) => d.id === "iron")!;
  const loader = hireAt(s, "loader", iron.x + 6, iron.z + 4);
  const truck = hireAt(s, "truck", BOUNDS.minX + 3, 14);
  s.active = 0;
  for (let i = 0; i < 30 * 25; i++) step(s, idle, 1 / 30, false);
  assert.equal(atFence(truck.x, truck.z), false, `still at the fence ${truck.x.toFixed(0)},${truck.z.toFixed(0)} ${truck.status}`);
  assert.ok(
    Math.hypot(truck.x - loader.x, truck.z - loader.z) < 36,
    `did not return to the loader: truck ${truck.x.toFixed(0)},${truck.z.toFixed(0)} loader ${loader.x.toFixed(0)},${loader.z.toFixed(0)} ${truck.status}`,
  );
});

test("a dump truck waiting on a south pit face does not park in the fence strip", () => {
  const s = freshGame("R24s");
  s.cash = 1e6;
  s.watching = true;
  buyClaim(s, 4);
  const face = s.deposits.find((d) => d.id === "deep-iron")!;
  face.tons = 80;
  const loader = hireAt(s, "loader", face.x, Math.max(face.z, -46));
  const truck = hireAt(s, "truck", face.x + 10, face.z + 8);
  s.active = 0;
  let fenced = false;
  for (let i = 0; i < 30 * 25; i++) {
    step(s, idle, 1 / 30, false);
    if (atFence(truck.x, truck.z)) fenced = true;
  }
  assert.equal(fenced, false, `truck went to the fence at ${truck.x.toFixed(0)},${truck.z.toFixed(0)} ${truck.status}`);
  assert.ok(
    Math.hypot(truck.x - loader.x, truck.z - loader.z) < 32,
    `parked away from the loader at ${truck.x.toFixed(0)},${truck.z.toFixed(0)} ${truck.status}`,
  );
});
