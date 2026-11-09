import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, addFeedPile, buyVehicle, buyClaim, toggleCrew, YARD_FEED_RATE, YARD_FEED_KEEP, FEED_RATES, plannedPad, basePrice, vehicleStats } from "@/game/sim";
import { PADS } from "@/game/catalog";
import { saveGame, currentSaveText, readSaveText } from "@/game/save";

const idle = { throttle: 0, steer: 0, action: false };
const wash = () => PADS.find((p) => p.id === "wash" || p.kind === "wash")!;

function feedPile(s: ReturnType<typeof freshGame>) {
  return s.deposits.find((d) => d.id.startsWith("feed-"));
}

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

test("yard feeder alone pays the pile out and removes it (no softlock)", () => {
  const s = freshGame("T");
  s.claims.push(5);
  const pad = wash();
  addFeedPile(s, pad, "gold", 2, 1);
  const c0 = s.cash;
  for (let i = 0; i < Math.ceil(2 / YARD_FEED_RATE + 5) * 10; i++) step(s, idle, 0.1, false);
  assert.equal(feedPile(s), undefined);
  assert.ok(s.cash - c0 > 50, `${s.cash - c0}`);
});

for (const kind of ["excavator", "loader"] as const) {
  test(`crew ${kind} drives over and feeds a 15 t pile fully, faster than the yard`, () => {
    const s = freshGame("T");
    s.cash = 1e6;
    s.claims.push(5);
    const pad = wash();
    buyVehicle(s, kind);
    const m = s.vehicles[s.vehicles.length - 1];
    m.operator = true;
    m.x = pad.x + 30; m.z = pad.z + 10;
    addFeedPile(s, pad, "gold", 15, 1);
    const c0 = s.cash;
    const secs = 15 / FEED_RATES[kind]! + 40;
    for (let i = 0; i < secs * 10; i++) step(s, idle, 0.1, false);
    assert.equal(feedPile(s), undefined, `left ${feedPile(s)?.tons}`);
    assert.ok(secs < 15 / YARD_FEED_RATE);
    assert.ok(s.cash - c0 > 1000, `${s.cash - c0}`);
  });
}

test("plant stockpile crew limit dispatches only one, two, or all eligible operators", () => {
  for (const [limit, expected] of [[1, 1], [2, 2], ["all", 3]] as const) {
    const s = freshGame("T");
    s.cash = 1e6;
    s.claims.push(5);
    s.watching = true;
    s.feedLimit = limit;
    const pad = wash();
    for (const kind of ["skid", "loader", "excavator"] as const) {
      buyVehicle(s, kind);
      const m = s.vehicles[s.vehicles.length - 1];
      m.hired = true;
      m.operator = true;
      m.x = pad.x + 30;
      m.z = pad.z + 10;
    }
    addFeedPile(s, pad, "gold", 10, 1);
    step(s, idle, 1 / 60, true);
    const headed = s.vehicles.filter((v) => v.status === "Heading to feed the plant").length;
    assert.equal(headed, expected, `feed limit ${limit}`);
  }
});

test("ridge overburden hauls to the sluice and pays more than reclaim", () => {
  const s = freshGame("Dirt");
  s.sluice = true;
  s.preferSluice = true;
  buyVehicle(s, "truck");
  const t = s.vehicles[s.vehicles.length - 1];
  t.cargo = 8;
  t.cargoOre = "dirt";
  t.x = 16;
  t.z = 36;
  s.active = s.vehicles.indexOf(t);
  assert.equal(plannedPad(s, s.active), "sluice");
  assert.ok(basePrice("dirt", "sluice", true) > basePrice("dirt", "reclaim", true));
  t.x = 44;
  t.z = 46;
  const cash = s.cash;
  step(s, { throttle: 0, steer: 0, action: true }, 0.2, true);
  assert.equal(s.cash, cash);
  assert.match(t.status, /sluice/i);
  s.preferSluice = false;
  t.x = 16;
  t.z = 36;
  assert.equal(plannedPad(s, s.active), "reclaim");
  s.sluice = false;
  s.preferSluice = true;
  assert.equal(plannedPad(s, s.active), "reclaim");
});

