import { test } from "node:test";
import assert from "node:assert/strict";
import * as O from "@/game/ops";
import { freshGame, step, opsAction } from "@/game/sim";
import { bookWorth } from "@/game/save";
import type { VehicleState } from "@/game/types";

const truck = (cargo: number, speed: number) => ({ defId: "truck", cargo, speed } as unknown as VehicleState);

test("R1 loaded truck tips in a hard fast turn, not a gentle one; ramp adds margin", () => {
  assert.equal(O.wouldTip(truck(10, 15), 0.6, 12, false), true);
  assert.equal(O.wouldTip(truck(10, 15), 0.2, 12, false), false);
  assert.equal(O.wouldTip(truck(2, 15), 0.6, 12, false), false);
  assert.ok(O.tipLimit(1, true) > O.tipLimit(1, false));
  assert.equal(O.wouldTip({ ...truck(10, 15), defId: "loader" } as VehicleState, 2, 12, false), false);
});

test("R2 nuggets only in gold/silver and are deterministic", () => {
  assert.equal(O.nuggetValue(1, 1, "a", "iron"), 0);
  let hits = 0;
  for (let d = 0; d < 200; d++) {
    const v = O.nuggetValue(7, d, "g1", "gold");
    assert.equal(v, O.nuggetValue(7, d, "g1", "gold"));
    if (v) { hits++; assert.ok(v >= 1200 && v <= 3000); }
  }
  assert.ok(hits > 20 && hits < 65);
});

test("R2/R3 scanner and ripper are bought, then usable once", () => {
  const s = freshGame("T");
  s.cash = 50000;
  assert.match(opsAction(s, "buy:scanner"), /Bought/);
  assert.equal(s.cash, 50000 - O.PRICES.scanner);
  assert.equal(opsAction(s, "buy:scanner"), "");
  const hard = s.deposits.find((d) => d.hard)!;
  O.ops(s).ripper = true;
  O.act(s, "rip", { nearFace: { id: hard.id, ore: hard.ore, hard: true, tested: false }, nearIds: [] });
  assert.equal(hard.hard, false);
  assert.ok(O.ops(s).ripped.includes(hard.id));
});

test("R4 reputation raises contract and sale pay", () => {
  const s = freshGame("T");
  assert.equal(O.contractMult(s), 1);
  for (let i = 0; i < 7; i++) O.onContractFilled(s);
  assert.equal(O.repLevel(O.ops(s).rep), 2);
  assert.ok(Math.abs(O.contractMult(s) - 1.2) < 1e-9);
  assert.ok(O.saleMult(s, "iron", "crusher") > 1);
});

test("R5 events: flood closes bridge only that day; double pays 2x", () => {
  const s = freshGame("T");
  O.ops(s).event = { kind: "flood", day: s.market.day };
  assert.equal(O.bridgeClosed(s), true);
  s.seconds = 90;
  assert.equal(O.bridgeClock(s), "Bridge closed 1:30 · opens in 3:30");
  O.ops(s).event = { kind: "flood", day: s.market.day - 1 };
  assert.equal(O.bridgeClosed(s), false);
  assert.equal(O.bridgeClock(s), "");
  O.ops(s).event = { kind: "double", day: s.market.day, ore: "gold" };
  assert.equal(O.saleMult(s, "gold", "sluice"), 2);
  assert.equal(O.saleMult(s, "iron", "crusher"), 1);
  const kinds = new Set<string>();
  for (let d = 0; d < 300; d++) kinds.add(O.rollEvent(3, d, true, ["u"])?.kind ?? "none");
  assert.deepEqual([...kinds].sort(), ["breakdown", "double", "flood", "none"]);
  for (let d = 0; d < 300; d++) assert.notEqual(O.rollEvent(3, d, false, [])?.kind, "flood");
});

test("R6 screening deck needs the wash plant and pays 12% at the wash", () => {
  const s = freshGame("T");
  s.cash = 1e6;
  assert.ok(!O.shopButtons(s).some((b) => b.id === "buy:screen"));
  s.washPlant = true;
  assert.ok(O.shopButtons(s).some((b) => b.id === "buy:screen"));
  O.ops(s).screen = true;
  assert.ok(Math.abs(O.saleMult(s, "gold", "wash") - 1.12) < 1e-9);
});

