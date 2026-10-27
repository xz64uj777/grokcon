import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DAY_SECONDS, MAX_MULT, MIN_MULT, advanceMarket, freshMarket, priceMult, recordSale, trend } from "./market.ts";

const KEYS = ["crusher:iron", "crusher:copper", "sluice:gold"];

describe("daily ore prices", () => {
  it("stay between half and double for a long run", () => {
    const m = freshMarket(1234, KEYS);
    for (let d = 1; d < 2000; d++) {
      advanceMarket(m, d * DAY_SECONDS, KEYS);
      for (const k of KEYS) {
        assert.ok(m.mult[k] >= MIN_MULT && m.mult[k] <= MAX_MULT);
      }
    }
  });
  it("only change when a new day starts", () => {
    const m = freshMarket(7, KEYS);
    assert.equal(advanceMarket(m, DAY_SECONDS - 1, KEYS), false);
    assert.equal(advanceMarket(m, DAY_SECONDS + 1, KEYS), true);
    assert.equal(advanceMarket(m, DAY_SECONDS + 2, KEYS), false);
  });
  it("are the same for the same seed", () => {
    const a = freshMarket(99, KEYS);
    const b = freshMarket(99, KEYS);
    advanceMarket(a, DAY_SECONDS * 3, KEYS);
    advanceMarket(b, DAY_SECONDS * 3, KEYS);
    assert.deepEqual(a.mult, b.mult);
  });
  it("actually move and show a trend", () => {
    const m = freshMarket(5, KEYS);
    let moved = 0;
    for (let d = 1; d < 30; d++) {
      advanceMarket(m, d * DAY_SECONDS, KEYS);
      if (trend(m, "crusher", "iron") !== "flat") moved++;
    }
    assert.ok(moved > 10);
  });
  it("dip a little when a big load is sold, and recover next day", () => {
    const m = freshMarket(5, KEYS);
    const before = priceMult(m, "crusher", "iron");
    recordSale(m, "crusher", "iron", 40);
    assert.ok(priceMult(m, "crusher", "iron") < before);
    advanceMarket(m, DAY_SECONDS, KEYS);
    assert.equal(m.glut["crusher:iron"], undefined);
  });
});
