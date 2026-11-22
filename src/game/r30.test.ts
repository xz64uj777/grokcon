import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, buyVehicle, buyClaim, toggleCrew } from "@/game/sim";
import { X0 } from "@/game/river";

const idle = { throttle: 0, steer: 0, action: false };

function withSeededRandom<T>(seed: number, run: () => T): T {
  const originalRandom = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  try {
    return run();
  } finally {
    Math.random = originalRandom;
  }
}

type DefId = "excavator" | "loader" | "hloader" | "truck" | "heavy" | "skid";

function hireAt(s: ReturnType<typeof freshGame>, id: DefId, x: number, z: number) {
  assert.equal(buyVehicle(s, id), "");
  const v = s.vehicles[s.vehicles.length - 1];
  v.x = x;
  v.z = z;
  v.yaw = 0;
  v.speed = 0;
  v.cargo = 0;
  v.cargoOre = null;
  v.feederPad = null;
  const i = s.vehicles.length - 1;
  if (!v.hired) toggleCrew(s, i);
  v.hired = true;
  v.operator = true;
  return v;
}

function parkStarters(s: ReturnType<typeof freshGame>) {
  for (const v of s.vehicles) {
    v.operator = false;
    v.hired = false;
  }
}

function inBay(v: { status: string }) {
  return /^(In the load bay|In line)/.test(v.status);
}

test("a ready heavy in the load bay is filled before the team dump truck", () => withSeededRandom(30, () => {
  const s = freshGame("R30 eastrim heavy");
  s.cash = 5e6;
  s.watching = true;
  s.washPlant = true;
  s.sluice = true;
  s.preferSluice = false;
  buyClaim(s, 4);
  buyClaim(s, 7);
  s.claims = [1, 4, 7];
  parkStarters(s);
  const faceX = X0 + 74;
  const faceZ = -22;
  const hloader = hireAt(s, "hloader", faceX - 8, faceZ + 10);
  const excavator = hireAt(s, "excavator", faceX - 6, faceZ + 16);
  const heavy = hireAt(s, "heavy", faceX - 18, faceZ + 12);
  const truck = hireAt(s, "truck", faceX - 22, faceZ + 18);
  s.active = 0;
  const dt = 1 / 20;
  let ready = 0;
  for (let i = 0; i < 20 * 40; i++) {
    step(s, idle, dt, true);
    if (inBay(heavy) && inBay(truck)) {
      ready += dt;
      if (ready >= 1) break;
    }
  }
  const parked = `heavy "${heavy.status}" @${(heavy.x - X0).toFixed(0)},${heavy.z.toFixed(0)}; truck "${truck.status}"; excavator "${excavator.status}"; hloader "${hloader.status}"`;
  assert.ok(inBay(heavy) && inBay(truck), `haulers never lined up together: ${parked}`);
  excavator.cargo = 3.2;
  excavator.cargoOre = "copper";
  excavator.cargoPurity = 1;
  const h0 = heavy.cargo;
  const t0 = truck.cargo;
  for (let i = 0; i < 10; i++) step(s, idle, dt, true);
  const note = `heavy ${h0.toFixed(1)}->${heavy.cargo.toFixed(1)}t "${heavy.status}"; truck ${t0.toFixed(1)}->${truck.cargo.toFixed(1)}t "${truck.status}"; excavator ${excavator.cargo.toFixed(1)}t "${excavator.status}"`;
  assert.ok(heavy.cargo > h0 + 1, `waiting heavy was not filled promptly: ${note}`);
  assert.ok(truck.cargo - t0 < 0.5, `digger poured the waiting bucket into the dump truck instead of the heavy: ${note}`);
}));
