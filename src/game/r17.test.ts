import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, buyVehicle, buyClaim, toggleCrew } from "@/game/sim";

const idle = { throttle: 0, steer: 0, action: false };

function hireAt(s: ReturnType<typeof freshGame>, id: "loader" | "truck" | "hloader", x: number, z: number) {
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

function loosePile(s: ReturnType<typeof freshGame>, ore: "dirt" | "iron" | "gold" | "copper", tons: number, x: number, z: number, claim: number) {
  s.deposits.push({
    id: `r17-${ore}-${s.deposits.length}`,
    kind: "pile",
    ore,
    tons,
    max: tons,
    x,
    z,
    regen: 0,
    claim,
    radius: 5,
    sign: "PILE",
    purity: 1,
    overburden: 0,
    grade: 1,
    stress: 0,
    bench: 1,
    benchProgress: 0,
    hard: false,
    tested: false,
    lastBlastDay: -1,
  });
  return s.deposits[s.deposits.length - 1];
}

function setupRidge(sluice = true) {
  const s = freshGame("R17");
  s.cash = 1e6;
  s.watching = true;
  s.sluice = sluice;
  s.preferSluice = true;
  buyClaim(s, 2);
  buyClaim(s, 3);
  const starter = s.deposits.find((d) => d.id === "starter");
  if (starter) {
    starter.tons = 0;
    starter.regen = 0;
  }
  return s;
}

test("hired loader hauls a dirt pile to the sluice while a gold face is still open", () => {
  const s = setupRidge(true);
  const dirt = loosePile(s, "dirt", 24, -16, 18, 1);
  const loader = hireAt(s, "loader", -14, 22);
  const truck = hireAt(s, "truck", 8, 28);
  s.active = 0;
  let hauled = false;
  for (let i = 0; i < 30 * 90; i++) {
    step(s, idle, 1 / 30, false);
    if (truck.status === "Hauling to Sluice" || loader.status === "Scooping Dirt") hauled = true;
  }
  assert.ok(hauled, `never scooped or hauled dirt: loader=${loader.status} truck=${truck.status}`);
  assert.ok(dirt.tons < 16, `dirt pile still ${dirt.tons.toFixed(1)} t with gold face open`);
});

test("hired loader hauls an iron pile after the sluice is built when no washable pile is waiting", () => {
  const s = setupRidge(true);
  const iron = loosePile(s, "iron", 24, -16, 18, 1);
  const loader = hireAt(s, "loader", -14, 22);
  const truck = hireAt(s, "truck", 8, 28);
  s.active = 0;
  let hauled = false;
  for (let i = 0; i < 30 * 90; i++) {
    step(s, idle, 1 / 30, false);
    if (truck.status.startsWith("Hauling") || loader.status === "Scooping Iron") hauled = true;
  }
  assert.ok(hauled, `never moved the iron pile: loader=${loader.status} truck=${truck.status}`);
  assert.ok(iron.tons < 16, `iron pile still ${iron.tons.toFixed(1)} t`);
});

test("a leftover copper crumb does not stop a dirt pile at the claim from going to the sluice", () => {
  const s = setupRidge(true);
  loosePile(s, "copper", 0.7, -36, -30, 2);
  const dirt = loosePile(s, "dirt", 24, -16, 18, 1);
  const loader = hireAt(s, "loader", -14, 22);
  const truck = hireAt(s, "truck", 8, 28);
  s.active = 0;
  let hauled = false;
  for (let i = 0; i < 30 * 90; i++) {
    step(s, idle, 1 / 30, false);
    if (truck.status === "Hauling to Sluice" || loader.status === "Scooping Dirt") hauled = true;
  }
  assert.ok(hauled, `never scooped dirt beside the copper crumb: loader=${loader.status} truck=${truck.status}`);
  assert.ok(dirt.tons < 16, `dirt pile still ${dirt.tons.toFixed(1)} t beside a 0.7 t copper leftover`);
});

test("a washable pile at the claims is hauled before an iron pile", () => {
  const s = setupRidge(true);
  const iron = loosePile(s, "iron", 24, 8, 22, 1);
  const gold = loosePile(s, "gold", 24, -20, 20, 3);
  const loader = hireAt(s, "loader", 0, 26);
  hireAt(s, "truck", 12, 30);
  s.active = 0;
  for (let i = 0; i < 30 * 50; i++) step(s, idle, 1 / 30, false);
  assert.ok(gold.tons < iron.tons, `worked iron (${iron.tons.toFixed(1)} t) before gold (${gold.tons.toFixed(1)} t)`);
});
