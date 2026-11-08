import { test } from "node:test";
import assert from "node:assert/strict";
import { MOUNTAIN_CLAIM, MOUNTAIN_HAUL_FEE, X1, benchAt, coldFactor, switchbackBlocks, switchbackWaypoint, SWITCHBACKS } from "@/game/mountain";
import { areaOf } from "@/game/river";
import { boundsFor, CLAIMS, PADS } from "@/game/catalog";
import { buyClaim, buyVehicle, freshGame, groundFactor, haulMachine, haulTarget, currentArea, step, buildHud, ensureLowboy, toggleCrew } from "@/game/sim";
import { X0 } from "@/game/river";
import { bookWorth, readSaveText } from "@/game/save";
import * as O from "@/game/ops";

function withSeededRandom<T>(seed: number, run: () => T): T {
  const originalRandom = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  try {
    return run();
  } finally {
    Math.random = originalRandom;
  }
}

test("mountain is its own area with its own bounds, lease and mill", () => {
  assert.equal(areaOf(X1), "mountain");
  assert.equal(areaOf(1000), "river");
  assert.equal(boundsFor(X1).minX, X1 - 80);
  assert.ok(CLAIMS.some((c) => c.id === MOUNTAIN_CLAIM && c.price === 150000));
  assert.ok(PADS.some((p) => areaOf(p.x) === "mountain"));
});

test("switchback walls each leave one gap, alternating sides", () => {
  assert.equal(switchbackBlocks().length, 6);
  assert.ok(SWITCHBACKS[0].gapX > X1 && SWITCHBACKS[1].gapX < X1);
  const w = switchbackWaypoint(X1 - 40, 50, X1 - 40, -50)!;
  assert.equal(w.x, SWITCHBACKS[0].gapX);
  assert.equal(switchbackWaypoint(X1, 10, X1, 20), null);
  const through = switchbackWaypoint(SWITCHBACKS[2].gapX, SWITCHBACKS[2].z + 5, X1 - 40, -50)!;
  assert.equal(through.x, SWITCHBACKS[2].gapX);
  assert.ok(through.z < SWITCHBACKS[2].z - 4, `turned early at ${through.z}`);
  const along = switchbackWaypoint(X1 - 20, SWITCHBACKS[2].z + 5, X1 - 40, -50)!;
  assert.ok(along.z > SWITCHBACKS[2].z, "a truck off the gap should stay off the last wall");
  assert.ok(along.x > X1 - 20, "and slide toward the east gap");
  assert.equal(benchAt(50), 0);
  assert.equal(benchAt(-50), 3);
});

test("a dump truck takes the last gap up to summit gold instead of sitting on the wall", () => withSeededRandom(1, () => {
  const s = freshGame("Gap");
  s.cash = 1e6;
  s.claims.push(4, 5, 6, 8);
  s.watching = true;
  assert.equal(buyVehicle(s, "truck"), "");
  assert.equal(buyVehicle(s, "excavator"), "");
  const truck = s.vehicles.find((v) => v.defId === "truck")!;
  const ex = s.vehicles.find((v) => v.defId === "excavator")!;
  toggleCrew(s, s.vehicles.indexOf(truck));
  toggleCrew(s, s.vehicles.indexOf(ex));
  const face = s.deposits.find((d) => d.id === "summit-gold")!;
  ex.x = face.x;
  ex.z = face.z + 6;
  ex.cargo = 2;
  ex.cargoOre = "gold";
  const last = SWITCHBACKS[2];
  truck.x = X1 - 8;
  truck.z = last.z + 9;
  truck.yaw = 0;
  let stuck = 0;
  for (let i = 0; i < 30 * 28; i++) {
    step(s, { throttle: 0, steer: 0, action: false }, 1 / 30, false);
    if (truck.unstick > 0) stuck++;
  }
  assert.ok(truck.z < last.z - 6, `truck still on the wall at z=${(truck.z - last.z).toFixed(1)} x=${(truck.x - X1).toFixed(1)} ${truck.status}`);
  assert.ok(stuck < 90, `backed off the wall for ${(stuck / 30).toFixed(1)}s`);
}));

test("cold slows machines a bit, snow a bit more", () => {
  assert.ok(coldFactor(0) < 1 && coldFactor(0) > 0.8);
  assert.ok(coldFactor(1) < coldFactor(0) && coldFactor(1) > 0.7);
  const s = freshGame("T");
  s.vehicles[0].x = X1;
  s.vehicles[0].z = 50;
  assert.ok(groundFactor(s, s.vehicles[0]) < 1);
});

