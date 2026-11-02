import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AXLE_BACK, PASS_SUMMIT_X, VALLEY_GATE_X, areaIn, stepHitch } from "./lowboy.ts";
import { homeTool } from "./controls.ts";
import { BRIDGE, X0 } from "./river.ts";
import { ensureLowboy, faceOf, freshGame, plannedPad, step, toggleDeck, buyClaim } from "@/game/sim";
import { readSaveText } from "@/game/save";
import type { VehicleState } from "@/game/types";

const ZERO = { throttle: 0, steer: 0, action: false };

function park(state: ReturnType<typeof freshGame>, defId: VehicleState["defId"], x: number, z: number, extra: Partial<VehicleState> = {}) {
  const v: VehicleState = { ...state.vehicles[0], uid: `${defId}-${state.vehicles.length}`, defId, tool: homeTool(defId), x, z, yaw: 0, speed: 0, cargo: 0, cargoOre: null, hired: false, operator: false, damage: 0, status: "Parked", ...extra };
  state.vehicles.push(v);
  return v;
}

function rigGame() {
  const state = freshGame("Pass");
  state.claims = [1, 4];
  ensureLowboy(state);
  const rig = state.vehicles.find((v) => v.defId === "lowboy");
  assert.ok(rig);
  state.active = state.vehicles.indexOf(rig);
  return { state, rig };
}

describe("the pass belongs to the ridge until the valley gate", () => {
  it("does not flip maps halfway along the road", () => {
    assert.equal(areaIn(PASS_SUMMIT_X, 96), "ridge");
    assert.equal(areaIn(900, 96), "ridge");
    assert.equal(areaIn(VALLEY_GATE_X + 5, 96), "river");
    assert.equal(areaIn(1040, 0), "river");
  });
});

describe("trailer articulation", () => {
  it("never swings more than the hitch allows", () => {
    let ax: number | undefined;
    let az: number | undefined;
    let x = 0;
    let z = 0;
    let yaw = 0;
    for (let i = 0; i < 200; i++) {
      yaw += 0.08;
      x += -Math.sin(yaw) * 0.6;
      z += -Math.cos(yaw) * 0.6;
      const h = stepHitch(x, z, yaw, ax, az);
      ax = h.axleX;
      az = h.axleZ;
      const rel = Math.abs(Math.atan2(Math.sin(h.trailerYaw - yaw), Math.cos(h.trailerYaw - yaw)));
      assert.ok(rel <= 1.151, `jackknifed ${rel}`);
      assert.ok(Math.abs(Math.hypot(ax - x, az - z) - AXLE_BACK) < 1.4);
    }
  });
});

describe("the bridge scale counts the lowboy deck", () => {
  function crossing(defId: VehicleState["defId"]) {
    const { state, rig } = rigGame();
    const m = park(state, defId, rig.x + 4, rig.z);
    assert.equal(toggleDeck(state), "");
    rig.x = BRIDGE.x - BRIDGE.halfLength - 1.5;
    rig.z = BRIDGE.z;
    rig.yaw = -Math.PI / 2;
    for (let i = 0; i < 60; i++) step(state, { throttle: 1, steer: 0, action: false }, 0.1, true);
    return { rig, m };
  }

  it("stops a lowboy carrying a dozer", () => {
    const { rig } = crossing("dozer");
    assert.ok(rig.x < BRIDGE.x - BRIDGE.halfLength + 0.5, `dozer load crossed, x=${rig.x}`);
  });

  it("lets a lowboy carrying a skid steer across", () => {
    const { rig, m } = crossing("skid");
    assert.ok(rig.x > BRIDGE.x + BRIDGE.halfLength, `light load should cross, x=${rig.x}`);
    assert.ok(Math.abs(m.x - rig.x) < 12);
  });
});

