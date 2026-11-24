import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOreId } from "@/game/catalog";
import { buyVehicle, freshGame, sellVehicle } from "@/game/sim";
import { bookWorth, loadGame, readSaveText, saveGame } from "@/game/save";
import { ops } from "@/game/ops";
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

/** Simulates browser localStorage without leaking state into other tests. */
async function withStorage(run: (entries: Map<string, string>) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    await run(entries);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

describe("save order and recovery", () => {
  it("keeps the latest save after selling expensive equipment", () => withStorage(async () => {
    const state = freshGame("Equipment sale");
    state.cash = 1_000_000;
    ops(state).story = 99;
    assert.equal(buyVehicle(state, "truck"), "");
    await saveGame(state, true);
    const beforeSale = bookWorth(state);
    const index = state.vehicles.findIndex((v) => v.defId === "truck");
    assert.equal(sellVehicle(state, index), "");
    assert.ok(bookWorth(state) < beforeSale, "sale reduces book worth");
    await saveGame(state);
    const loaded = loadGame();
    assert.ok(loaded);
    assert.equal(loaded.vehicles.some((v) => v.defId === "truck"), false);
    assert.equal(loaded.cash, state.cash);
  }));

  it("preserves the second truck even when its higher purchase price reduces book worth", () => withStorage(async () => {
    const state = freshGame("Two trucks");
    state.cash = 1_000_000;
    ops(state).story = 99;
    assert.equal(buyVehicle(state, "truck"), "");
    await saveGame(state, true);
    const beforeSecond = bookWorth(state);
    assert.equal(buyVehicle(state, "truck"), "");
    assert.ok(bookWorth(state) < beforeSecond, "premium for second machine reduces book worth");
    await saveGame(state);
    const loaded = loadGame();
    assert.ok(loaded);
    assert.equal(loaded.vehicles.filter((v) => v.defId === "truck").length, 2);
    assert.equal(loaded.cash, state.cash);
  }));

  it("does not resurrect a richer old company after starting a new claim", () => withStorage(async (storage) => {
    const old = freshGame("Old company");
    old.cash = 850_000;
    old.lifetime = 2_000_000;
    await saveGame(old, true);
    old.cash -= 100;
    await saveGame(old);
    assert.ok(storage.has("ridge-ore.save.bak"));

    const next = freshGame("New company");
    next.saveRevision = old.saveRevision;
    await saveGame(next, true);
    assert.equal(storage.has("ridge-ore.save.bak"), false);
    const loaded = loadGame();
    assert.ok(loaded);
    assert.equal(loaded.company, "New company");
    assert.equal(loaded.cash, next.cash);
    assert.ok((loaded.saveRevision ?? 0) > (old.saveRevision ?? 0));
  }));

  it("falls back to the last valid backup when the current save is corrupted", () => withStorage(async (storage) => {
    const state = freshGame("Recovery");
    state.cash = 123_456;
    await saveGame(state, true);
    state.cash = 654_321;
    await saveGame(state);
    storage.set("ridge-ore.save", "{corrupted");
    const recovered = loadGame();
    assert.ok(recovered);
    assert.equal(recovered.cash, 123_456);
  }));

  it("loads older save formats with no revision", () => {
    const old = freshGame("Legacy");
    const saved = readSaveText(JSON.stringify(old));
    assert.ok(saved);
    assert.equal(saved.saveRevision, 0);
  });
});

describe("save safety", () => {
  it("rejects incomplete files and files without a valid fleet", () => {
    const complete = freshGame("Valid career");
    for (const version of [1, 2, 3, 4]) {
      assert.equal(readSaveText(JSON.stringify({ version })), null);
      assert.equal(readSaveText(JSON.stringify({ ...complete, version, vehicles: [] })), null);
      assert.equal(readSaveText(JSON.stringify({ ...complete, version, vehicles: [{ defId: "unknown" }] })), null);
      assert.equal(readSaveText(JSON.stringify({ ...complete, version, deposits: undefined })), null);
      assert.equal(readSaveText(JSON.stringify({ ...complete, version }))?.company, complete.company);
    }
  });

  it("leaves the newer career and its backup untouched when a stale tab writes", () => withStorage(async (storage) => {
    await saveGame(freshGame("Two tabs"));
    const first = loadGame()!;
    const stale = loadGame()!;
    first.cash += 12_345;
    await saveGame(first);
    const before = new Map(storage);

    stale.cash += 100;
    assert.equal(await saveGame(stale), "conflict");
    assert.deepEqual(storage, before);
    assert.equal(loadGame()?.cash, first.cash);
  }));

  it("keeps the prior career as the recovery copy after an explicit import", () => withStorage(async (storage) => {
    const current = freshGame("Current career");
    assert.equal(await saveGame(current), "saved");
    const imported = freshGame("Imported career");
    imported.saveRevision = Number.MAX_SAFE_INTEGER - 100;

    assert.equal(await saveGame(imported, false, current), "saved");
    assert.equal(loadGame()?.company, imported.company);
    assert.equal(readSaveText(storage.get("ridge-ore.save.bak")!)?.company, current.company);
    assert.ok(imported.saveRevision! < Number.MAX_SAFE_INTEGER - 100);
  }));

  it("writes overlapping saves from the same tab in the order they were captured", () => withStorage(async (storage) => {
    const state = freshGame("Autosave");
    state.cash = 400;
    const first = saveGame(state);
    state.cash = 500;
    const second = saveGame(state);
    state.cash = 600;

    assert.deepEqual(await Promise.all([first, second]), ["saved", "saved"]);
    assert.equal(loadGame()?.cash, 500);
    assert.equal(readSaveText(storage.get("ridge-ore.save.bak")!)?.cash, 400);
  }));

  it("does not report success or advance the base revision when neither store accepts a save", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => { throw new Error("Storage quota exceeded"); },
      },
    });
    const state = freshGame("Storage unavailable");
    try {
      assert.equal(await saveGame(state), "unavailable");
      assert.equal(state.saveRevision, undefined);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