test("mountain unlocks only after a valley lease, haul costs more, and it survives a reload", () => {
  const s = freshGame("T");
  s.cash = 1e6;
  s.claims.push(4, 5);
  assert.match(buyClaim(s, MOUNTAIN_CLAIM), /opens once/);
  s.claims.push(6);
  const listed = buildHud(s, true).grounds.find((g) => g.id === MOUNTAIN_CLAIM);
  assert.ok(listed);
  assert.equal(listed.here, true);
  assert.equal(listed.owned, false);
  assert.equal(listed.priceLabel, "$150,000");
  assert.equal(currentArea(s), "ridge");
  assert.equal(buyClaim(s, MOUNTAIN_CLAIM), "");
  const v = s.vehicles[0];
  v.x = 1000;
  v.z = 40;
  assert.equal(haulTarget(s), "mountain");
  const cash = s.cash;
  assert.equal(haulMachine(s), "");
  assert.equal(currentArea(s), "mountain");
  assert.equal(cash - s.cash, MOUNTAIN_HAUL_FEE);
  for (let i = 0; i < 60; i++) step(s, { throttle: 1, steer: 0, action: false }, 1 / 30, true);
  assert.equal(currentArea(s), "mountain");
  const back = readSaveText(JSON.stringify({ ...s, version: 4 }))!;
  assert.ok(back.claims.includes(MOUNTAIN_CLAIM));
  assert.ok(back.claims.includes(6));
  assert.equal(areaOf(back.vehicles[0].x), "mountain");
  assert.equal(haulTarget(s), "ridge");
});

test("leasing the mountain never lowers the save score", () => {
  const s = freshGame("T");
  s.cash = 400000;
  s.claims.push(4, 5, 7);
  const w = bookWorth(s);
  buyClaim(s, MOUNTAIN_CLAIM);
  assert.ok(bookWorth(s) >= w);
});

test("fix: summit mill pays near sluice price for gold, even with the sluice preferred", async () => {
  const { basePrice } = await import("@/game/sim");
  assert.equal(basePrice("gold", "mill", true), 285);
  const s = freshGame("T");
  (s as any).ops.story = 99; // keep story payouts out of the sale math
  s.cash = 0;
  s.sluice = true;
  s.preferSluice = true;
  s.claims.push(4, 5, 6, 8);
  const { buyVehicle } = await import("@/game/sim");
  s.cash = 1e6;
  buyVehicle(s, "truck");
  const t = s.vehicles[s.vehicles.length - 1];
  s.active = s.vehicles.length - 1;
  t.x = 2052; t.z = 50; t.cargo = 7; t.cargoOre = "gold"; t.cargoPurity = 0.95; t.tool.lift = 0.9;
  const c0 = s.cash;
  for (let i = 0; i < 90; i++) step(s, { throttle: 0, steer: 0, action: true }, 1 / 30, true);
  // The truck is paid when it dumps. Feeding the pile later must not pay again.
  assert.equal(t.cargo < 0.05, true);
  assert.ok(s.cash - c0 > 1000, `dump paid ${s.cash - c0}`);
  const pile = s.deposits.find((d) => d.kind === "pile" && d.ore === "gold" && Math.hypot(d.x - 2052, d.z - 50) < 12);
  assert.ok(pile && pile.tons > 6);
  buyVehicle(s, "loader");
  const l = s.vehicles[s.vehicles.length - 1];
  s.active = s.vehicles.length - 1;
  l.x = pile!.x; l.z = pile!.z;
  const c1 = s.cash;
  for (let i = 0; i < 400; i++) step(s, { throttle: 0, steer: 0, action: true }, 1 / 30, true);
  assert.ok(s.cash - c1 < 200, `fed an already-paid pile for ${s.cash - c1}`);
});

test("fix: a truck driving along a bench wall slides instead of sticking", () => {
  const s = freshGame("T");
  const v = s.vehicles[0];
  v.x = X1 + 30; v.z = 4 + 2.5 + 1.2; v.yaw = Math.PI / 2 - 0.25; v.speed = 0;
  for (let i = 0; i < 120; i++) step(s, { throttle: 1, steer: 0, action: false }, 1 / 30, true);
  assert.ok(v.x < X1 + 15, `stuck at ${v.x - X1}`);
});

test("fix: direct ridge-to-mountain haul for $2,500", () => {
  const s = freshGame("T");
  s.cash = 1e6;
  s.claims.push(4, 5, 6, 8);
  assert.equal(currentArea(s), "ridge");
  const c = s.cash;
  assert.equal(haulMachine(s, "mountain"), "");
  assert.equal(currentArea(s), "mountain");
  assert.equal(c - s.cash, MOUNTAIN_HAUL_FEE);
});

test("mountain faces show as a work source before the lowboy delivers the machine", () => {
  const s = freshGame("T");
  s.cash = 1e6;
  s.claims.push(4, 5, 6, 8);
  const v = s.vehicles[0];
  const card = buildHud(s, true).crew.find((c) => c.index === 0);
  assert.ok(card);
  assert.equal(card.area, "ridge");
  assert.ok(card.sources.some((o) => o.value === "face:summit-gold" && o.label === "Summit Gold · High mountain"));
  assert.ok(card.sources.some((o) => o.value === "face:ice-copper"));
  assert.ok(card.sources.some((o) => o.value === "8"));
  v.workFace = "summit-gold";
  v.workClaim = 8;
  v.x = X1 - 40;
  v.z = -50;
  v.hired = true;
  v.operator = true;
  s.watching = true;
  const before = s.deposits.find((d) => d.id === "ice-copper")!.tons;
  for (let i = 0; i < 90; i++) step(s, { throttle: 0, steer: 0, action: false }, 1 / 30, false);
  assert.equal(s.deposits.find((d) => d.id === "ice-copper")!.tons, before);
  assert.match(v.status, /Summit Gold/);
});