describe("summit and deck rules", () => {
  it("logs the summit once", () => {
    const { state, rig } = rigGame();
    rig.x = PASS_SUMMIT_X - 20;
    rig.z = 96;
    rig.yaw = -Math.PI / 2;
    for (let i = 0; i < 40; i++) step(state, { throttle: 1, steer: 0, action: false }, 0.1, true);
    for (let i = 0; i < 40; i++) step(state, { throttle: -1, steer: 0, action: false }, 0.1, true);
    assert.equal(state.log.filter((m) => m.includes("summit")).length, 1);
  });

  it("will not grab a machine a hired operator is working", () => {
    const { state, rig } = rigGame();
    park(state, "skid", rig.x + 4, rig.z, { hired: true, operator: true });
    assert.equal(toggleDeck(state), "Pull up to an empty parked machine.");
    assert.equal(state.deck.length, 0);
  });

  it("shoves parked machines off the deck instead of driving through them", () => {
    const { state, rig } = rigGame();
    rig.x = 200;
    rig.z = 96;
    rig.yaw = -Math.PI / 2;
    step(state, ZERO, 0.05, true);
    const behind = park(state, "pickup", rig.x - 4.5, rig.z);
    step(state, ZERO, 0.05, true);
    assert.ok(Math.abs(behind.z - rig.z) > 2 || Math.abs(behind.x - rig.x) > 8, "pickup is still inside the deck");
  });

  it("saves the trailer angle", () => {
    const { state, rig } = rigGame();
    rig.trailerYaw = 0.7;
    rig.axleX = rig.x + 3;
    rig.axleZ = rig.z + 5;
    const back = readSaveText(JSON.stringify({ ...state, version: 3 }));
    const lb = back?.vehicles.find((v) => v.defId === "lowboy");
    assert.equal(lb?.trailerYaw, 0.7);
  });
});

describe("watching the crew", () => {
  it("lets the operator drive the machine you are watching", () => {
    const state = freshGame("Watch");
    state.claims = [1, 2, 3, 4];
    const v = state.vehicles[0];
    v.defId = "skid";
    v.hired = true;
    v.operator = true;
    v.tool = homeTool("skid");
    const x0 = v.x;
    const z0 = v.z;
    state.watching = true;
    for (let i = 0; i < 90; i++) step(state, { throttle: 1, steer: 1, action: true }, 1 / 30, true);
    assert.ok(Math.hypot(v.x - x0, v.z - z0) > 1, "the crew should move the machine while you watch");
  });

  it("does not drive that machine while you are in the seat", () => {
    const state = freshGame("Seat");
    const v = state.vehicles[0];
    v.defId = "skid";
    v.hired = true;
    v.operator = true;
    v.tool = homeTool("skid");
    const x0 = v.x;
    const z0 = v.z;
    for (let i = 0; i < 40; i++) step(state, ZERO, 1 / 30, true);
    assert.ok(Math.hypot(v.x - x0, v.z - z0) < 0.25);
  });
});

