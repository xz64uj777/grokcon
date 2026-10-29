import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockRoadGate, deckFit, deckSpots, hillBlocksRoad, inDropYard, onHaulRoad, spotsUsed, stepHitch } from "./lowboy.ts";

describe("lowboy deck space", () => {
  it("gives small machines one spot and big machines the whole deck", () => {
    assert.equal(deckSpots("skid"), 1);
    assert.equal(deckSpots("pickup"), 1);
    assert.equal(deckSpots("dozer"), 2);
    assert.equal(deckSpots("loader"), 2);
    assert.equal(deckSpots("truck"), 3);
    assert.equal(deckSpots("excavator"), 3);
    assert.equal(deckSpots("heavy"), 3);
    assert.equal(deckSpots("crusher"), null);
    assert.equal(deckSpots("lowboy"), null);
  });

  it("fits two small machines, or a dozer and a skid, and nothing beside a heavy haul", () => {
    assert.equal(deckFit([], "skid"), "");
    assert.equal(deckFit(["skid"], "pickup"), "");
    assert.equal(deckFit(["skid"], "dozer"), "");
    assert.equal(deckFit(["dozer"], "loader"), "Not enough deck left for that machine.");
    assert.equal(deckFit(["heavy"], "skid"), "Not enough deck left for that machine.");
    assert.equal(deckFit(["skid", "pickup"], "skid"), "The deck already has two machines.");
    assert.equal(deckFit([], "crusher"), "That machine does not fit on the lowboy.");
    assert.equal(spotsUsed(["skid", "dozer"]), 3);
  });
});

describe("north road", () => {
  it("is north of both yards and does not cross the river", () => {
    assert.equal(onHaulRoad(400, 96), true);
    assert.equal(onHaulRoad(0, 40), false);
    assert.equal(onHaulRoad(1000, 8), false);
    assert.equal(inDropYard(-8, 44), true);
    assert.equal(inDropYard(400, 96), false);
  });

  it("treats a hill sitting on the marked gravel as blocking it", () => {
    assert.equal(hillBlocksRoad(80, 140, 70, 50), true);
    assert.equal(hillBlocksRoad(0, 150, 40, 50), true);
    assert.equal(hillBlocksRoad(400, 200, 40, 30), false);
    assert.equal(hillBlocksRoad(40, 20, 20, 20), false);
  });

  it("stops every machine but the lowboy at the gate", () => {
    assert.equal(blockRoadGate("pickup", 0, 70), true);
    assert.equal(blockRoadGate("truck", 400, 96), true);
    assert.equal(blockRoadGate("lowboy", 400, 96), false);
    assert.equal(blockRoadGate("pickup", 0, 50), false);
  });
});

describe("fifth wheel", () => {
  it("keeps the trailer straight when the tractor drives straight", () => {
    let x = 0;
    let z = 0;
    let yaw = 0;
    let trailerYaw = 0;
    let axleX: number | undefined;
    let axleZ: number | undefined;
    for (let i = 0; i < 12; i++) {
      x += -Math.sin(yaw) * 1.4;
      z += -Math.cos(yaw) * 1.4;
      const next = stepHitch(x, z, yaw, trailerYaw, axleX, axleZ);
      trailerYaw = next.trailerYaw;
      axleX = next.axleX;
      axleZ = next.axleZ;
    }
    assert.ok(Math.abs(trailerYaw) < 0.05);
  });

  it("lets the deck yaw behind the cab in a turn", () => {
    let x = 0;
    let z = 0;
    let yaw = 0;
    let trailerYaw = 0;
    let axleX: number | undefined;
    let axleZ: number | undefined;
    for (let i = 0; i < 18; i++) {
      yaw += 0.09;
      x += -Math.sin(yaw) * 1.3;
      z += -Math.cos(yaw) * 1.3;
      const next = stepHitch(x, z, yaw, trailerYaw, axleX, axleZ);
      trailerYaw = next.trailerYaw;
      axleX = next.axleX;
      axleZ = next.axleZ;
    }
    const gap = Math.atan2(Math.sin(yaw - trailerYaw), Math.cos(yaw - trailerYaw));
    assert.ok(Math.abs(gap) > 0.2, `trailer should lag the cab, gap was ${gap}`);
  });
});
