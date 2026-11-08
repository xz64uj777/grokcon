import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, addFeedPile, buyVehicle, toggleCrew, YARD_FEED_RATE, YARD_FEED_KEEP, FEED_RATES, plannedPad, basePrice } from "@/game/sim";
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