describe("valley crew", () => {
  it("brings a skid steer back through the quarry gap instead of leaving it behind the cliff", () => {
    const state = freshGame("Gap");
    state.claims = [1, 5, 6];
    const v = state.vehicles[0];
    v.defId = "skid";
    v.tool = homeTool("skid");
    v.hired = true;
    v.operator = true;
    v.x = X0 - 100;
    v.z = 36;
    state.watching = true;
    for (let i = 0; i < 150; i++) step(state, ZERO, 1 / 30, true);
    assert.ok(v.x > X0 - 80, `skid still behind the cliff at x ${(v.x - X0).toFixed(1)}`);
  });

  it("keeps a dozer on one river face", () => {
    const state = freshGame("Dozer");
    state.claims = [1, 5];
    state.sluice = true;
    const gold = state.deposits.find((d) => d.id === "bar-gold");
    assert.ok(gold);
    const v = state.vehicles[0];
    v.defId = "dozer";
    v.tool = homeTool("dozer");
    v.hired = true;
    v.operator = true;
    v.x = gold.x;
    v.z = gold.z;
    state.watching = true;
    const seen = new Set<string>();
    for (let i = 0; i < 180; i++) {
      step(state, ZERO, 1 / 30, true);
      if (i > 20 && v.status) seen.add(v.status);
    }
    const ores = new Set<string>();
    for (const s of seen) {
      if (/gold/i.test(s)) ores.add("gold");
      if (/silver/i.test(s)) ores.add("silver");
    }
    assert.deepEqual([...ores], ["gold"]);
    assert.ok(Math.hypot(v.x - gold.x, v.z - gold.z) > 0.8, "dozer should drive the blade, not sit still");
  });

  it("drives a skid onto the deep bench instead of spinning beside it", () => {
    const state = freshGame("Deep");
    state.claims = [1, 4];
    state.watching = true;
    const iron = state.deposits.find((d) => d.id === "deep-iron");
    assert.ok(iron);
    const face = faceOf(iron);
    const v = state.vehicles[0];
    v.defId = "skid";
    v.tool = homeTool("skid");
    v.hired = true;
    v.operator = true;
    v.workClaim = 4;
    v.x = face.x + 7;
    v.z = face.z;
    v.yaw = 0;
    let spin = 0;
    for (let i = 0; i < 90; i++) {
      const y0 = v.yaw;
      step(state, ZERO, 1 / 30, true);
      spin += Math.abs(Math.atan2(Math.sin(v.yaw - y0), Math.cos(v.yaw - y0)));
    }
    const d = Math.hypot(v.x - face.x, v.z - face.z);
    assert.ok(d < 6.5, `still beside the bench, ${d.toFixed(1)} m out, ${v.status}`);
    assert.match(v.status, /Working|Breaking|Stripped/);
    assert.ok(spin < 5, `spun in place, ${spin.toFixed(1)} rad`);
  });

  it("sells river gold at the wash plant instead of parking on it", () => {
    const state = freshGame("Wash");
    state.claims = [1, 4, 5];
    state.washPlant = true;
    state.sluice = true;
    state.preferSluice = true;
    state.watching = true;
    const v = state.vehicles[0];
    v.hired = true;
    v.operator = true;
    v.x = 1000 + 58;
    v.z = 18;
    v.cargoOre = "gold";
    v.cargo = 2;
    const before = state.cash;
    for (let i = 0; i < 90; i++) step(state, ZERO, 1 / 30, true);
    assert.equal(v.cargo, 0, v.status);
    assert.ok(state.cash > before);
    assert.ok(!/sluice/i.test(v.status));
  });

  it("names the river faces after their leases", () => {
    const state = freshGame("Names");
    const sign = (id: string) => state.deposits.find((d) => d.id === id)?.sign;
    assert.equal(sign("silver-bar"), "RIVER BARS");
    assert.equal(sign("silver-north"), "RIVER BARS N");
    assert.equal(sign("bar-gold"), "RIVER BARS · GOLD");
    assert.equal(sign("quarry"), "VALLEY QUARRY");
    assert.equal(sign("east-rim"), "EAST RIM");
  });

  it("keeps the heavy haul off the bridge", () => {
    const state = freshGame("Heavy");
    state.claims = [1, 4, 5, 6];
    state.watching = true;
    const heavy = park(state, "heavy", X0 + 46, 20);
    heavy.hired = true;
    heavy.operator = true;
    heavy.cargoOre = "copper";
    heavy.cargo = 12;
    const digger = park(state, "excavator", X0 - 30, 4);
    digger.hired = true;
    digger.operator = true;
    digger.cargoOre = "copper";
    digger.cargo = 2;
    for (let i = 0; i < 30 * 10; i++) step(state, ZERO, 1 / 30, true);
    assert.ok(heavy.x > X0 + 20, `heavy headed for the bridge, x=${(heavy.x - X0).toFixed(1)} ${heavy.status}`);
    assert.ok(Math.abs(heavy.x - BRIDGE.x) > BRIDGE.halfLength);
  });

  it("does not walk a dug quarry face into the cliff", () => {
    const state = freshGame("Face");
    const quarry = state.deposits.find((d) => d.id === "quarry");
    assert.ok(quarry);
    quarry.tons = 1;
    assert.ok(faceOf(quarry).x >= X0 - 76);
  });

  it("leases the east rim only after the valley is open, and sells that copper at the rail", () => {
    const locked = freshGame("Rim");
    locked.cash = 200000;
    assert.match(buyClaim(locked, 7), /Deep bench/);
    locked.claims.push(4);
    assert.equal(buyClaim(locked, 7), "");
    assert.ok(locked.claims.includes(7));
    const rim = locked.deposits.find((d) => d.id === "east-rim");
    assert.ok(rim);
    assert.equal(rim.ore, "copper");
    assert.equal(rim.hard, true);
    rim.tons = 1;
    assert.ok(faceOf(rim).x <= X0 + 82);
    locked.sluice = true;
    locked.preferSluice = true;
    locked.washPlant = true;
    const heavy = park(locked, "heavy", X0 + 68, -18);
    heavy.cargoOre = "copper";
    heavy.cargo = 20;
    assert.equal(plannedPad(locked, locked.vehicles.indexOf(heavy)), "loadout");
  });

  it("takes a skid and a dump truck across the bridge without dancing or crawling", () => {
    const cross = (defId: "skid" | "truck", x: number, setup: (v: VehicleState) => void) => {
      const state = freshGame(defId);
      state.claims = [1, 4, 5, 6, 7];
      state.watching = true;
      state.washPlant = true;
      state.wet = 1;
      const v = park(state, defId, x, BRIDGE.z + 1.2);
      v.hired = true;
      v.operator = true;
      v.yaw = x > X0 ? Math.PI / 2 : -Math.PI / 2;
      setup(v);
      let flips = 0;
      let dir = 0;
      let prev = v.x;
      let slow = 0;
      let samples = 0;
      for (let i = 0; i < 30 * 18; i++) {
        step(state, ZERO, 1 / 30, true);
        const moved = v.x - prev;
        if (Math.abs(v.x - X0) < BRIDGE.halfLength + 2 && Math.abs(moved) > 0.02) {
          const s = Math.sign(moved);
          if (dir && s !== dir) flips += 1;
          dir = s;
          samples += 1;
          if (Math.abs(v.speed) < 2) slow += 1;
        }
        prev = v.x;
        if (Math.sign(v.x - X0) !== Math.sign(x - X0) && Math.abs(v.x - X0) > BRIDGE.halfLength + 4) break;
      }
      assert.ok(Math.sign(v.x - X0) !== Math.sign(x - X0), `${defId} never crossed, x=${(v.x - X0).toFixed(1)} ${v.status}`);
      assert.ok(flips < 3, `${defId} danced on the bridge ${flips} times`);
      assert.ok(samples === 0 || slow < samples * 0.5, `${defId} crawled ${slow}/${samples}`);
    };
    cross("skid", X0 + 20, (v) => {
      v.workClaim = 6;
    });
    cross("truck", X0 - 24, (v) => {
      v.cargoOre = "gold";
      v.cargo = 12;
    });
  });

  it("lets the player drive a skid across without the river stalling it", () => {
    const state = freshGame("Drive");
    state.claims = [1, 4, 5];
    state.watching = false;
    state.controlMode = "simple";
    const skid = park(state, "skid", X0 + 22, BRIDGE.z + 3);
    skid.yaw = Math.PI / 2;
    state.active = state.vehicles.indexOf(skid);
    let slow = 0;
    let samples = 0;
    for (let i = 0; i < 30 * 8; i++) {
      step(state, { throttle: 1, steer: 0, action: false }, 1 / 30, true);
      if (Math.abs(skid.x - X0) < 10) {
        samples += 1;
        if (skid.speed < 4) slow += 1;
      }
      if (skid.x < X0 - 16) break;
    }
    assert.ok(skid.x < X0 - 16, `skid stuck at x=${(skid.x - X0).toFixed(1)} spd=${skid.speed.toFixed(1)}`);
    assert.ok(slow < samples * 0.35, `stalled on the deck ${slow}/${samples}`);
  });

  it("holds a full dump truck on the bank instead of bouncing it on the lip", () => {
    const state = freshGame("Heavy truck");
    state.claims = [1, 4, 5];
    state.watching = false;
    state.controlMode = "simple";
    const truck = park(state, "truck", X0 + 16, BRIDGE.z);
    truck.yaw = Math.PI / 2;
    truck.cargoOre = "gold";
    truck.cargo = 22;
    state.active = state.vehicles.indexOf(truck);
    let inside = 0;
    for (let i = 0; i < 30 * 4; i++) {
      step(state, { throttle: 1, steer: 0, action: false }, 1 / 30, true);
      if (Math.abs(truck.x - X0) < BRIDGE.halfLength - 1) inside += 1;
    }
    assert.equal(inside, 0, "full truck drove onto the deck");
    assert.ok(truck.x > X0 + BRIDGE.halfLength, `truck ended inside, x=${(truck.x - X0).toFixed(1)}`);
    assert.match(truck.status, /heavy/i);
  });
});
