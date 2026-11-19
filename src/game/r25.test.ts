import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, buyVehicle, toggleCrew, assignCrew, buildHud } from "@/game/sim";
import { X0 } from "@/game/river";

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

test("Crew screen lists every ridge team with members, in number order, even if Team 1 is unused", () => {
  const s = freshGame("R25");
  s.cash = 1e6;
  const a = hireAt(s, "loader", -14, 22);
  const t2 = hireAt(s, "truck", 8, 28);
  const b = hireAt(s, "loader", 12, 20);
  const t3 = hireAt(s, "truck", 16, 24);
  // Leave Team 1 unused so the ids are 2 and 3, as in the playtest.
  assert.equal(assignCrew(s, s.vehicles.indexOf(a), "2"), "");
  assert.equal(assignCrew(s, s.vehicles.indexOf(t2), "2"), "");
  assert.equal(assignCrew(s, s.vehicles.indexOf(b), "3"), "");
  assert.equal(assignCrew(s, s.vehicles.indexOf(t3), "3"), "");
  // First vehicle on Team 2 sits on the valley side so a first-member area
  // check would hide the team from the ridge Crew list.
  a.x = X0 + 40;
  a.z = 20;
  const hud = buildHud(s, false);
  const ridge = hud.teams.filter((t) => t.area === "ridge");
  assert.deepEqual(
    ridge.map((t) => t.id),
    [2, 3],
    `ridge Teams list was ${ridge.map((t) => t.name).join(", ") || "empty"}`,
  );
});
