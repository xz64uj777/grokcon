import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, step, buyVehicle, buyClaim, toggleCrew, crewAssignment, crewDisplayStatus, buildHud } from "@/game/sim";
import { crewBoard } from "@/game/crew-help";

const idle = { throttle: 0, steer: 0, action: false };

function hireAt(s: ReturnType<typeof freshGame>, id: "loader" | "truck" | "hloader" | "excavator" | "skid", x: number, z: number) {
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
    id: `r18-${ore}-${s.deposits.length}`,
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

function setupRidge() {
  const s = freshGame("R18");
  s.cash = 1e6;
  s.watching = true;
  s.sluice = true;
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

test("a loader and truck stay on one dirt pile and haul it to the sluice", () => {
  const s = setupRidge();
  const dirt = loosePile(s, "dirt", 24, -16, 18, 1);
  const loader = hireAt(s, "loader", -14, 22);
  const truck = hireAt(s, "truck", 8, 28);
  s.active = 0;
  let hauled = false;
  for (let i = 0; i < 30 * 90; i++) {
    step(s, idle, 1 / 30, false);
    if (/Hauling to Sluice|hauling dirt to Sluice/.test(truck.status) || /hauling dirt to Sluice/.test(crewDisplayStatus(s, truck))) hauled = true;
  }
  const job = crewAssignment(s, loader);
  assert.ok(job, "loader should have a team job");
  assert.equal(job?.sourceId, dirt.id);
  assert.equal(crewAssignment(s, truck)?.team, job?.team);
  assert.ok(hauled || dirt.tons < 16, `dirt did not move: ${dirt.tons.toFixed(1)} t loader=${loader.status} truck=${truck.status}`);
  assert.ok(dirt.tons < 16, `dirt pile still ${dirt.tons.toFixed(1)} t`);
  const lines = crewBoard(buildHud(s, false).crew, "ridge").map((row) => row.line).join("\n");
  assert.match(lines, /Team \d+:/);
  assert.match(lines, /Sluice/);
});

test("a lone loader waits at a far pile instead of tipping, and self-hauls when the plant is close", () => {
  const far = setupRidge();
  const farPile = loosePile(far, "iron", 24, 8, -36, 1);
  const farLoader = hireAt(far, "loader", 8, -30);
  far.active = 0;
  let tipped = false;
  let hauled = false;
  for (let i = 0; i < 30 * 45; i++) {
    step(far, idle, 1 / 30, false);
    if (farLoader.status === "Tipped the load on a pile") tipped = true;
    if (/Hauling to|Dumping at/.test(farLoader.status)) hauled = true;
  }
  assert.equal(tipped, false, "lone loader tipped a far pile instead of waiting");
  assert.equal(hauled, false, `lone loader self-hauled a far pile: ${farLoader.status}`);
  assert.ok(farPile.tons + farLoader.cargo > 20, `far iron left the pile with no truck: pile ${farPile.tons.toFixed(1)} t cargo ${farLoader.cargo.toFixed(1)}`);
  assert.match(crewDisplayStatus(far, farLoader), /waiting for truck|Waiting for a job|loading iron/i);

  const near = setupRidge();
  const nearPile = loosePile(near, "dirt", 16, -70, 30, 3);
  const nearLoader = hireAt(near, "loader", -68, 32);
  near.active = 0;
  let selfHaul = false;
  for (let i = 0; i < 30 * 60; i++) {
    step(near, idle, 1 / 30, false);
    if (/Hauling to Sluice|Dumping at Sluice/.test(nearLoader.status)) selfHaul = true;
  }
  assert.ok(selfHaul || nearPile.tons < 12, `nearby dirt was not short-carried: ${nearPile.tons.toFixed(1)} t ${nearLoader.status}`);
});

test("two trucks stay on the same loader team and both get loaded", () => {
  const s = setupRidge();
  const pile = loosePile(s, "dirt", 40, -16, 18, 1);
  const loader = hireAt(s, "loader", -14, 22);
  const t1 = hireAt(s, "truck", 8, 28);
  const t2 = hireAt(s, "truck", 14, 32);
  s.active = 0;
  const hauled = new Set<string>();
  for (let i = 0; i < 30 * 120; i++) {
    step(s, idle, 1 / 30, false);
    for (const t of [t1, t2]) {
      if (t.cargo > 8 || /Hauling|hauling/.test(crewDisplayStatus(s, t))) hauled.add(t.uid);
    }
  }
  const job = crewAssignment(s, loader);
  assert.equal(crewAssignment(s, t1)?.team, job?.team);
  assert.equal(crewAssignment(s, t2)?.team, job?.team);
  assert.ok(hauled.size === 2 || pile.tons < 20, `only ${hauled.size} truck(s) hauled; pile ${pile.tons.toFixed(1)} t`);
});
