import { test } from "node:test";
import assert from "node:assert/strict";
import { MOUNTAIN_CLAIM, MOUNTAIN_HAUL_FEE, X1, benchAt, coldFactor, switchbackBlocks, switchbackWaypoint, SWITCHBACKS } from "@/game/mountain";
import { areaOf } from "@/game/river";
import { boundsFor, CLAIMS, PADS } from "@/game/catalog";
import { buyClaim, freshGame, groundFactor, haulMachine, haulTarget, currentArea, step, buildHud, ensureLowboy, toggleCrew } from "@/game/sim";
import { X0 } from "@/game/river";
import { bookWorth, readSaveText } from "@/game/save";

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
  assert.equal(benchAt(50), 0);
  assert.equal(benchAt(-50), 3);
});

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
  // The truck tips a feed pile at the mill (no pay yet)...
  assert.equal(t.cargo < 0.05, true);
  assert.ok(s.cash - c0 < 200, `${s.cash - c0}`); // only the slow yard feeder so far
  const pile = s.deposits.find((d) => d.kind === "pile" && d.ore === "gold" && Math.hypot(d.x - 2052, d.z - 50) < 12);
  assert.ok(pile && pile.tons > 6);
  // ...and a loader feeding it in gets paid near the sluice price.
  buyVehicle(s, "loader");
  const l = s.vehicles[s.vehicles.length - 1];
  s.active = s.vehicles.length - 1;
  l.x = pile!.x; l.z = pile!.z;
  const c1 = s.cash;
  for (let i = 0; i < 400; i++) step(s, { throttle: 0, steer: 0, action: true }, 1 / 30, true);
  assert.ok(s.cash - c1 > 1000, `paid ${s.cash - c1}`);
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

test("a hired lowboy driver loads a machine assigned to another map", () => {
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
  for (let i = 0; i < 30 * 8; i++) step(s, { throttle: 0, steer: 0, action: false }, 1 / 30, false);
  assert.ok((s.deck ?? []).includes(pickup.uid), rig.status);
});