test("a machine goes around one sitting in its way", () => {
  const s = freshGame("Jam");
  s.cash = 1e6;
  s.watching = true;
  const pad = PADS.find((p) => p.kind === "crusher")!;
  buyVehicle(s, "skid");
  const blocker = s.vehicles[s.vehicles.length - 1];
  blocker.x = pad.x;
  blocker.z = pad.z + 8;
  blocker.yaw = 0;
  blocker.operator = false;
  buyVehicle(s, "skid");
  const mover = s.vehicles[s.vehicles.length - 1];
  mover.x = pad.x;
  mover.z = pad.z + 16;
  mover.yaw = 0;
  mover.cargo = 3;
  mover.cargoOre = "iron";
  mover.hired = true;
  mover.operator = true;
  s.active = 0;
  let overlapped = 0;
  for (let i = 0; i < 30 * 6; i++) {
    step(s, idle, 1 / 30, false);
    if (Math.hypot(mover.x - blocker.x, mover.z - blocker.z) < 2.4) overlapped++;
  }
  const gap = Math.hypot(mover.x - blocker.x, mover.z - blocker.z);
  assert.ok(gap > 3, `still boxed in, gap ${gap.toFixed(2)} status ${mover.status}`);
  assert.ok(overlapped < 60, `jammed for ${(overlapped / 30).toFixed(1)}s`);
});

test("the yard sells extra diggers and trucks, each one costing more", () => {
  const s = freshGame("Fleet");
  s.cash = 2_000_000;
  for (const id of ["dozer", "loader", "excavator", "heavy"] as const) {
    assert.equal(buyVehicle(s, id), "");
    assert.equal(buyVehicle(s, id), "");
    assert.match(buyVehicle(s, id), /yard limit/);
  }
  const before = s.cash;
  assert.equal(buyVehicle(s, "truck"), "");
  const first = before - s.cash;
  assert.equal(buyVehicle(s, "truck"), "");
  assert.equal(before - s.cash, first * 3);
  assert.equal(buyVehicle(s, "truck"), "");
  assert.match(buyVehicle(s, "truck"), /yard limit/);
  assert.equal(s.vehicles.filter((v) => v.defId === "truck").length, 3);
});

test("plant stockpile crew limit survives a save and load", () => {
  const s = freshGame("T");
  s.feedLimit = 1;
  saveGame(s, true);
  assert.equal(readSaveText(currentSaveText()!)?.feedLimit, 1);
});

test("a closer machine on the other bank does not take a plant slot", () => {
  const s = freshGame("Bank");
  s.cash = 1e6;
  s.claims.push(5);
  s.watching = true;
  s.feedLimit = 1;
  const pad = wash();
  buyVehicle(s, "skid");
  const skid = s.vehicles[s.vehicles.length - 1];
  skid.hired = true;
  skid.operator = true;
  skid.x = pad.x - 68;
  skid.z = pad.z;
  buyVehicle(s, "loader");
  const loader = s.vehicles[s.vehicles.length - 1];
  loader.hired = true;
  loader.operator = true;
  loader.x = pad.x + 90;
  loader.z = pad.z;
  addFeedPile(s, pad, "gold", 10, 1);
  step(s, idle, 1 / 60, true);
  assert.match(loader.status, /feed/i);
  assert.doesNotMatch(skid.status, /feed/i);
});

test("an emptied dozer crumb is removed and a fresh one is kept", () => {
  const s = freshGame("Crumbs");
  const sample = s.deposits.find((d) => d.kind === "pile");
  assert.ok(sample);
  s.deposits.push({ ...sample, id: "crumb-empty", tons: 0, max: 0.08, regen: 0, x: 12, z: -24 });
  s.deposits.push({ ...sample, id: "crumb-live", tons: 0.08, max: 0.08, regen: 0, x: 20, z: -24 });
  s.deposits.push({ ...sample, id: "crumb-worked", tons: 0.05, max: 4, regen: 0, x: 28, z: -24 });
  step(s, idle, 1 / 30, false);
  assert.equal(s.deposits.some((d) => d.id === "crumb-empty"), false);
  assert.equal(s.deposits.some((d) => d.id === "crumb-worked"), false);
  assert.equal(s.deposits.some((d) => d.id === "crumb-live"), true);
});

