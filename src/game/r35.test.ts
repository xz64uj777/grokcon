import { test } from "node:test";
import assert from "node:assert/strict";
import { X0, inChannel } from "@/game/river";
import { addPile } from "@/game/sim/feed";
import { buyVehicle, freshGame, sellVehicle, step, toggleCrew } from "@/game/sim";
import { currentSaveText, readSaveText, saveGame } from "@/game/save";
import { ops } from "@/game/ops";

test("dirt dumped in the river is set on the nearest bank", () => {
  const s = freshGame("Dump");
  addPile(s, "dirt", 8, X0, -40, 1, 1);
  const pile = s.deposits.find((d) => d.id.startsWith("pile-") && d.ore === "dirt");
  assert.ok(pile);
  assert.equal(inChannel(pile.x, pile.z), false);
  assert.ok(pile.x > X0);
});

test("a sold load that was over the water is left on the bank", () => {
  const s = freshGame("Sell");
  s.cash = 1e6;
  ops(s).story = 99;
  assert.equal(buyVehicle(s, "truck"), "");
  const truck = s.vehicles.find((v) => v.defId === "truck")!;
  truck.x = X0;
  truck.z = -30;
  truck.cargo = 6;
  truck.cargoOre = "dirt";
  assert.equal(sellVehicle(s, s.vehicles.indexOf(truck)), "");
  const pile = s.deposits.find((d) => d.kind === "pile" && d.ore === "dirt" && d.tons >= 5);
  assert.ok(pile);
  assert.equal(inChannel(pile.x, pile.z), false);
});

test("an old save pulls a river pile and the machines onto the bank, and the crew stays out", () => {
  const s = freshGame("Old");
  s.cash = 1e6;
  s.claims.push(4, 5);
  ops(s).story = 99;
  assert.equal(buyVehicle(s, "loader"), "");
  assert.equal(buyVehicle(s, "truck"), "");
  const loader = s.vehicles.find((v) => v.defId === "loader")!;
  const truck = s.vehicles.find((v) => v.defId === "truck")!;
  loader.x = X0;
  loader.z = -36;
  truck.x = X0 - 20;
  truck.z = -36;
  s.deposits.push({
    id: "pile-river",
    kind: "pile",
    ore: "dirt",
    tons: 12,
    max: 12,
    x: X0,
    z: -36,
    regen: 0,
    claim: 1,
    radius: 6,
    sign: "DIRT",
    purity: 1,
    overburden: 0,
    grade: 1,
    stress: 0,
    bench: 1,
    benchProgress: 0,
    hard: false,
    tested: true,
    lastBlastDay: -1,
  });
  saveGame(s, true);
  const back = readSaveText(currentSaveText()!)!;
  const pile = back.deposits.find((d) => d.id === "pile-river")!;
  const savedLoader = back.vehicles.find((v) => v.defId === "loader")!;
  assert.equal(inChannel(pile.x, pile.z), false);
  assert.equal(inChannel(savedLoader.x, savedLoader.z), false);
  ops(back).story = 99;
  back.watching = true;
  toggleCrew(back, back.vehicles.indexOf(savedLoader));
  toggleCrew(back, back.vehicles.indexOf(back.vehicles.find((v) => v.defId === "truck")!));
  let yanked = 0;
  for (let i = 0; i < 30 * 4; i++) {
    step(back, { throttle: 0, steer: 0, action: false }, 1 / 30, false);
    for (const v of back.vehicles) {
      if (v.defId === "crusher") continue;
      if (inChannel(v.x, v.z) || v.status === "Back on the bank") yanked += 1;
    }
  }
  assert.equal(yanked, 0);
});
