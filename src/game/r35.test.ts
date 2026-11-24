import { test } from "node:test";
import assert from "node:assert/strict";
import { PADS } from "@/game/catalog";
import { freshGame, step } from "@/game/sim";
import { addFeedPile, feedId, feedTick, markFeedPaid, PREPAID_FEED_RATE } from "@/game/sim/feed";
import { readSaveText, exportSave } from "@/game/save";
import { buyVehicle } from "@/game/sim";

const idle = { throttle: 0, steer: 0, action: false };
const sluice = PADS.find((p) => p.kind === "sluice")!;

test("already-paid sluice truck stock clears promptly, without paying or contracting twice", () => {
  const state = freshGame("Prepaid sluice");
  state.sluice = true;
  addFeedPile(state, sluice, "gold", 15, 1);
  const hopper = state.deposits.find((d) => d.id === feedId(sluice.id))!;
  markFeedPaid(hopper, 15);
  const cash = state.cash;
  const life = state.lifetime;
  const contract = structuredClone(state.contract);
  for (let t = 0; t < 6; t++) feedTick(state, 1, false, []);
  assert.equal(state.deposits.some((d) => d.id === hopper.id), false, "already paid material left in the hopper");
  assert.equal(state.cash, cash, "prepaid hopper paid again");
  assert.equal(state.lifetime, life);
  assert.deepEqual(state.contract, contract, "prepaid material counted toward contract again");
  assert.equal(PREPAID_FEED_RATE, 3);
});

test("mixed already-paid ore clears main and side stock without duplicating money", () => {
  const state = freshGame("Stock queue");
  state.sluice = true;
  addFeedPile(state, sluice, "gold", 24, 0.8);
  const gold = state.deposits.find((d) => d.id === feedId(sluice.id))!;
  markFeedPaid(gold, 24);
  addFeedPile(state, sluice, "copper", 12, 0.9);
  const side = state.deposits.find((d) => d.id === `${feedId(sluice.id)}--copper`)!;
  assert.ok(side, "mixed ore did not enter a separate queue");
  markFeedPaid(side, 12);
  const original = state.cash;
  for (let t = 0; t < 9; t++) feedTick(state, 1, false, []);
  assert.equal(state.deposits.some((d) => d.id.startsWith("feed-sluice")), false, "a paid side pile became stranded");
  assert.equal(state.cash, original, "a prepaid mixed-ore load was paid twice");
});

test("prepaid plant inventory survives saving and clears after reload without an extra payment", () => {
  const state = freshGame("Resume hopper");
  state.sluice = true;
  addFeedPile(state, sluice, "dirt", 10, 1);
  const pile = state.deposits.find((d) => d.id === feedId(sluice.id))!;
  markFeedPaid(pile, 10);
  const loaded = readSaveText(exportSave(state))!;
  const saved = loaded.deposits.find((d) => d.id === pile.id)!;
  assert.ok(saved && (saved.paidTons ?? 0) >= 10);
  const cash = loaded.cash;
  for (let i = 0; i < 5; i++) feedTick(loaded, 1, false, []);
  assert.equal(loaded.deposits.some((d) => d.id === pile.id), false);
  assert.equal(loaded.cash, cash);
});

test("loader is not automatically taken from digging to process truck-paid sluice stock", () => {
  const state = freshGame("Clear lanes");
  state.sluice = true;
  state.cash = 1_000_000;
  state.watching = true;
  state.feedLimit = 1;
  assert.equal(buyVehicle(state, "loader"), "");
  const loader = state.vehicles.find((v) => v.defId === "loader")!;
  loader.hired = true;
  loader.operator = true;
  loader.x = sluice.x + 25;
  loader.z = sluice.z + 10;
  addFeedPile(state, sluice, "gold", 30, 1);
  const pile = state.deposits.find((d) => d.id === feedId(sluice.id))!;
  markFeedPaid(pile, 30);
  for (let i = 0; i < 4; i++) step(state, idle, 1 / 60, true);
  assert.notEqual(loader.status, "Heading to feed the plant");
  assert.notEqual(loader.status, "Feeding the sluice");
});