test("skid steer feeding earns for the whole pile, not $20", () => {
  const s = freshGame("T");
  s.cash = 1e6;
  s.claims.push(5);
  const pad = wash();
  buyVehicle(s, "skid");
  const m = s.vehicles[s.vehicles.length - 1];
  s.active = s.vehicles.length - 1;
  m.x = pad.x; m.z = pad.z + 3;
  addFeedPile(s, pad, "gold", 5, 1);
  const c0 = s.cash;
  for (let i = 0; i < 160; i++) step(s, { ...idle, action: true }, 0.1, true);
  assert.equal(feedPile(s), undefined);
  assert.ok(s.cash - c0 > 500, `${s.cash - c0}`);
});

test("feed piles stack on one pile and are fed to zero", () => {
  const s = freshGame("T");
  const pad = wash();
  addFeedPile(s, pad, "gold", 1.5, 1);
  addFeedPile(s, pad, "gold", 1.5, 0.9);
  assert.equal(s.deposits.filter((d) => d.id.startsWith("feed-")).length, 1);
  for (let i = 0; i < 400; i++) step(s, idle, 0.1, false);
  assert.equal(feedPile(s), undefined);
});

test("separate nearby piles survive save and reload", () => {
  const s = freshGame("T");
  const base = { kind: "pile" as const, ore: "gold" as const, regen: 0, claim: 1, radius: 6, sign: "PILE", purity: 1, overburden: 0, grade: 1, stress: 0, bench: 1, benchProgress: 0, hard: false, tested: true, lastBlastDay: -1 };
  s.deposits.push({ ...base, id: "p-a", tons: 3, max: 3, x: 10, z: 30 }, { ...base, id: "p-b", tons: 30, max: 30, x: 18, z: 30 }, { ...base, id: "p-c", tons: 200, max: 200, x: 10, z: 40 });
  saveGame(s, true);
  const back = readSaveText(currentSaveText()!)!;
  const tons = ["p-a", "p-b", "p-c"].map((id) => back.deposits.find((d) => d.id === id)?.tons);
  assert.deepEqual(tons, [3, 30, 200]);
});

test("yard feeder keeps a 20% cut, paying less than crew feeding", () => {
  const pay = (crew: boolean) => {
    const s = freshGame("T");
    s.cash = 1e6;
    s.claims.push(5);
    const pad = wash();
    if (crew) {
      buyVehicle(s, "loader");
      const m = s.vehicles[s.vehicles.length - 1];
      m.operator = true;
      m.x = pad.x + 3; m.z = pad.z + 3;
    }
    addFeedPile(s, pad, "gold", 2, 1);
    const c0 = s.cash;
    for (let i = 0; i < 300; i++) step(s, idle, 0.1, false);
    assert.equal(feedPile(s), undefined);
    return s.cash - c0;
  };
  assert.equal(YARD_FEED_KEEP, 0.8);
  assert.ok(pay(false) < pay(true), `${pay(false)} vs ${pay(true)}`);
});

test("a parked crusher does not slide when another machine is against it", () => {
  const s = freshGame("Crusher");
  const plant = s.vehicles.find((v) => v.defId === "crusher")!;
  const truck = s.vehicles[0];
  plant.x = 20;
  plant.z = 20;
  plant.yaw = 0.4;
  plant.speed = 2;
  plant.operator = false;
  truck.x = plant.x + 2;
  truck.z = plant.z;
  truck.speed = 4;
  s.active = 0;
  s.watching = false;
  for (let i = 0; i < 60; i++) step(s, idle, 1 / 30, true);
  assert.equal(plant.x, 20);
  assert.equal(plant.z, 20);
  assert.equal(plant.speed, 0);
  assert.equal(plant.operator, false);
});

test("a light plant can be bought again and stays parked", () => {
  const s = freshGame("Lights");
  s.cash = 40000;
  assert.equal(buyVehicle(s, "light"), "");
  assert.equal(s.cash, 40000 - 3200);
  assert.equal(buyVehicle(s, "light"), "");
  assert.equal(s.cash, 40000 - 3200 - 6400);
  const plant = s.vehicles.find((v) => v.defId === "light")!;
  plant.x = 12;
  plant.z = 40;
  s.watching = true;
  assert.equal(toggleCrew(s, s.vehicles.indexOf(plant)), "");
  for (let i = 0; i < 90; i++) step(s, idle, 1 / 30, false);
  assert.ok(Math.hypot(plant.x - 12, plant.z - 40) < 1.5, `${plant.x.toFixed(1)} ${plant.z.toFixed(1)} ${plant.status}`);
});

