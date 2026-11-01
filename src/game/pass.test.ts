import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AXLE_BACK, PASS_SUMMIT_X, VALLEY_GATE_X, areaIn, stepHitch } from "./lowboy.ts";
import { homeTool } from "./controls.ts";
import { BRIDGE, X0 } from "./river.ts";
import { ensureLowboy, faceOf, freshGame, step, toggleDeck } from "@/game/sim";
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
    const faces = [...seen].filter((s) => /gold|silver/i.test(s));
    assert.ok(faces.length <= 1, `dozer swapped faces: ${[...seen].join(" | ")}`);
  });

  it("does not walk a dug quarry face into the cliff", () => {
    const state = freshGame("Face");
    const quarry = state.deposits.find((d) => d.id === "quarry");
    assert.ok(quarry);
    quarry.tons = 1;
    assert.ok(faceOf(quarry).x >= X0 - 76);
  });
});
