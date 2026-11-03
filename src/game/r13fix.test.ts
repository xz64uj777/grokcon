import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, addFeedPile, buyVehicle, YARD_FEED_RATE, FEED_RATES } from "@/game/sim";
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