test("turning in the open yard is not called a wall", () => {
  const s = freshGame("Open");
  s.watching = true;
  const v = s.vehicles[0];
  v.x = 0;
  v.z = 40;
  v.yaw = Math.PI;
  v.operator = true;
  v.hired = true;
  let wall = 0;
  for (let i = 0; i < 30 * 5; i++) {
    step(s, idle, 1 / 30, false);
    if (v.status === "Backing off a wall" || v.unstick > 0) wall++;
  }
  assert.equal(wall, 0);
});

test("a loader fills from the edge of a pile and the truck waits beside it", () => {
  const s = freshGame("Edge");
  s.cash = 1e6;
  s.watching = true;
  const pile = s.deposits.find((d) => d.kind === "pile" && d.ore === "iron" && d.tons > 2);
  assert.ok(pile);
  buyVehicle(s, "loader");
  buyVehicle(s, "truck");
  const loader = s.vehicles.find((v) => v.defId === "loader")!;
  const truck = s.vehicles.find((v) => v.defId === "truck")!;
  loader.x = pile!.x + 7;
  loader.z = pile!.z;
  loader.yaw = Math.PI / 2;
  truck.x = pile!.x + 7;
  truck.z = pile!.z + 14;
  truck.yaw = 0;
  for (const m of [loader, truck]) {
    m.hired = true;
    m.operator = true;
  }
  s.active = 0;
  let moved = 0;
  for (let i = 0; i < 30 * 10; i++) {
    step(s, idle, 1 / 30, false);
    moved = Math.max(moved, loader.cargo, truck.cargo);
  }
  assert.ok(moved > 0.4, `nothing scooped, loader ${loader.cargo.toFixed(2)} ${loader.status} truck ${truck.cargo.toFixed(2)}`);
  const gap = Math.hypot(truck.x - loader.x, truck.z - loader.z);
  assert.ok(gap > 5, `truck on the loader, gap ${gap.toFixed(1)} ${truck.status}`);
  if (truck.status === "Waiting to load") {
    const tx = truck.x;
    const tz = truck.z;
    loader.x += 1.5;
    for (let i = 0; i < 30 * 3; i++) step(s, idle, 1 / 30, false);
    assert.ok(Math.hypot(truck.x - tx, truck.z - tz) < 8, `truck chased a small move`);
  }
});

test("the dump truck and heavy reach the outward loading lane and load without entering the pile", () => withSeededRandom(123, () => {
  const s = freshGame("QueueTransfer");
  s.cash = 1e6;
  s.watching = true;
  const pile = s.deposits.find((d) => d.id === "starter")!;
  buyVehicle(s, "loader");
  buyVehicle(s, "truck");
  buyVehicle(s, "heavy");
  const loader = s.vehicles.find((v) => v.defId === "loader")!;
  const truck = s.vehicles.find((v) => v.defId === "truck")!;
  const heavy = s.vehicles.find((v) => v.defId === "heavy")!;
  loader.x = pile.x + 7;
  loader.z = pile.z;
  loader.yaw = Math.PI / 2;
  truck.x = pile.x + 7;
  truck.z = pile.z + 14;
  heavy.x = pile.x - 8;
  heavy.z = pile.z + 15;
  for (const v of [loader, truck, heavy]) {
    v.hired = true;
    v.operator = true;
  }
  s.active = s.vehicles.indexOf(loader);
  let sawBay = false;
  let transferred = false;
  let nearestPileGap = Infinity;
  for (let i = 0; i < 30 * 40; i++) {
    step(s, idle, 1 / 30, false);
    for (const v of [truck, heavy]) {
      if (v.status === "In the load bay") sawBay = true;
      if (v.cargo > 0.2) transferred = true;
      nearestPileGap = Math.min(nearestPileGap, Math.hypot(v.x - pile.x, v.z - pile.z));
    }
  }
  assert.ok(sawBay, `neither truck stopped in the bay: ${truck.status} / ${heavy.status}`);
  assert.ok(transferred, `loader never transferred material: ${loader.status}`);
  assert.ok(nearestPileGap > 12, `a truck crowded the pile: nearest center distance ${nearestPileGap.toFixed(1)}m`);
}));

