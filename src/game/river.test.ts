import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE,
  MUD_FLOOR,
  MUD_ZONES,
  X0,
  areaOf,
  boggedDown,
  bridgeAllows,
  bridgeMaxLoad,
  grossTons,
  inRiver,
  mudDepth,
  mudSpeedFactor,
  onBridge,
  rainAt,
  rainSpell,
  stepWet,
} from "./river.ts";

describe("areas", () => {
  it("splits the world into the ridge and the valley", () => {
    assert.equal(areaOf(0), "ridge");
    assert.equal(areaOf(-90), "ridge");
    assert.equal(areaOf(X0), "river");
    assert.equal(areaOf(X0 - 90), "river");
  });
});

describe("bridge", () => {
  it("lets an empty dump truck over but stops a full one", () => {
    assert.ok(bridgeAllows("truck", 0));
    assert.ok(bridgeAllows("truck", bridgeMaxLoad("truck")));
    assert.ok(!bridgeAllows("truck", 22));
    assert.equal(grossTons("truck", 22), 34);
  });
  it("tells you how much a machine can carry over", () => {
    assert.equal(bridgeMaxLoad("truck"), BRIDGE.limit - 12);
    assert.ok(bridgeMaxLoad("heavy") < 40, "the heavy hauler can't cross full");
  });
  it("lets every machine cross empty except the track crusher", () => {
    for (const id of ["pickup", "skid", "dozer", "loader", "truck", "excavator", "heavy"]) assert.ok(bridgeAllows(id, 0), id);
    assert.ok(!bridgeAllows("crusher", 0));
  });
  it("knows where the deck is, and the deck isn't river", () => {
    assert.ok(onBridge(BRIDGE.x, BRIDGE.z));
    assert.ok(!onBridge(BRIDGE.x, BRIDGE.z + 20));
    assert.ok(!inRiver(BRIDGE.x, BRIDGE.z));
    assert.ok(inRiver(BRIDGE.x, BRIDGE.z + 20));
  });
});

describe("mud", () => {
  const bank = MUD_ZONES[0];
  it("is soft on the river banks and firm away from them", () => {
    assert.ok(mudDepth(bank.x, bank.z, 0) > 0.4);
    assert.equal(mudDepth(X0 + 60, 60, 0), 0);
    assert.equal(mudDepth(0, 0, 1), 0, "no mud on the ridge");
  });
  it("gets deeper and wider when the ground is wet", () => {
    assert.ok(mudDepth(bank.x, bank.z, 1) > mudDepth(bank.x, bank.z, 0));
    const edge = bank.x + bank.rx * 1.2;
    assert.equal(mudDepth(edge, bank.z, 0), 0);
    assert.ok(mudDepth(edge, bank.z, 1) > 0);
  });
  it("floods the low ground only in the rain", () => {
    const flood = MUD_ZONES.find((m) => m.flood)!;
    assert.equal(mudDepth(flood.x, flood.z, 0), 0);
    assert.ok(mudDepth(flood.x, flood.z, 1) > 0.5);
  });
  it("slows wheels more than tracks", () => {
    assert.ok(mudSpeedFactor("dozer", 0.7) > mudSpeedFactor("loader", 0.7));
    assert.ok(mudSpeedFactor("excavator", 0.7) > mudSpeedFactor("truck", 0.7));
    assert.equal(mudSpeedFactor("truck", 0), 1);
  });
  it("never traps a machine for good", () => {
    for (const id of ["pickup", "skid", "loader", "truck", "heavy", "dozer", "excavator"]) {
      for (let d = 0; d <= 1; d += 0.05) assert.ok(mudSpeedFactor(id, d) >= MUD_FLOOR, `${id} at ${d}`);
    }
  });
  it("bogs wheels in deep mud but not tracks", () => {
    assert.ok(boggedDown("truck", 0.9));
    assert.ok(!boggedDown("dozer", 0.9));
    assert.ok(!boggedDown("truck", 0.5));
  });
});

describe("rain", () => {
  it("is the same for the same save every time", () => {
    for (const t of [0, 400, 777, 1500, 3333]) assert.equal(rainAt(42, t), rainAt(42, t));
  });
  it("keeps the first day dry", () => {
    for (let t = 0; t < 300; t += 5) assert.equal(rainAt(1234, t), 0);
  });
  it("rains on some days and not others", () => {
    let wet = 0;
    for (let day = 1; day <= 40; day++) if (rainSpell(99, day)) wet++;
    assert.ok(wet > 5 && wet < 35, `rain days ${wet}`);
  });
  it("stays between 0 and 1 and fades in and out", () => {
    const s = (() => {
      for (let d = 1; d < 50; d++) {
        const sp = rainSpell(7, d);
        if (sp) return { d, sp };
      }
      throw new Error("no rain");
    })();
    const t0 = s.d * 300 + s.sp.start;
    assert.ok(rainAt(7, t0 + 1) < rainAt(7, t0 + 20));
    for (let t = t0; t < s.d * 300 + s.sp.end; t += 3) {
      const r = rainAt(7, t);
      assert.ok(r >= 0 && r <= 1);
    }
  });
  it("soaks the ground fast and dries it slowly", () => {
    let wet = 0;
    for (let i = 0; i < 60; i++) wet = stepWet(wet, 1, 1);
    assert.ok(wet > 0.8, `soaked ${wet}`);
    let dry = wet;
    for (let i = 0; i < 60; i++) dry = stepWet(dry, 0, 1);
    assert.ok(dry > 0.4 && dry < wet, `drying ${dry}`);
    for (let i = 0; i < 400; i++) dry = stepWet(dry, 0, 1);
    assert.equal(dry, 0);
  });
});
