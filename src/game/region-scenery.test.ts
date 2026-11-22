import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { needsDistantScenery } from "@/game/region-scenery";

describe("regional graphics initialization", () => {
  const fresh = { claims: [1], vehicles: [{ x: 0 }, { x: 34 }] };

  it("does not build either distant area for a new ridge company", () => {
    assert.equal(needsDistantScenery(fresh, "river"), false);
    assert.equal(needsDistantScenery(fresh, "mountain"), false);
  });

  it("prepares the river as soon as its pass claim is owned", () => {
    const unlocked = { ...fresh, claims: [1, 4] };
    assert.equal(needsDistantScenery(unlocked, "river"), true);
    assert.equal(needsDistantScenery(unlocked, "mountain"), false);
  });

  it("prepares the mountain when the quarry/rim is leased or its claim is owned", () => {
    for (const claims of [[1, 6], [1, 7], [1, 8]]) {
      assert.equal(needsDistantScenery({ ...fresh, claims }, "mountain"), true);
    }
  });

  it("recovers scenery for imported saves with vehicles in distant areas", () => {
    for (const [x, area] of [[1000, "river"], [2000, "mountain"]] as const) {
      assert.equal(needsDistantScenery({ ...fresh, vehicles: [{ x }] }, area), true);
    }
    assert.equal(needsDistantScenery({ ...fresh, vehicles: [{ x: 0 }] }, "river"), false);
  });
});