test("a dump truck stays parked until its bed is nearly full, then heads to dump", () => {
  const s = freshGame("Park");
  s.cash = 1e6;
  s.watching = true;
  const pile = s.deposits.find((d) => d.id === "starter")!;
  buyVehicle(s, "loader");
  buyVehicle(s, "truck");
  const loader = s.vehicles.find((v) => v.defId === "loader")!;
  const truck = s.vehicles.find((v) => v.defId === "truck")!;
  loader.x = pile.x;
  loader.z = pile.z + 4;
  loader.yaw = 0;
  truck.x = pile.x - 18;
  truck.z = pile.z - 6;
  truck.yaw = Math.PI / 2;
  truck.cargo = 14;
  truck.cargoOre = "iron";
  for (const m of [loader, truck]) {
    m.hired = true;
    m.operator = true;
  }
  loader.operator = false;
  s.active = s.vehicles.indexOf(loader);
  let parked = false;
  for (let i = 0; i < 30 * 45 && !parked; i++) {
    step(s, idle, 1 / 30, false);
    parked = truck.status === "In the load bay" || truck.status === "Waiting at the pile" || truck.status === "Waiting to load";
  }
  assert.equal(parked, true, truck.status);
  const gap = Math.hypot(truck.x - loader.x, truck.z - loader.z);
  assert.ok(gap > 8, `too close, gap ${gap.toFixed(1)}`);
  const tx = truck.x;
  const tz = truck.z;
  loader.x += 5;
  for (let i = 0; i < 30 * 3; i++) step(s, idle, 1 / 30, false);
  assert.ok(Math.hypot(truck.x - tx, truck.z - tz) < 3, `left the spot early, ${truck.status}`);
  loader.x -= 5;
  const cap = vehicleStats(truck).capacity;
  truck.cargo = cap * 0.72;
  const partialFrom = { x: truck.x, z: truck.z };
  s.seconds += 60;
  for (let i = 0; i < 30 * 4; i++) step(s, idle, 1 / 30, false);
  const partialMove = Math.hypot(truck.x - partialFrom.x, truck.z - partialFrom.z);
  assert.ok(partialMove < 2, `partial truck moved ${partialMove.toFixed(1)}m after a long wait: ${truck.status}`);
  assert.ok(!/haul|dump/i.test(truck.status), `partial truck should remain parked: ${truck.status}`);
  truck.cargo = cap * 0.9;
  const fullFrom = { x: truck.x, z: truck.z };
  for (let i = 0; i < 30 && !/Hauling to|Dumping at/.test(truck.status); i++) step(s, idle, 1 / 30, false);
  assert.match(truck.status, /Hauling to|Dumping at/, `nearly-full truck should dispatch immediately, got ${truck.status}`);
  for (let i = 0; i < 30 * 12; i++) step(s, idle, 1 / 30, false);
  const fullMove = Math.hypot(truck.x - fullFrom.x, truck.z - fullFrom.z);
  assert.ok(fullMove > 6 || truck.cargo < cap * 0.9, `nearly-full truck did not make its dump trip: ${truck.status}, moved ${fullMove.toFixed(1)}m`);
});

test("a loader does not chase an unassigned truck that has not backed into the bay", () => {
  const s = freshGame("Handshake");
  s.cash = 1e6;
  s.watching = true;
  const pile = s.deposits.find((d) => d.id === "starter")!;
  buyVehicle(s, "loader");
  buyVehicle(s, "truck");
  const loader = s.vehicles.find((v) => v.defId === "loader")!;
  const truck = s.vehicles.find((v) => v.defId === "truck")!;
  loader.x = pile.x + 8;
  loader.z = pile.z + 2;
  loader.cargo = 6;
  loader.cargoOre = "iron";
  truck.x = loader.x + 14;
  truck.z = loader.z + 2;
  for (const m of [loader, truck]) {
    m.hired = true;
    m.operator = true;
  }
  s.active = 0;
  let sawTruckApproaching = false;
  for (let i = 0; i < 30 * 6; i++) {
    step(s, idle, 1 / 30, false);
    if (truck.status !== "In the load bay") {
      sawTruckApproaching = true;
      assert.doesNotMatch(loader.status, /Loading the Truck|Hauling to the Truck/, `loader chased during truck approach: ${loader.status}; truck ${truck.status}`);
    }
  }
  assert.equal(sawTruckApproaching, true);
});

