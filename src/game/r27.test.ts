import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshGame,
  step,
  buyVehicle,
  buyClaim,
  toggleCrew,
  vehicleStats,
} from "@/game/sim";
import { X0, WASH_PLANT } from "@/game/river";
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

function valleyGame() {
  const s = freshGame("R27");
  s.cash = 5e6;
  s.watching = true;
  s.washPlant = true;
  s.sluice = true;
  s.preferSluice = true;
  buyClaim(s, 4);
  buyClaim(s, 5);
  buyClaim(s, 6);
  s.claims = [1, 4, 5, 6];
  return s;
}

/** Same hired river crew used in the review playtests. */
function hireReviewRiverCrew(s: ReturnType<typeof freshGame>) {
  parkStarters(s);
  return {
    excavator: hireAt(s, "excavator", X0 + 40, 46),
    loader: hireAt(s, "loader", X0 + 48, 50),
    truckA: hireAt(s, "truck", X0 + 56, 46),
    truckB: hireAt(s, "truck", X0 + 62, 50),
    heavy: hireAt(s, "heavy", X0 + 34, 52),
    skid: hireAt(s, "skid", X0 + 44, 56),
  };
}

type CrewRun = {
  dumps: number;
  cash: number;
  washStuck: number;
  statuses: string[];
};

/** Tracked stand-in for the local crewsim script: a short, deterministic hired-crew run. */
function runHiredCrew(
  s: ReturnType<typeof freshGame>,
  machines: { defId: string; uid: string; cargo: number; status: string }[],
  seconds: number,
): CrewRun {
  const dt = 1 / 20;
  const prev = new Map<string, number>();
  let dumps = 0;
  let washStuck = 0;
  const washSince = new Map<string, { cargo: number; t: number }>();
  const cash0 = s.cash;
  let t = 0;
  for (let i = 0; t < seconds; i++) {
    step(s, idle, dt, true);
    t += dt;
    for (const v of machines) {
      const pc = prev.get(v.uid) ?? 0;
      if (DEFS[v.defId as DefId]?.receives && pc > 1 && v.cargo < 0.2) dumps += 1;
      prev.set(v.uid, v.cargo);
      if (v.status.startsWith("Wash line")) {
        const w = washSince.get(v.uid);
        if (!w || Math.abs(w.cargo - v.cargo) > 0.3) washSince.set(v.uid, { cargo: v.cargo, t });
      } else washSince.delete(v.uid);
    }
  }
  for (const v of machines) {
    const w = washSince.get(v.uid);
    if (w && t - w.t > 60 && v.cargo > 0.4) washStuck += 1;
  }
  return {
    dumps,
    cash: Math.round(s.cash - cash0),
    washStuck,
    statuses: machines.map((v) => `${v.defId} c${v.cargo.toFixed(1)} "${v.status}"`),
  };
}

test("full diggers waiting at the river dig do not freeze dump trucks at the wash plant", () => {
  const s = valleyGame();
  parkStarters(s);
  const excavator = hireAt(s, "excavator", X0 - 18, 32);
  excavator.cargo = vehicleStats(excavator).capacity;
  excavator.cargoOre = "silver";
  const loader = hireAt(s, "loader", X0 + 32, -45);
  loader.cargo = vehicleStats(loader).capacity * 0.97;
  loader.cargoOre = "gold";
  const truckA = hireAt(s, "truck", WASH_PLANT.x + 6, WASH_PLANT.z + 4);
  truckA.cargo = 20;
  truckA.cargoOre = "gold";
  const truckB = hireAt(s, "truck", WASH_PLANT.x + 10, WASH_PLANT.z + 14);
  truckB.cargo = 20;
  truckB.cargoOre = "dirt";
  s.active = 0;
  let dumped = 0;
  const startA = truckA.cargo;
  const startB = truckB.cargo;
  for (let i = 0; i < 30 * 40; i++) {
    const a = truckA.cargo;
    const b = truckB.cargo;
    step(s, idle, 1 / 30, false);
    if (a > 5 && truckA.cargo < 0.4) dumped += 1;
    if (b > 5 && truckB.cargo < 0.4) dumped += 1;
  }
  const note = [excavator, loader, truckA, truckB].map((v) => `${v.defId} ${v.cargo.toFixed(1)}t ${v.status}`).join(" | ");
  assert.ok(dumped >= 1, `no truck dumped at the wash plant: ${note}`);
  assert.ok(truckA.cargo < startA - 5 || truckB.cargo < startB - 5, note);
  const stuck = [truckA, truckB].filter((t) => t.status.startsWith("Wash line") && t.cargo > 5);
  assert.equal(stuck.length, 0, `truck still frozen in the wash line: ${note}`);
});

test("a hired river crew keeps dumping at the wash plant", () => {
  const s = valleyGame();
  const crew = hireReviewRiverCrew(s);
  s.active = 0;
  const machines = [crew.excavator, crew.loader, crew.truckA, crew.truckB, crew.heavy, crew.skid];
  const result = runHiredCrew(s, machines, 180);
  const note = `${result.dumps} dumps, +$${result.cash}, stuck=${result.washStuck}; ${result.statuses.join(" | ")}`;
  assert.ok(result.dumps >= 3, `too few dumps in 180s: ${note}`);
  assert.equal(result.washStuck, 0, `truck frozen in the wash line: ${note}`);
  assert.ok(result.cash > 2000, `crew barely earned: ${note}`);
});

test("a short ridge crew still dumps at the sluice", () => {
  const s = freshGame("R27-ridge");
  s.cash = 5e6;
  s.watching = true;
  s.sluice = true;
  s.preferSluice = true;
  s.claims = [1, 2, 3];
  buyClaim(s, 2);
  buyClaim(s, 3);
  parkStarters(s);
  const machines = [
    hireAt(s, "excavator", 0, 40),
    hireAt(s, "loader", -8, 44),
    hireAt(s, "truck", 12, 42),
    hireAt(s, "truck", 18, 46),
    hireAt(s, "heavy", 24, 44),
    hireAt(s, "skid", -14, 40),
  ];
  s.active = 0;
  const result = runHiredCrew(s, machines, 150);
  const note = `${result.dumps} dumps, +$${result.cash}; ${result.statuses.join(" | ")}`;
  assert.ok(result.dumps >= 2, `ridge crew did not dump: ${note}`);
  assert.ok(result.cash > 1500, `ridge crew barely earned: ${note}`);
});
