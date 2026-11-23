import { test } from "node:test";
import assert from "node:assert/strict";
import type { VehicleId } from "@/game/types";
import { buyVehicle, freshGame, lotBuy, lotButtons, sellVehicle, step } from "@/game/sim";
import { currentSaveText, readSaveText, saveGame } from "@/game/save";
import { ops } from "@/game/ops";
import { addPile } from "@/game/sim/feed";
import { acceptsJob, pileApproach, pileInReach } from "@/game/sim/jobs";
import { idleFor, holdForTruck } from "@/game/sim/haulers";
import { makeVehicle, vehicleStats } from "@/game/sim/world";
import { pileFootprint } from "@/game/piles";

test("selling or trading a loaded machine drops the ore on the ground", () => {
  const sold = freshGame("Sell");
  sold.cash = 1e6;
  ops(sold).story = 99;
  assert.equal(buyVehicle(sold, "truck"), "");
  const truck = sold.vehicles.find((v) => v.defId === "truck")!;
  truck.x = 10;
  truck.z = 40;
  truck.cargo = 9;
  truck.cargoOre = "iron";
  const before = sold.deposits.filter((d) => d.ore === "iron").reduce((n, d) => n + d.tons, 0);
  assert.equal(sellVehicle(sold, sold.vehicles.indexOf(truck)), "");
  const after = sold.deposits.filter((d) => d.ore === "iron").reduce((n, d) => n + d.tons, 0);
  assert.ok(after >= before + 8, `ore disappeared: ${before} -> ${after}`);
  assert.ok(sold.deposits.some((d) => d.kind === "pile" && d.ore === "iron" && Math.hypot(d.x - 10, d.z - 40) < 8));

  const traded = freshGame("Trade");
  traded.cash = 1e6;
  traded.tutorial.bought = true;
  ops(traded).story = 99;
  assert.equal(buyVehicle(traded, "truck"), "");
  const mine = traded.vehicles.find((v) => v.defId === "truck")!;
  traded.active = traded.vehicles.indexOf(mine);
  mine.cargo = 6;
  mine.cargoOre = "copper";
  mine.x = 4;
  mine.z = 42;
  const copper0 = traded.deposits.filter((d) => d.ore === "copper").reduce((n, d) => n + d.tons, 0);
  let tradedAway = false;
  for (let day = 0; day < 14 && !tradedAway; day++) {
    traded.market.day = day;
    ops(traded).lotTaken = { day, ids: [] };
    const btn = lotButtons(traded).find((b) => b.id.startsWith("lottrade:") && b.enabled && !b.id.endsWith(":truck"));
    if (!btn) continue;
    assert.equal(lotBuy(traded, btn.id.slice("lottrade:".length) as VehicleId, true), "");
    tradedAway = true;
  }
  assert.equal(tradedAway, true);
  const copper1 = traded.deposits.filter((d) => d.ore === "copper").reduce((n, d) => n + d.tons, 0);
  assert.ok(copper1 >= copper0 + 5, `trade ate the load: ${copper0} -> ${copper1}`);
  assert.ok(traded.deposits.some((d) => d.kind === "pile" && d.ore === "copper" && Math.hypot(d.x - 4, d.z - 42) < 8));
});

test("a plant pile that was already paid does not pay again after reload", () => {
  const s = freshGame("Paid");
  s.cash = 1e6;
  s.claims.push(4, 5, 6, 8);
  ops(s).story = 99;
  assert.equal(buyVehicle(s, "truck"), "");
  const t = s.vehicles.find((v) => v.defId === "truck")!;
  s.active = s.vehicles.indexOf(t);
  t.x = 2052;
  t.z = 50;
  t.cargo = 8;
  t.cargoOre = "gold";
  t.cargoPurity = 1;
  s.cash = 0;
  for (let i = 0; i < 20; i++) step(s, { throttle: 0, steer: 0, action: true }, 1 / 30, true);
  assert.ok(t.cargo < 0.05, "truck did not dump");
  assert.ok(s.cash > 1000, `dump was not paid: ${s.cash}`);
  const pile = s.deposits.find((d) => d.id.startsWith("feed-") && d.ore === "gold");
  assert.ok(pile && (pile.paidTons ?? 0) > 1, "paid tons were not stored on the pile");
  saveGame(s, true);
  const back = readSaveText(currentSaveText()!)!;
  ops(back).story = 99;
  const paid = back.deposits.find((d) => d.id.startsWith("feed-") && d.ore === "gold");
  assert.ok(paid && (paid.paidTons ?? 0) > 1, "paid tons did not survive the save");
  const c0 = back.cash;
  for (let i = 0; i < 30 * 12; i++) step(back, { throttle: 0, steer: 0, action: false }, 1 / 30, false);
  assert.ok(back.cash - c0 < 40, `feeder paid again: ${back.cash - c0}`);
});


test("regression: many dirt piles never teleport into a distant heap", () => {
  const state = freshGame("Local dirt");
  for (const x of [-65, -40, -15, 10]) {
    for (const z of [-65, -40, -15, 10]) addPile(state, "dirt", 2, x, z, 1);
  }
  const old = state.deposits.find((d) => d.kind === "pile" && d.ore === "dirt" && d.x === -65 && d.z === -65)!;
  assert.ok(old);
  const before = state.deposits.filter((d) => d.kind === "pile" && d.ore === "dirt").length;
  addPile(state, "dirt", 3, 70, 70, 1);
  assert.equal(state.deposits.filter((d) => d.kind === "pile" && d.ore === "dirt").length, before + 1);
  assert.equal(old.x, -65);
  assert.equal(old.z, -65);
});

test("regression: seated driver may scoop despite a hired crew work source", () => {
  const state = freshGame("Hand controls");
  const v = state.vehicles[state.active];
  const pile = state.deposits.find((d) => d.id === "starter")!;
  assert.ok(pile);
  v.workClaim = 3;
  assert.equal(acceptsJob(state, v, pile), true);
  state.watching = true;
  assert.equal(acceptsJob(state, v, pile), false);
});

test("regression: crew loader reaches pile from outside its physical footprint", () => {
  const state = freshGame("Pile approach");
  const v = makeVehicle("hloader", 3);
  const pile = state.deposits.find((d) => d.id === "starter")!;
  assert.ok(pile);
  state.vehicles.push(v);
  state.active = state.vehicles.indexOf(v);
  v.x = pile.x + 20;
  v.z = pile.z + 4;
  const stand = pileApproach(state, v, pile);
  const foot = pileFootprint(pile.tons);
  const body = vehicleStats(v).radius * 0.45;
  const norm = ((stand.x - pile.x) / (foot.rx + body)) ** 2 +
    ((stand.z - pile.z) / (foot.rz + body)) ** 2;
  assert.ok(norm > 1, "loader approach point is inside the solid pile");
  v.x = stand.x;
  v.z = stand.z;
  assert.equal(pileInReach(state, v)?.id, pile.id, "loader cannot scoop at approach point");
});

test("regression: waiting digger keeps its cargo instead of inventing dirt piles", () => {
  const state = freshGame("Hold load");
  const v = makeVehicle("loader", 3);
  v.cargo = 3;
  v.cargoOre = "dirt";
  state.vehicles.push(v);
  idleFor(state, v);
  state.seconds = 45;
  const count = state.deposits.length;
  holdForTruck(state, v);
  assert.equal(v.cargo, 3);
  assert.equal(v.cargoOre, "dirt");
  assert.equal(state.deposits.length, count);
});
