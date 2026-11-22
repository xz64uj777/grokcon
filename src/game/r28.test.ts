import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, buyVehicle, buyClaim, toggleCrew, BAY_YIELD_SECONDS } from "@/game/sim";
import { X0, otherBank } from "@/game/river";
import { DEFS } from "@/game/catalog";

const idle = { throttle: 0, steer: 0, action: false };

type DefId = "excavator" | "loader" | "hloader" | "truck" | "heavy" | "skid" | "dozer";

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

function valleyBase() {
  const s = freshGame("R28");
  s.cash = 5e6;
  s.watching = true;
  s.washPlant = true;
  s.sluice = true;
  buyClaim(s, 4);
  buyClaim(s, 5);
  buyClaim(s, 6);
  s.claims = [1, 4, 5, 6];
  return s;
}

test("an empty heavy haul yields the load bay when the loader is not about to fill it", () => {
  const s = valleyBase();
  buyClaim(s, 7);
  s.claims = [1, 4, 5, 6, 7];
  s.preferSluice = false;
  parkStarters(s);
  const hloader = hireAt(s, "hloader", X0 + 40, 46);
  const excavator = hireAt(s, "excavator", X0 + 48, 50);
  const heavy = hireAt(s, "heavy", X0 + 56, 46);
  const truck = hireAt(s, "truck", X0 + 62, 50);
  s.active = 0;
  let heavyLoaded = 0;
  let truckLoaded = 0;
  let truckInBay = false;
  let emptyHeavyBlocking = 0;
  const dt = 1 / 20;
  for (let i = 0; i < 20 * 90; i++) {
    const hCargo = heavy.cargo;
    const tCargo = truck.cargo;
    step(s, idle, dt, true);
    if (hCargo < 0.2 && heavy.cargo > 1) heavyLoaded += 1;
    if (tCargo < 0.2 && truck.cargo > 1) truckLoaded += 1;
    if (truck.status === "In the load bay" || truck.cargo > 1) truckInBay = true;
    if (heavy.status === "In the load bay" && heavy.cargo < 0.4 && truck.status.startsWith("In line")) emptyHeavyBlocking += dt;
  }
  const note = [hloader, excavator, heavy, truck].map((v) => `${v.defId} ${v.cargo.toFixed(1)}t "${v.status}"`).join(" | ");
  assert.ok(heavyLoaded + truckLoaded >= 1, `nobody got loaded at the east rim: ${note}`);
  assert.ok(
    emptyHeavyBlocking < 60,
    `empty heavy blocked the truck for ${emptyHeavyBlocking.toFixed(0)}s (yield is ${BAY_YIELD_SECONDS}s): ${note}`,
  );
  assert.ok(truckInBay || truckLoaded > 0 || heavyLoaded > 0, `truck never got a turn: ${note}`);
});

test("a river heavy haul gets a loader on its bank instead of sitting on Needs a payloader", () => {
  const s = valleyBase();
  parkStarters(s);
  const excavator = hireAt(s, "excavator", X0 + 40, 46);
  const loader = hireAt(s, "loader", X0 + 48, 50);
  const truckA = hireAt(s, "truck", X0 + 56, 46);
  const truckB = hireAt(s, "truck", X0 + 62, 50);
  const heavy = hireAt(s, "heavy", X0 + 34, 52);
  const skid = hireAt(s, "skid", X0 + 44, 56);
  s.active = 0;
  let heavyMax = 0;
  let sameBank = false;
  let needSeconds = 0;
  const dt = 1 / 20;
  for (let i = 0; i < 20 * 120; i++) {
    step(s, idle, dt, true);
    heavyMax = Math.max(heavyMax, heavy.cargo);
    if (heavy.status === "Needs a payloader") needSeconds += dt;
    const digger = [excavator, loader].find((d) => !otherBank(d.x, heavy.x));
    if (digger && (digger.cargo > 0.2 || /Waiting for|Scooping|Working|Setting up/.test(digger.status))) sameBank = true;
  }
  const note = `heavy ${heavy.cargo.toFixed(1)}t "${heavy.status}" (max ${heavyMax.toFixed(1)}) need=${needSeconds.toFixed(0)}s; loader ${loader.status} @${(loader.x - X0).toFixed(0)}; excavator ${excavator.status} @${(excavator.x - X0).toFixed(0)}; trucks ${truckA.status} / ${truckB.status}; skid ${skid.status}`;
  assert.ok(heavyMax > 1 || sameBank, `heavy never got a loader on its bank: ${note}`);
  assert.ok(needSeconds < 90, `heavy sat on Needs a payloader for ${needSeconds.toFixed(0)}s: ${note}`);
});

test("a heavy loader at the east rim works the face instead of looking for a pile", () => {
  const s = valleyBase();
  buyClaim(s, 7);
  s.claims = [1, 4, 5, 6, 7];
  s.preferSluice = false;
  parkStarters(s);
  const hloader = hireAt(s, "hloader", X0 + 40, 46);
  const excavator = hireAt(s, "excavator", X0 + 48, 50);
  hireAt(s, "heavy", X0 + 56, 46);
  hireAt(s, "truck", X0 + 62, 50);
  s.active = 0;
  let scooped = 0;
  let worked = 0;
  let looking = 0;
  const dt = 1 / 20;
  for (let i = 0; i < 20 * 90; i++) {
    const before = hloader.cargo;
    step(s, idle, dt, true);
    if (hloader.cargo > before + 0.05) scooped += 1;
    if (/^(Working|Scooping|Heading to) East Rim/.test(hloader.status) || /Loaded /.test(hloader.status)) worked += 1;
    if (/Looking for a pile|Needs a pile/.test(hloader.status)) looking += dt;
  }
  const note = `hloader ${hloader.cargo.toFixed(1)}t "${hloader.status}" scooped=${scooped} worked=${worked}s looking=${looking.toFixed(0)}s; excavator ${excavator.status}`;
  assert.ok(scooped > 0 || worked > 20, `heavy loader never worked the east rim: ${note}`);
  assert.ok(looking < 45, `heavy loader spent ${looking.toFixed(0)}s looking for a pile: ${note}`);
});

test("the one-truck river crew still hauls to the wash plant", () => {
  const s = valleyBase();
  parkStarters(s);
  const machines = [
    hireAt(s, "excavator", X0 + 40, 46),
    hireAt(s, "hloader", X0 + 48, 50),
    hireAt(s, "truck", X0 + 56, 46),
  ];
  s.active = 0;
  const dt = 1 / 20;
  let dumps = 0;
  const prev = new Map<string, number>();
  const cash0 = s.cash;
  for (let i = 0; i < 20 * 150; i++) {
    step(s, idle, dt, true);
    const truck = machines[2]!;
    const pc = prev.get(truck.uid) ?? 0;
    if (DEFS.truck.receives && pc > 1 && truck.cargo < 0.2) dumps += 1;
    prev.set(truck.uid, truck.cargo);
  }
  const truck = machines[2]!;
  const note = `${dumps} dumps, +$${Math.round(s.cash - cash0)}; ${machines.map((v) => `${v.defId} ${v.cargo.toFixed(1)}t "${v.status}"`).join(" | ")}`;
  assert.ok(dumps >= 2 || truck.cargo > 4, `one-truck river crew stalled: ${note}`);
});