test("dump trucks wait in line instead of crowding one loader", () => {
  const s = freshGame("Queue");
  s.cash = 1e6;
  s.watching = true;
  buyVehicle(s, "loader");
  buyVehicle(s, "truck");
  buyVehicle(s, "truck");
  const loader = s.vehicles.find((v) => v.defId === "loader")!;
  const trucks = s.vehicles.filter((v) => v.defId === "truck");
  loader.x = -8;
  loader.z = 8;
  loader.yaw = 0;
  trucks[0]!.x = 14;
  trucks[0]!.z = 8;
  trucks[1]!.x = 18;
  trucks[1]!.z = 14;
  for (const m of [loader, ...trucks]) {
    m.hired = true;
    m.operator = true;
  }
  s.active = 0;
  let sawLine = false;
  let queuedGap = 0;
  for (let i = 0; i < 30 * 12; i++) {
    step(s, idle, 1 / 30, false);
    if (trucks.some((t) => t.status.startsWith("In line"))) {
      sawLine = true;
      queuedGap = Math.max(queuedGap, Math.hypot(trucks[0]!.x - trucks[1]!.x, trucks[0]!.z - trucks[1]!.z));
    }
  }
  assert.ok(sawLine, trucks.map((t) => t.status).join(" | "));
  assert.ok(queuedGap > 8, `queued on top of each other, gap ${queuedGap.toFixed(1)}`);
});

test("machines take turns at the wash plant without queuing off the bank", () => {
  const s = freshGame("Wash");
  s.cash = 1e6;
  s.watching = true;
  s.washPlant = true;
  buyVehicle(s, "truck");
  buyVehicle(s, "truck");
  buyVehicle(s, "truck");
  const trucks = s.vehicles.filter((v) => v.defId === "truck");
  trucks[0]!.x = 1058;
  trucks[0]!.z = 18;
  trucks[1]!.x = 1072;
  trucks[1]!.z = 18;
  trucks[2]!.x = 1072;
  trucks[2]!.z = 30;
  for (const t of trucks) {
    t.hired = true;
    t.operator = true;
    t.cargo = 20;
    t.cargoOre = "silver";
  }
  s.active = 0;
  let sawLine = false;
  for (let i = 0; i < 30 * 18; i++) {
    step(s, idle, 1 / 30, false);
    if (trucks.some((t) => t.status.startsWith("Wash line"))) sawLine = true;
  }
  const note = trucks.map((t) => `${t.status} ${t.cargo.toFixed(0)}t`).join(" | ");
  assert.ok(sawLine, note);
  const stillLoaded = trucks.filter((t) => t.cargo > 5);
  assert.ok(stillLoaded.length <= 1, note);
  for (const t of trucks) {
    assert.ok(t.x + vehicleStats(t).radius <= 1092, `truck queued beyond the east bank: x=${t.x.toFixed(1)} ${t.status}`);
  }
  const queued = trucks.filter((t) => t.status.startsWith("Wash line"));
  for (let i = 0; i < queued.length; i++) {
    for (let j = i + 1; j < queued.length; j++) {
      const gap = Math.hypot(queued[i]!.x - queued[j]!.x, queued[i]!.z - queued[j]!.z);
      assert.ok(gap > vehicleStats(queued[i]!).radius + vehicleStats(queued[j]!).radius + 1, `wash queue overlap ${gap.toFixed(1)}m`);
    }
  }
});

