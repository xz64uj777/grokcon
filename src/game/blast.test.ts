import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homeTool, sticksToCommand } from "./controls.ts";
import { BLAST_RADIUS } from "./mining.ts";
import { RIVER, X0, inRiver } from "./river.ts";
import {
  blastEscapeTarget,
  buySluicePlant,
  buyWashPlant,
  contractUnit,
  faceOf,
  freshGame,
  startBlast,
  step,
} from "@/game/sim";
import type { VehicleState } from "@/game/types";

const ZERO = { throttle: 0, steer: 0, action: false };

function park(state: ReturnType<typeof freshGame>, defId: VehicleState["defId"], x: number, z: number) {
  const v: VehicleState = {
    ...state.vehicles[0],
    uid: `${defId}-test`,
    defId,
    tool: homeTool(defId),
    x,
    z,
    yaw: 0,
    speed: 0,
    cargo: 0,
    cargoOre: null,
    hired: false,
    operator: false,
    damage: 0,
    status: "Parked",
  };
  state.vehicles.push(v);
  return v;
}

describe("valley blasts", () => {
  it("drops loose ore toward the bridge, not into the west cliff", () => {
    const state = freshGame("Blast");
    state.cash = 5000;
    state.claims = [1, 5, 6];
    const quarry = state.deposits.find((d) => d.id === "quarry");
    assert.ok(quarry);
    const face = faceOf(quarry);
    const player = state.vehicles[0];
    player.x = face.x;
    player.z = face.z;
    player.speed = 0;
    assert.equal(startBlast(state), "");
    for (let i = 0; i < 80; i++) step(state, ZERO, 0.25, true);
    assert.equal(state.blast, null);
    const pile = state.deposits.find((d) => d.kind === "pile" && d.ore === "copper" && d.x > 500);
    assert.ok(pile, "quarry blast should leave a copper pile in the valley");
    assert.ok(pile.x > face.x, "pile should land toward the bridge, east of the face");
    assert.ok(pile.x > X0 - 84, "pile should not sit inside the west cliff");
    assert.equal(inRiver(pile.x, pile.z), false);
  });

  it("pulls a machine off the river bank instead of blowing it up for standing in the water", () => {
    const state = freshGame("Evac");
    state.cash = 5000;
    state.claims = [1, 5];
    const bar = state.deposits.find((d) => d.id === "silver-bar");
    assert.ok(bar);
    const face = faceOf(bar);
    const player = state.vehicles[0];
    player.x = face.x;
    player.z = face.z;
    player.speed = 0;
    // East of the face is toward the river. A straight flee drives into the water.
    const crew = park(state, "excavator", face.x + 5, face.z);
    const straight = { x: face.x + (crew.x - face.x) * 8, z: face.z };
    assert.equal(inRiver(straight.x, straight.z) || straight.x > RIVER.x - RIVER.halfWidth, true);
    const escape = blastEscapeTarget(face, crew);
    assert.ok(escape, "there is a way out along the bank");
    assert.equal(inRiver(escape.x, escape.z), false);
    assert.ok(escape.x < RIVER.x - RIVER.halfWidth);
    assert.ok(Math.hypot(escape.x - face.x, escape.z - face.z) > BLAST_RADIUS);

    assert.equal(startBlast(state), "");
    for (let i = 0; i < 90; i++) step(state, ZERO, 0.25, true);
    assert.equal(state.blast, null);
    assert.equal(crew.damage, 0);
    assert.ok(Math.hypot(crew.x - face.x, crew.z - face.z) >= BLAST_RADIUS);
  });

  it("prices a silver contract off the crusher until the wash plant exists", () => {
    assert.equal(contractUnit("silver", { sluice: false, washPlant: false }), 60);
    assert.equal(contractUnit("silver", { sluice: false, washPlant: true }), 420);
    assert.equal(contractUnit("gold", { sluice: false, washPlant: false }), 140);
    assert.equal(contractUnit("gold", { sluice: true, washPlant: false }), 300);
    const state = freshGame("Books");
    state.cash = 100000;
    state.claims = [1, 4, 5];
    state.contract = { ore: "silver", delivered: 1, need: 8, bonus: 240 };
    assert.equal(buyWashPlant(state), "");
    assert.equal(state.contract.bonus, Math.round(8 * 420 * 0.5));
    state.contract = { ore: "gold", delivered: 0, need: 4, bonus: 280 };
    assert.equal(buySluicePlant(state), "");
    assert.equal(state.contract.bonus, Math.round(4 * 300 * 0.5));
  });
});

describe("stick playtest", () => {
  it("a slow skid curl fills the bucket, a parked excavator does not drive, and the truck bed rises", () => {
    const state = freshGame("Sticks");
    state.controlMode = "real";
    const pile = state.deposits.find((d) => d.id === "starter");
    assert.ok(pile);
    const skid = park(state, "skid", pile.x, pile.z);
    state.active = state.vehicles.indexOf(skid);
    const curl = sticksToCommand("skid", { x: 0, y: 0.2 }, { x: -0.5, y: -1 });
    for (let i = 0; i < 40; i++) step(state, { ...ZERO, cmd: curl }, 0.05, true);
    assert.ok(skid.cargo > 0.2, `skid bucket stayed empty (${skid.cargo})`);

    const ex = park(state, "excavator", 10, 40);
    state.active = state.vehicles.indexOf(ex);
    const before = { x: ex.x, z: ex.z };
    const parked = sticksToCommand("excavator", { x: 1, y: 1 }, { x: 0, y: 0 }, true);
    for (let i = 0; i < 20; i++) step(state, { ...ZERO, cmd: parked }, 0.05, true);
    assert.ok(Math.hypot(ex.x - before.x, ex.z - before.z) < 0.2);
    assert.ok(Math.abs(ex.tool.swing) > 0.2 || ex.tool.reach > homeTool("excavator").reach);

    const truck = park(state, "truck", 20, 40);
    state.active = state.vehicles.indexOf(truck);
    const bed = sticksToCommand("truck", { x: 0, y: 0 }, { x: 0, y: 1 });
    for (let i = 0; i < 30; i++) step(state, { ...ZERO, cmd: bed }, 0.05, true);
    assert.ok(truck.tool.lift > 0.5);
  });
});
