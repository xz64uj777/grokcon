import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { passPeaks } from "./lowboy.ts";
import { buyVehicle, freshGame, plannedPad, step, toggleCrew } from "./sim.ts";
import {
  BRIDGE,
  RIVER,
  WEST_BARGE,
  MUD_FLOOR,
  MUD_ZONES,
  X0,
  areaOf,
  boggedDown,
  bridgeAllows,
  bridgeDeckY,
  bridgeMaxLoad,
  crossingWorth,
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
  it("gives the dozer and the payloader room on a 32 t bridge", () => {
    assert.equal(BRIDGE.limit, 32);
    assert.ok(bridgeAllows("dozer", 0));
    assert.ok(bridgeAllows("loader", 8));
    assert.ok(crossingWorth("dozer", 0, 0));
    assert.ok(crossingWorth("loader", 8, 0));
  });
  it("does not plan a heavy-haul crossing", () => {
    assert.equal(crossingWorth("heavy", 40, 0), false);
    assert.equal(crossingWorth("heavy", 40, 20), false);
    assert.equal(crossingWorth("truck", 22, 0), true);
    assert.equal(crossingWorth("truck", 22, 20), true);
    assert.equal(crossingWorth("truck", 22, 22), false);
  });
  it("keeps the west barge in open water, off the bridge", () => {
    const deckWest = BRIDGE.x - BRIDGE.halfLength;
    const deckEast = BRIDGE.x + BRIDGE.halfLength;
    const deckSouth = BRIDGE.z - BRIDGE.halfWidth;
    const deckNorth = BRIDGE.z + BRIDGE.halfWidth;
    const hits = (x: number, z: number, r: number) => {
      const nx = Math.max(deckWest, Math.min(x, deckEast));
      const nz = Math.max(deckSouth, Math.min(z, deckNorth));
      return Math.hypot(x - nx, z - nz) < r;
    };
    assert.equal(hits(WEST_BARGE.x, WEST_BARGE.z, WEST_BARGE.r), false, "sell ring overlaps the deck");
    assert.ok(WEST_BARGE.x + WEST_BARGE.r < RIVER.x - RIVER.halfWidth, "sell ring is in the water");
    const hullSouth = WEST_BARGE.z - 8;
    const hullNorth = WEST_BARGE.z + 8;
    const hullWest = WEST_BARGE.hullX - 3.5;
    const hullEast = WEST_BARGE.hullX + 3.5;
    assert.equal(hullNorth < deckSouth || hullSouth > deckNorth || hullEast < deckWest || hullWest > deckEast, true, "hull covers the bridge");
    assert.ok(hullWest > RIVER.x - RIVER.halfWidth - 1, "hull is on the bank");
    assert.ok(hullEast < RIVER.x + RIVER.halfWidth, "hull leaves the river");
    for (const peak of passPeaks()) {
      const rz = peak.r * 0.85;
      const onHull = ((peak.x - WEST_BARGE.hullX) / peak.r) ** 2 + ((peak.z - WEST_BARGE.z) / rz) ** 2 < 1;
      const onPad = Math.hypot(peak.x - WEST_BARGE.x, peak.z - WEST_BARGE.z) < peak.r * 0.9 + WEST_BARGE.r;
      assert.equal(onHull || onPad, false, `mountain covers the barge at ${peak.x}, ${peak.z}`);
    }
  });

  it("knows where the deck is, and the deck isn't river", () => {
    assert.ok(onBridge(BRIDGE.x, BRIDGE.z));
    assert.ok(!onBridge(BRIDGE.x, BRIDGE.z + 20));
    assert.ok(!inRiver(BRIDGE.x, BRIDGE.z));
    assert.ok(inRiver(BRIDGE.x, BRIDGE.z + 20));
  });
  it("puts the deck above the water and keeps the crossing firm in the rain", () => {
    assert.ok(bridgeDeckY(BRIDGE.x, BRIDGE.z) > 1);
    assert.equal(bridgeDeckY(BRIDGE.x + 40, BRIDGE.z), 0);
    assert.equal(bridgeDeckY(BRIDGE.x, BRIDGE.z + 20), 0);
    assert.ok(bridgeDeckY(BRIDGE.x + 11, BRIDGE.z) > 0.2, "ramp is still up part way");
    assert.equal(mudDepth(BRIDGE.x + 14, BRIDGE.z, 1), 0);
    assert.ok(mudDepth(X0 - 12, -30, 1) > 0.4);
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

describe("river crew", () => {
  it("sells east-bank dirt at the rail, not the west barge", () => {
    const s = freshGame("Dirt");
    s.claims = [1, 4, 5];
    s.washPlant = true;
    const v = s.vehicles[0];
    v.x = X0 + 40;
    v.z = 20;
    v.cargoOre = "dirt";
    v.cargo = 2;
    assert.equal(plannedPad(s, 0), "loadout");
  });

  it("a hired skid and excavator dig the river bars instead of sitting", () => {
    const s = freshGame("Crew");
    s.cash = 1e6;
    s.claims = [1, 4, 5, 6, 7];
    s.sluice = true;
    s.preferSluice = true;
    s.washPlant = true;
    s.watching = true;
    buyVehicle(s, "skid");
    buyVehicle(s, "excavator");
    for (const v of s.vehicles) {
      if (v.defId !== "skid" && v.defId !== "excavator") continue;
      v.x = X0 + 42;
      v.z = 46;
      toggleCrew(s, s.vehicles.indexOf(v));
    }
    const skid = s.vehicles.find((v) => v.defId === "skid")!;
    const ex = s.vehicles.find((v) => v.defId === "excavator")!;
    const input = { throttle: 0, steer: 0, action: false };
    let dug = false;
    for (let i = 0; i < 30 * 24; i++) {
      step(s, input, 1 / 30, false);
      if (skid.cargo > 0.4 && ex.cargo > 0.2) {
        dug = true;
        break;
      }
    }
    assert.ok(dug, `skid ${skid.cargo.toFixed(2)} ${skid.status} / excavator ${ex.cargo.toFixed(2)} ${ex.status}`);
  });

  it("fills the dump and the heavy from the river bars instead of selling the bucket at the wash", () => {
    const s = freshGame("Fill");
    s.cash = 1e6;
    s.claims = [1, 4, 5];
    s.washPlant = true;
    s.watching = true;
    buyVehicle(s, "loader");
    buyVehicle(s, "excavator");
    buyVehicle(s, "truck");
    buyVehicle(s, "heavy");
    const bar = s.deposits.find((d) => d.id === "silver-bar")!;
    const ex = s.vehicles.find((v) => v.defId === "excavator")!;
    const loader = s.vehicles.find((v) => v.defId === "loader")!;
    const truck = s.vehicles.find((v) => v.defId === "truck")!;
    const heavy = s.vehicles.find((v) => v.defId === "heavy")!;
    for (const v of [ex, loader, truck, heavy]) toggleCrew(s, s.vehicles.indexOf(v));
    ex.x = bar.x;
    ex.z = bar.z + 6;
    ex.cargo = 3;
    ex.cargoOre = "silver";
    loader.x = bar.x + 6;
    loader.z = bar.z;
    loader.cargo = 7.6;
    loader.cargoOre = "silver";
    truck.x = bar.x - 12;
    truck.z = bar.z + 4;
    heavy.x = bar.x + 4;
    heavy.z = bar.z - 12;
    const input = { throttle: 0, steer: 0, action: false };
    for (let i = 0; i < 30 * 20; i++) step(s, input, 1 / 30, false);
    const hauled = truck.cargo + heavy.cargo;
    assert.ok(hauled > 2, `truck ${truck.cargo.toFixed(1)} (${truck.status}) heavy ${heavy.cargo.toFixed(1)} (${heavy.status}) ex ${ex.status} loader ${loader.status}`);
  });
});
