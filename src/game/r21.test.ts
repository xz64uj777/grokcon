import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshGame,
  step,
  buyVehicle,
  buyClaim,
  toggleCrew,
  assignCrew,
  setCrewSource,
  crewAssignment,
} from "@/game/sim";
import { X0 } from "@/game/river";

const idle = { throttle: 0, steer: 0, action: false };

function hireAt(s: ReturnType<typeof freshGame>, id: "loader" | "truck", x: number, z: number) {
  assert.equal(buyVehicle(s, id), "");
  const v = s.vehicles[s.vehicles.length - 1];
  v.x = x;
  v.z = z;
  v.yaw = 0;
  v.speed = 0;
  v.cargo = 0;
  v.cargoOre = null;
  const i = s.vehicles.length - 1;
  if (!v.hired) toggleCrew(s, i);
  v.hired = true;
  v.operator = true;
  return v;
}

test("a second Team 2 payloader still scoops the team's gold pile when the first is already on it", () => {
  const s = freshGame("R21");
  s.cash = 1e6;
  s.watching = true;
  s.washPlant = true;
  buyClaim(s, 4);
  buyClaim(s, 5);
  const pile = {
    id: "r21-gold-pile",
    kind: "pile" as const,
    ore: "gold" as const,
    tons: 36,
    max: 36,
    x: X0 + 28,
    z: -40,
    regen: 0,
    claim: 5,
    radius: 5,
    sign: "GOLD GRAVEL",
    purity: 1,
    overburden: 0,
    grade: 1,
    stress: 0,
    bench: 1,
    benchProgress: 0,
    hard: false,
    tested: false,
    lastBlastDay: -1,
  };
  s.deposits.push(pile);
  // One loader already at the heap, the other close enough that the old
  // "someone is already on this pile" penalty used to drop the score below
  // the cutoff and leave that loader idle.
  const atPile = hireAt(s, "loader", X0 + 32, -40);
  const nearby = hireAt(s, "loader", X0 + 36, -32);
  const t1 = hireAt(s, "truck", X0 + 44, -50);
  const t2 = hireAt(s, "truck", X0 + 48, -54);
  for (const v of [atPile, nearby, t1, t2]) {
    assert.equal(assignCrew(s, s.vehicles.indexOf(v), "2"), "");
  }
  assert.equal(setCrewSource(s, 2, pile.id), "");
  assert.equal(crewAssignment(s, atPile)?.sourceId, pile.id);
  assert.equal(crewAssignment(s, nearby)?.sourceId, pile.id);
  s.active = 0;
  let nearbyScooped = 0;
  let idleLooking = 0;
  let worstIdle = 0;
  for (let i = 0; i < 30 * 45; i++) {
    step(s, idle, 1 / 30, false);
    nearbyScooped = Math.max(nearbyScooped, nearby.cargo);
    if (nearby.cargo < 0.2 && pile.tons > 8 && /Looking for a pile|Needs a pile/.test(nearby.status) && Math.abs(nearby.speed) < 0.35) {
      idleLooking++;
      if (idleLooking > worstIdle) worstIdle = idleLooking;
    } else idleLooking = 0;
  }
  assert.ok(
    nearbyScooped > 1,
    `second payloader never scooped the team pile, cargo ${nearby.cargo.toFixed(1)}t "${nearby.status}", pile ${pile.tons.toFixed(1)}t, first "${atPile.status}" ${atPile.cargo.toFixed(1)}t`,
  );
  assert.ok(worstIdle < 30 * 12, `second payloader sat idle looking for a pile for ${(worstIdle / 30).toFixed(1)}s`);
});
