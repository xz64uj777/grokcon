import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, buyVehicle, buyClaim, toggleCrew } from "@/game/sim";
import { X0, BRIDGE, otherBank, onBridge } from "@/game/river";

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

type DefId = "excavator" | "hloader" | "truck";

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

test("a heavy loader does not self-haul a too-heavy bucket across the river bridge", () => withSeededRandom(32, () => {
  const s = freshGame("R32 bridge");
  s.cash = 5e6;
  s.watching = true;
  s.washPlant = true;
  s.sluice = true;
  buyClaim(s, 4);
  buyClaim(s, 5);
  buyClaim(s, 6);
  s.claims = [1, 4, 5, 6];
  parkStarters(s);
  // Mid-deck, full silver bucket: the wash plant is on the east bank and looks
  // close enough to self-haul, but the scale will not take this machine loaded.
  const hloader = hireAt(s, "hloader", X0, BRIDGE.z);
  hloader.yaw = -Math.PI / 2;
  hloader.cargo = 14.8;
  hloader.cargoOre = "silver";
  hloader.cargoPurity = 1;
  const truck = hireAt(s, "truck", X0 - 28, 12);
  s.active = 0;
  const dt = 1 / 20;
  let tooHeavy = 0;
  let haulWash = 0;
  let eastWithLoad = 0;
  for (let i = 0; i < 20 * 40; i++) {
    step(s, idle, dt, true);
    if (hloader.status === "Too heavy for the bridge") tooHeavy += dt;
    if (/Hauling to Wash|Dumping at Wash|Wash line/.test(hloader.status)) haulWash += dt;
    if (hloader.cargo > 5 && (hloader.x > X0 + 8 || otherBank(hloader.x, X0 - 20))) eastWithLoad += dt;
  }
  const note = `hloader ${hloader.cargo.toFixed(1)}t "${hloader.status}" @${(hloader.x - X0).toFixed(1)},${hloader.z.toFixed(1)} onBridge=${onBridge(hloader.x, hloader.z, 2)} tooHeavy=${tooHeavy.toFixed(1)}s haulWash=${haulWash.toFixed(1)}s east=${eastWithLoad.toFixed(1)}s; truck ${truck.cargo.toFixed(1)}t "${truck.status}"`;
  assert.equal(haulWash, 0, `heavy loader self-hauled across the bridge to the wash plant: ${note}`);
  assert.ok(eastWithLoad < 0.5, `heavy loader finished the crossing with an overweight bucket: ${note}`);
  assert.ok(tooHeavy < 2, `heavy loader sat on Too heavy for the bridge for ${tooHeavy.toFixed(1)}s: ${note}`);
  assert.ok(!onBridge(hloader.x, hloader.z, 2), `heavy loader was still on the deck: ${note}`);
  assert.ok(hloader.x < X0 - 6, `heavy loader did not leave the deck to the bank it was already on: ${note}`);
  assert.ok(
    truck.cargo > 1 || hloader.cargo > 3,
    `load was lost instead of waiting for or filling the dump truck: ${note}`,
  );
  assert.ok(
    truck.cargo > 1 || /Waiting for|Loaded |Setting up/.test(hloader.status) || /In the load bay|In line|Lining/.test(truck.status),
    `heavy loader did not wait for or load the dump truck: ${note}`,
  );
}));
