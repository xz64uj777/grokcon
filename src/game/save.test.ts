import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOreId } from "@/game/catalog";
import { freshGame } from "@/game/sim";
import { readSaveText } from "@/game/save";
import type { Deposit } from "@/game/types";

describe("silver survives a reload", () => {
  it("treats silver as an ore", () => {
    assert.equal(isOreId("silver"), true);
  });

  it("round-trips a silver pile, a loaded truck, and a silver contract", () => {
    const state = freshGame("Silver Test");
    state.claims = [1, 5];
    state.washPlant = true;
    state.contract = { ore: "silver", delivered: 3, need: 8, bonus: 960 };
    state.contractSeq = 4;
    const truck = state.vehicles[0];
    truck.cargoOre = "silver";
    truck.cargo = 1.5;
    truck.cargoPurity = 0.9;
    const pile: Deposit = {
      id: "pile-silver-test",
      kind: "pile",
      ore: "silver",
      tons: 12,
      max: 12,
      x: 1020,
      z: 10,
      regen: 0,
      claim: 5,
      radius: 6,
      sign: "PILE",
      purity: 0.88,
      overburden: 0,
      grade: 0.88,
      stress: 0,
      bench: 1,
      benchProgress: 0,
      hard: false,
      tested: true,
      lastBlastDay: -1,
    };
    state.deposits.push(pile);

    const loaded = readSaveText(JSON.stringify(state));
    assert.ok(loaded);
    assert.equal(loaded.vehicles[0].cargoOre, "silver");
    assert.equal(loaded.vehicles[0].cargo, 1.5);
    assert.equal(loaded.contract.ore, "silver");
    assert.equal(loaded.contract.delivered, 3);
    assert.equal(loaded.contract.bonus, 960);
    const back = loaded.deposits.find((d) => d.id === "pile-silver-test");
    assert.ok(back);
    assert.equal(back.ore, "silver");
    assert.equal(back.tons, 12);
  });
});

describe("bought assets outweigh an older backup", () => {
  it("a save after buying the wash plant beats the backup from before", async () => {
    const { bookWorth } = await import("@/game/save");
    const { buyWashPlant, buyUpgrade } = await import("@/game/sim");
    const before = freshGame("Worth Test");
    before.claims = [1, 4, 5];
    before.cash = 150000;
    const after = structuredClone(before);
    assert.equal(buyWashPlant(after), "");
    assert.equal(after.washPlant, true);
    assert.ok(bookWorth(after) >= bookWorth(before), "wash plant purchase must not lose to the backup");
    const upgraded = structuredClone(after);
    buyUpgrade(upgraded, 0, "engine");
    assert.ok(bookWorth(upgraded) >= bookWorth(after), "upgrade purchase must not lose to the backup");
  });
});