test("an empty truck waits back at its pile instead of following the loader", () => {
  const s = freshGame("Home");
  s.cash = 1e6;
  s.watching = true;
  const pile = s.deposits.find((d) => d.id === "starter")!;
  buyVehicle(s, "loader");
  buyVehicle(s, "truck");
  const loader = s.vehicles.find((v) => v.defId === "loader")!;
  const truck = s.vehicles.find((v) => v.defId === "truck")!;
  loader.x = 46;
  loader.z = -30;
  loader.yaw = 0;
  truck.x = pile.x + 10;
  truck.z = pile.z;
  truck.yaw = 0;
  for (const m of [loader, truck]) {
    m.hired = true;
    m.operator = true;
  }
  s.active = 0;
  for (let i = 0; i < 30 * 8; i++) step(s, idle, 1 / 30, false);
  const fromPile = Math.hypot(truck.x - pile.x, truck.z - pile.z);
  const fromLoader = Math.hypot(truck.x - loader.x, truck.z - loader.z);
  assert.ok(fromPile > 12, `too close to the pile, ${fromPile.toFixed(1)} ${truck.status}`);
  assert.ok(fromLoader > 15, `followed the loader, ${fromLoader.toFixed(1)} ${truck.status}`);
});

test("a skid steer drops a pile for the loader instead of hauling one bucket", () => {
  const s = freshGame("Skid");
  s.cash = 1e6;
  s.watching = true;
  buyVehicle(s, "loader");
  buyVehicle(s, "skid");
  const loader = s.vehicles.find((v) => v.defId === "loader")!;
  const skid = s.vehicles.find((v) => v.defId === "skid")!;
  loader.x = -16;
  loader.z = 36;
  loader.yaw = 0;
  skid.x = -2;
  skid.z = 6;
  skid.yaw = 0;
  skid.cargo = 2.4;
  skid.cargoOre = "iron";
  for (const m of [loader, skid]) {
    m.hired = true;
    m.operator = true;
  }
  s.active = 0;
  let emptied = false;
  for (let i = 0; i < 30 * 8; i++) {
    step(s, idle, 1 / 30, false);
    if (skid.cargo < 0.3) emptied = true;
  }
  assert.ok(emptied, `never dropped the bucket, ${skid.cargo.toFixed(2)} ${skid.status}`);
  assert.ok(Math.hypot(skid.x - 32, skid.z - 30) > 12, `hauled to the crusher ${skid.status}`);
  const dropped = s.deposits.some((d) => d.kind === "pile" && d.ore === "iron" && d.tons > 1 && Math.hypot(d.x + 2, d.z - 6) < 22);
  assert.ok(dropped, `${skid.status} at ${skid.x.toFixed(0)},${skid.z.toFixed(0)}`);
});

test("a skid steer reaches gold creek without driving into the southwest wall", () => {
  const s = freshGame("Gold");
  s.cash = 1e6;
  s.watching = true;
  buyClaim(s, 3);
  buyVehicle(s, "skid");
  const skid = s.vehicles.find((v) => v.defId === "skid")!;
  skid.x = -16;
  skid.z = 8;
  skid.yaw = Math.PI;
  skid.hired = true;
  skid.operator = true;
  skid.workClaim = 3;
  s.active = 0;
  let hitWall = false;
  let reached = false;
  for (let i = 0; i < 30 * 20; i++) {
    step(s, idle, 1 / 30, false);
    if (skid.x > -55 && skid.x < -25 && skid.z > 4.5 && skid.z < 12) hitWall = true;
    if (skid.x < -60 && skid.z > 14) reached = true;
  }
  assert.equal(hitWall, false);
  assert.ok(reached, `didn't reach the creek, ${skid.x.toFixed(0)},${skid.z.toFixed(0)} ${skid.status}`);
});

test("a dump truck stays clear of gold gravel when no payloader is hired", () => {
  const s = freshGame("Behind");
  s.cash = 1e6;
  s.watching = true;
  buyClaim(s, 3);
  buyVehicle(s, "truck");
  const truck = s.vehicles.find((v) => v.defId === "truck")!;
  truck.x = -98;
  truck.z = 14;
  truck.yaw = Math.PI;
  truck.hired = true;
  truck.operator = true;
  s.active = 0;
  for (let i = 0; i < 30 * 14; i++) step(s, idle, 1 / 30, false);
  assert.equal(truck.status, "Needs a payloader");
  assert.ok(truck.x < -88, `truck entered the gravel without a loading bay at ${truck.x.toFixed(0)},${truck.z.toFixed(0)}`);
});