test("R7 tires wear with distance and only go flat when worn", () => {
  assert.ok(Math.abs(O.wear(1, 12500) - 0.5) < 1e-9);
  assert.equal(O.flatChance(0.5, 100), 0);
  assert.ok(O.flatChance(0.1, 100) > 0);
});

test("R8 night is the last part of the day", () => {
  assert.equal(O.nightness(10), 0);
  assert.equal(O.nightness(O.DAY * 0.85), 1);
  assert.equal(O.nightness(O.DAY * 1.1), 0);
});

test("R8/R9 hired crew keeps working in the dark, and stops when the tank is empty", () => {
  const s = freshGame("T");
  const v = s.vehicles[0];
  s.active = 1;
  v.hired = true;
  s.seconds = O.DAY * 0.85;
  const prev = O.before(s);
  v.x += 2;
  O.tick(s, prev, 0.016, () => 2, () => {});
  assert.equal(v.x, prev.get(v.uid)!.x + 2);
  assert.notEqual(v.status, "Too dark to work (no lights)");
  O.ops(s).fuel[v.uid] = 0;
  const dry = O.before(s);
  v.x += 2;
  O.tick(s, dry, 0.016, () => 2, () => {});
  assert.equal(v.status, "Out of fuel");
  assert.equal(v.x, dry.get(v.uid)!.x);
  s.cash = 1000;
  s.active = 0;
  assert.match(opsAction(s, "fuel"), /Tank filled/);
  assert.equal(O.ops(s).fuel[v.uid], 1);
  assert.equal(s.cash, 1000 - (100 * O.PRICES.diesel + O.PRICES.callout));
});

test("R11 inspector fines a beat-up site and rewards a clean one", () => {
  const s = freshGame("T");
  s.cash = 10000;
  O.inspect(s);
  assert.equal(s.cash, 10000);
  assert.equal(O.ops(s).rep, 5);
  s.vehicles[0].damage = 0.9;
  O.inspect(s);
  assert.equal(s.cash, 10000 - O.PRICES.fine);
  assert.ok(O.ops(s).nextInspect > s.market.day);
});

test("ops survive save/load and old saves get defaults; buying never lowers book worth", () => {
  const s = freshGame("T");
  s.cash = 20000;
  const w0 = bookWorth(s);
  opsAction(s, "buy:lights");
  assert.ok(bookWorth(s) >= w0);
  const r = O.readOps(JSON.parse(JSON.stringify(s.ops)));
  assert.equal(r.lights, true);
  assert.deepEqual(O.readOps(undefined), O.freshOps());
  assert.equal(O.readOps({ photo: true }).photo, false);
});

test("sim step runs with ops for a few seconds", () => {
  const s = freshGame("T");
  for (let i = 0; i < 300; i++) step(s, { throttle: 1, steer: 0.3, action: false }, 1 / 30, true);
  assert.ok((O.ops(s).fuel[s.vehicles[0].uid] ?? 1) < 1);
});

test("fix: tire purchase counts in save score so reload keeps it", () => {
  const s = freshGame("T");
  s.cash = 10000;
  O.ops(s).flat = [s.vehicles[0].uid];
  const w0 = bookWorth(s);
  assert.match(opsAction(s, "tires"), /New tires/);
  assert.ok(bookWorth(s) >= w0);
  const r = O.readOps(JSON.parse(JSON.stringify(s.ops)));
  assert.deepEqual(r.flat, []);
  assert.equal(r.upkeep, 900);
});

test("fix: broke player out of fuel gets towed with fuel on credit, repaid from sales", () => {
  const s = freshGame("T");
  const v = s.vehicles[0];
  s.cash = 0;
  v.x = 50;
  O.ops(s).fuel[v.uid] = 0;
  O.tick(s, O.before(s), 0.016, () => 2, () => {}, () => ({ x: 0, z: 44 }));
  assert.equal(v.x, 0);
  assert.equal(O.ops(s).fuel[v.uid], 0.25);
  assert.notEqual(v.status, "Out of fuel");
  const debt = O.ops(s).debt;
  assert.ok(debt > 0);
  s.cash = 100;
  O.onSale(s, 100, 1);
  assert.equal(O.ops(s).debt, Math.max(0, debt - 100));
});

test("fix: refuelling clears Out of fuel at once", () => {
  const s = freshGame("T");
  const v = s.vehicles[0];
  s.cash = 1000;
  O.ops(s).fuel[v.uid] = 0;
  v.status = "Out of fuel";
  opsAction(s, "fuel");
  assert.equal(v.status, "");
});
