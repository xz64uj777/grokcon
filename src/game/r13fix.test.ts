import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, addFeedPile, buyVehicle, toggleCrew, setCrewDuty, YARD_FEED_RATE, YARD_FEED_KEEP, FEED_RATES } from "@/game/sim";
import { PADS } from "@/game/catalog";
import { saveGame, currentSaveText, readSaveText } from "@/game/save";

const idle = { throttle: 0, steer: 0, action: false };
const wash = () => PADS.find((p) => p.id === "wash" || p.kind === "wash")!;

function feedPile(s: ReturnType<typeof freshGame>) {
  return s.deposits.find((d) => d.id.startsWith("feed-"));
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

test("plant stockpile crew limit survives a save and load", () => {
  const s = freshGame("T");
  s.feedLimit = 1;
  saveGame(s, true);
  assert.equal(readSaveText(currentSaveText()!)?.feedLimit, 1);
});

test("plant truck limit dispatches only one, two, or all hired full trucks to the drop", () => {
  for (const [limit, expected] of [[1, 1], [2, 2], ["all", 2]] as const) {
    const s = freshGame("T");
    s.cash = 1e6;
    s.sluice = true;
    s.preferSluice = true;
    s.watching = true;
    s.truckLimit = limit;
    const pad = PADS.find((p) => p.kind === "sluice")!;
    for (const [n, kind] of (["truck", "heavy"] as const).entries()) {
      buyVehicle(s, kind);
      const v = s.vehicles[s.vehicles.length - 1];
      v.hired = true;
      v.operator = true;
      v.cargo = 100;
      v.cargoOre = "gold";
      v.cargoPurity = 1;
      v.x = pad.x + 45 + n * 4;
      v.z = pad.z + 35;
    }
    step(s, idle, 1 / 60, true);
    const trucks = s.vehicles.filter((v) => v.defId === "truck" || v.defId === "heavy");
    assert.equal(trucks.filter((v) => v.status === `Hauling to ${pad.name}`).length, expected, `truck limit ${limit}`);
    assert.equal(trucks.filter((v) => v.status === `Waiting for a clear drop spot at ${pad.name}`).length, 2 - expected, `queued trucks at limit ${limit}: ${trucks.map((v) => `${v.defId}=${v.status}`).join(", ")}`);
    if (limit === 1) {
      const delivering = trucks.find((v) => v.status === `Hauling to ${pad.name}`)!;
      const queued = trucks.find((v) => v.status === `Waiting for a clear drop spot at ${pad.name}`)!;
      delivering.unstick = 1;
      step(s, idle, 1 / 60, true);
      assert.equal(delivering.status, "Backing off a wall");
      assert.equal(queued.status, `Waiting for a clear drop spot at ${pad.name}`, "a temporary back-up does not release the slot");
      delivering.unstick = 0;
      const queuedPosition = { x: queued.x, z: queued.z };
      queued.x = pad.x;
      queued.z = pad.z;
      step(s, idle, 1 / 60, true);
      assert.equal(queued.status, `Waiting for a clear drop spot at ${pad.name}`);
      assert.equal(queued.cargo, 100);
      queued.x = queuedPosition.x;
      queued.z = queuedPosition.z;
      delivering.x = pad.x;
      delivering.z = pad.z;
      step(s, idle, 1 / 60, true);
      assert.equal(delivering.cargo, 0, "the truck with the active slot unloads");
      step(s, idle, 1 / 60, true);
      assert.equal(queued.status, `Hauling to ${pad.name}`, "a queued truck takes the freed slot");
    }
  }
});

test("global crew pause and resume affects hired operators only and saves the truck limit", () => {
  const s = freshGame("T");
  s.cash = 1e6;
  s.claims.push(5);
  s.truckLimit = 1;
  buyVehicle(s, "truck");
  const truck = s.vehicles[s.vehicles.length - 1];
  truck.hired = true;
  truck.operator = true;
  truck.workClaim = 5;
  setCrewDuty(s, false);
  assert.equal(truck.hired, true);
  assert.equal(truck.operator, false);
  assert.equal(truck.workClaim, 5);
  setCrewDuty(s, true);
  assert.equal(truck.hired, true);
  assert.equal(truck.operator, true);
  assert.equal(s.vehicles[0].hired, false);
  assert.equal(s.vehicles[0].operator, false);
  saveGame(s, true);
  const loaded = readSaveText(currentSaveText()!)!;
  assert.equal(loaded.truckLimit, 1);
  assert.equal(loaded.vehicles.find((v) => v.defId === "truck")?.operator, true);
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