test("the quarry road is signed once the lease is open, and closed until you pay", () => {
  const s = freshGame("T");
  s.cash = 1e6;
  s.claims.push(4, 5, 6);
  ensureLowboy(s);
  const rig = s.vehicles.find((v) => v.defId === "lowboy")!;
  s.active = s.vehicles.indexOf(rig);
  rig.x = X0 + 40;
  rig.z = 44;
  assert.match(buildHud(s, true).routeLabel, /Lease it in Ground/);
  rig.x = 1400;
  rig.z = 96;
  rig.yaw = -Math.PI / 2;
  for (let i = 0; i < 20; i++) step(s, { throttle: 1, steer: 0, action: false }, 1 / 30, true);
  assert.ok(rig.x < X0 + 90, `unleased lowboy got onto the mountain road at ${rig.x}`);
  buyClaim(s, MOUNTAIN_CLAIM);
  rig.x = 1400;
  rig.z = 96;
  assert.match(buildHud(s, true).passLabel, /summit gate/);
  for (let i = 0; i < 30; i++) step(s, { throttle: 1, steer: 0, action: false }, 1 / 30, true);
  assert.ok(rig.x > 1400, `leased lowboy did not drive the quarry road, x=${rig.x}`);
});

test("a hired lowboy drives to the selected map without loading first", () => {
  const s = freshGame("T");
  s.cash = 5000;
  s.claims.push(4, 5, 6, 8);
  ensureLowboy(s);
  const rig = s.vehicles.find((v) => v.defId === "lowboy")!;
  const pickup = s.vehicles[0];
  pickup.x = -8;
  pickup.z = 44;
  pickup.speed = 0;
  rig.workFace = "map:mountain";
  rig.x = -2;
  rig.z = 44;
  rig.yaw = Math.PI / 2;
  s.watching = true;
  assert.equal(toggleCrew(s, s.vehicles.indexOf(rig)), "");
  assert.equal(rig.hired, true);
  const rigCard = buildHud(s, true).crew.find((c) => c.name === "Lowboy");
  assert.deepEqual(rigCard?.sources.map((o) => o.label), ["Ridge pit", "River Valley", "High mountain"]);
  const home = buildHud(s, true).crew[0].sources.find((o) => o.value === "1");
  assert.match(home?.label ?? "", /Ridge pit/);
  for (let i = 0; i < 30 * 6; i++) step(s, { throttle: 0, steer: 0, action: false }, 1 / 30, false);
  assert.equal((s.deck ?? []).includes(pickup.uid), false, rig.status);
  assert.match(rig.status, /High mountain/);
  assert.ok(rig.z > 50, `did not leave the yard, z=${rig.z.toFixed(1)}`);
});

test("Gold Creek jobs route around the west wall when assigned or sluice-preferred", () => {
  for (const assigned of [true, false]) {
    const s = freshGame("Gold route");
    s.cash = 1e6;
    s.claims.push(3);
    s.sluice = true;
    s.preferSluice = true;
    s.watching = true;
    assert.equal(buyVehicle(s, "loader"), "");
    const loader = s.vehicles.at(-1)!;
    loader.x = -10;
    loader.z = 38;
    loader.yaw = 0;
    if (assigned) loader.workClaim = 3;
    assert.equal(toggleCrew(s, s.vehicles.length - 1), "");

    for (let i = 0; i < 30 * 10; i++) step(s, { throttle: 0, steer: 0, action: false }, 1 / 30, false);

    assert.ok(loader.x < -62, `${assigned ? "assigned" : "sluice-preferred"} crew stopped at x=${loader.x.toFixed(1)}: ${loader.status}`);
  }
});

test("a claim truck on the mountain road can reach the camp pumps", () => {
  const s = freshGame("Fuel");
  s.cash = 8000;
  s.claims.push(4, 5, 6, 8);
  s.watching = true;
  s.active = 1;
  const v = s.vehicles[0];
  toggleCrew(s, 0);
  v.x = 1700;
  v.z = 96;
  v.yaw = Math.PI / 2;
  O.ops(s).fuel[v.uid] = 0.2;
  const bay = O.FUEL_BAYS.find((b) => b.area === "mountain")!;
  let arrived = false;
  for (let i = 0; i < 30 * 80; i++) {
    step(s, { throttle: 0, steer: 0, action: false }, 1 / 30, false);
    if (v.x < 1200) break;
    if (Math.hypot(v.x - bay.x, v.z - bay.z) < 8 && (O.ops(s).fuel[v.uid] ?? 0) > 0.5) {
      arrived = true;
      break;
    }
  }
  assert.ok(arrived, `never fueled: x=${v.x.toFixed(0)} z=${v.z.toFixed(0)} ${v.status} fuel=${(O.ops(s).fuel[v.uid] ?? 0).toFixed(2)}`);
  assert.ok(v.x > 1500, "got kicked back to the valley");
});
