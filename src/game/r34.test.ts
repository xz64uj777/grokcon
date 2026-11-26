import { test } from "node:test";
import assert from "node:assert/strict";
import type { VehicleId } from "@/game/types";
import { buyVehicle, freshGame, lotBuy, lotButtons, sellVehicle, step } from "@/game/sim";
import { exportSave, readSaveText } from "@/game/save";
import { ops } from "@/game/ops";
import { addPile } from "@/game/sim/feed";
import { pointBlocked } from "@/game/sim/motion";
import { assignCrew, crewAssignment, setCrewSource } from "@/game/sim/crew";
import { acceptsJob, crewDigPosition, pileApproach, pileInReach } from "@/game/sim/jobs";
import { idleFor, holdForTruck } from "@/game/sim/haulers";
import { makeVehicle, nearestPad, vehicleStats } from "@/game/sim/world";
import { pileFootprint } from "@/game/piles";
import { sticksToCommand } from "@/game/controls";

test("selling or trading a loaded machine drops the ore on the ground", () => {
  const sold = freshGame("Sell");
  sold.cash = 1e6;
  ops(sold).story = 99;
  assert.equal(buyVehicle(sold, "truck"), "");
  const truck = sold.vehicles.find((v) => v.defId === "truck")!;
  truck.x = 10;
  truck.z = 40;
  truck.cargo = 9;
  truck.cargoOre = "iron";
  const before = sold.deposits.filter((d) => d.ore === "iron").reduce((n, d) => n + d.tons, 0);
  assert.equal(sellVehicle(sold, sold.vehicles.indexOf(truck)), "");
  const after = sold.deposits.filter((d) => d.ore === "iron").reduce((n, d) => n + d.tons, 0);
  assert.ok(after >= before + 8, `ore disappeared: ${before} -> ${after}`);
  assert.ok(sold.deposits.some((d) => d.kind === "pile" && d.ore === "iron" && Math.hypot(d.x - 10, d.z - 40) < 8));

  const traded = freshGame("Trade");
  traded.cash = 1e6;
  traded.tutorial.bought = true;
  ops(traded).story = 99;
  assert.equal(buyVehicle(traded, "truck"), "");
  const mine = traded.vehicles.find((v) => v.defId === "truck")!;
  traded.active = traded.vehicles.indexOf(mine);
  mine.cargo = 6;
  mine.cargoOre = "copper";
  mine.x = 4;
  mine.z = 42;
  const copper0 = traded.deposits.filter((d) => d.ore === "copper").reduce((n, d) => n + d.tons, 0);
  let tradedAway = false;
  for (let day = 0; day < 14 && !tradedAway; day++) {
    traded.market.day = day;
    ops(traded).lotTaken = { day, ids: [] };
    const btn = lotButtons(traded).find((b) => b.id.startsWith("lottrade:") && b.enabled && !b.id.endsWith(":truck"));
    if (!btn) continue;
    assert.equal(lotBuy(traded, btn.id.slice("lottrade:".length) as VehicleId, true), "");
    tradedAway = true;
  }
  assert.equal(tradedAway, true);
  const copper1 = traded.deposits.filter((d) => d.ore === "copper").reduce((n, d) => n + d.tons, 0);
  assert.ok(copper1 >= copper0 + 5, `trade ate the load: ${copper0} -> ${copper1}`);
  assert.ok(traded.deposits.some((d) => d.kind === "pile" && d.ore === "copper" && Math.hypot(d.x - 4, d.z - 42) < 8));
});

test("a plant pile that was already paid does not pay again after reload", () => {
  const s = freshGame("Paid");
  s.cash = 1e6;
  s.claims.push(4, 5, 6, 8);
  ops(s).story = 99;
  assert.equal(buyVehicle(s, "truck"), "");
  const t = s.vehicles.find((v) => v.defId === "truck")!;
  s.active = s.vehicles.indexOf(t);
  t.x = 2052;
  t.z = 50;
  t.cargo = 8;
  t.cargoOre = "gold";
  t.cargoPurity = 1;
  s.cash = 0;
  for (let i = 0; i < 20; i++) step(s, { throttle: 0, steer: 0, action: true }, 1 / 30, true);
  assert.ok(t.cargo < 0.05, "truck did not dump");
  assert.ok(s.cash > 1000, `dump was not paid: ${s.cash}`);
  const pile = s.deposits.find((d) => d.id.startsWith("feed-") && d.ore === "gold");
  assert.ok(pile && (pile.paidTons ?? 0) > 1, "paid tons were not stored on the pile");
  const back = readSaveText(exportSave(s))!;
  ops(back).story = 99;
  const paid = back.deposits.find((d) => d.id.startsWith("feed-") && d.ore === "gold");
  assert.ok(paid && (paid.paidTons ?? 0) > 1, "paid tons did not survive the save");
  const c0 = back.cash;
  for (let i = 0; i < 30 * 12; i++) step(back, { throttle: 0, steer: 0, action: false }, 1 / 30, false);
  assert.ok(back.cash - c0 < 40, `feeder paid again: ${back.cash - c0}`);
});


test("regression: many dirt piles never teleport into a distant heap", () => {
  const state = freshGame("Local dirt");
  for (const x of [-65, -40, -15, 10]) {
    for (const z of [-65, -40, -15, 10]) addPile(state, "dirt", 2, x, z, 1);
  }
  const old = state.deposits.find((d) => d.kind === "pile" && d.ore === "dirt" && d.x === -65 && d.z === -65)!;
  assert.ok(old);
  const before = state.deposits.filter((d) => d.kind === "pile" && d.ore === "dirt").length;
  addPile(state, "dirt", 3, 70, 70, 1);
  assert.equal(state.deposits.filter((d) => d.kind === "pile" && d.ore === "dirt").length, before + 1);
  assert.equal(old.x, -65);
  assert.equal(old.z, -65);
});

test("regression: seated driver may scoop despite a hired crew work source", () => {
  const state = freshGame("Hand controls");
  const v = state.vehicles[state.active];
  const pile = state.deposits.find((d) => d.id === "starter")!;
  assert.ok(pile);
  v.workClaim = 3;
  assert.equal(acceptsJob(state, v, pile), true);
  state.watching = true;
  assert.equal(acceptsJob(state, v, pile), false);
});

test("regression: crew loader reaches pile from outside its physical footprint", () => {
  const state = freshGame("Pile approach");
  const v = makeVehicle("hloader", 3);
  const pile = state.deposits.find((d) => d.id === "starter")!;
  assert.ok(pile);
  state.vehicles.push(v);
  state.active = state.vehicles.indexOf(v);
  v.x = pile.x + 20;
  v.z = pile.z + 4;
  const stand = pileApproach(state, v, pile);
  const foot = pileFootprint(pile.tons);
  const body = vehicleStats(v).radius * 0.45;
  const norm = ((stand.x - pile.x) / (foot.rx + body)) ** 2 +
    ((stand.z - pile.z) / (foot.rz + body)) ** 2;
  assert.ok(norm > 1, "loader approach point is inside the solid pile");
  v.x = stand.x;
  v.z = stand.z;
  assert.equal(pileInReach(state, v)?.id, pile.id, "loader cannot scoop at approach point");
});

test("regression: waiting digger keeps its cargo instead of inventing dirt piles", () => {
  const state = freshGame("Hold load");
  const v = makeVehicle("loader", 3);
  v.cargo = 3;
  v.cargoOre = "dirt";
  state.vehicles.push(v);
  idleFor(state, v);
  state.seconds = 45;
  const count = state.deposits.length;
  holdForTruck(state, v);
  assert.equal(v.cargo, 3);
  assert.equal(v.cargoOre, "dirt");
  assert.equal(state.deposits.length, count);
});


test("regression: manual Work button scoops a loose pile even without a curl gesture", () => {
  const state = freshGame("Hand scoop");
  const v = makeVehicle("loader", 3);
  const pile = state.deposits.find((d) => d.id === "starter")!;
  state.vehicles.push(v);
  state.active = state.vehicles.indexOf(v);
  state.controlMode = "real";
  v.x = pile.x + 5.5;
  v.z = pile.z;
  const cmd = sticksToCommand("loader", { x: 0, y: 0 }, { x: 0, y: 0 });
  for (let i = 0; i < 90; i++) step(state, { throttle: 0, steer: 0, action: true, cmd }, 1 / 60, true);
  assert.ok(v.cargo > 0, "holding Work did not scoop the iron pile");
  assert.equal(v.cargoOre, "iron");
});

test("new spills and old saved stockpiles in the river are reachable from the bank", () => {
  const state = freshGame("River spill");
  const x = 1000.8;
  const z = 36;
  addPile(state, "dirt", 6.2, x, z, 5);
  const pile = state.deposits.at(-1)!;
  assert.ok(pile.x >= 1007);
  const draft = JSON.parse(exportSave(state));
  Object.assign(draft.deposits.at(-1), { x, z });
  const restored = readSaveText(JSON.stringify(draft))!;
  const saved = restored.deposits.find((d) => d.id === pile.id)!;
  assert.equal(saved.x, pile.x);
  assert.equal(saved.tons, 6.2);
  assert.equal(saved.claim, 5);
  const loader = makeVehicle("loader", 0);
  Object.assign(loader, { x: 1012, z });
  assert.equal(pileInReach(restored, loader)?.id, saved.id);
});

test("a South Yard claim order allows a hired skid to scoop the starter pile", () => {
  const state = freshGame("South Yard iron");
  state.watching = true;
  const skid = makeVehicle("skid", 3);
  skid.hired = skid.operator = true;
  skid.workClaim = 1;
  state.vehicles.push(skid);
  assert.equal(acceptsJob(state, skid, state.deposits.find((d) => d.id === "starter")!), true);
});

test("two skids reserve separate clear spots on the same loose iron pile", () => {
  const state = freshGame("Shared iron approach");
  const pile = state.deposits.find((d) => d.id === "starter")!;
  const a = makeVehicle("skid", 2);
  const b = { ...a, uid: "S" };
  for (const skid of [a, b]) {
    Object.assign(skid, { x: pile.x + 12, z: pile.z, hired: true, operator: true });
    state.vehicles.push(skid);
  }
  const first = pileApproach(state, a, pile);
  const second = pileApproach(state, b, pile);
  assert.ok(Math.hypot(first.x - second.x, first.z - second.z) >= vehicleStats(a).radius + vehicleStats(b).radius);
});

test("a reloaded two-skid South Yard crew scoops iron and sells it at the crusher", () => {
  const state = freshGame("South Yard reload");
  state.watching = true;
  const pile = state.deposits.find((d) => d.id === "starter")!;
  const skids = [makeVehicle("skid", 3), makeVehicle("skid", 4)];
  const truck = makeVehicle("truck", 5);
  for (const [i, machine] of [...skids, truck].entries()) {
    Object.assign(machine, { x: pile.x + 10 + 3 * i, z: pile.z + 4, hired: true, operator: true, workClaim: 1 });
    state.vehicles.push(machine);
    assert.equal(assignCrew(state, state.vehicles.indexOf(machine), i === 0 ? "new" : "1"), "");
  }
  assert.equal(setCrewSource(state, 1, "starter"), "");
  const restored = readSaveText(exportSave(state))!;
  assert.equal(restored.watching, true);
  for (const machine of restored.vehicles.slice(-3)) {
    const job = crewAssignment(restored, machine);
    assert.equal(job?.sourceId, "starter");
    assert.equal(job?.ore, "iron");
    assert.equal(job?.destKind, "crusher");
  }
  const restoredSkids = restored.vehicles.slice(-3, -1);
  const scooped = new Set<string>();
  const sales: string[] = [];
  for (let i = 0; i < 30 * 85 && (scooped.size < 2 || sales.length < 2); i++) {
    const fx = step(restored, { throttle: 0, steer: 0, action: false }, 1 / 30, false);
    for (const skid of restoredSkids) if (skid.cargoOre === "iron") scooped.add(skid.uid);
    sales.push(...fx.sales.map((sale) => `${nearestPad(restored, sale.x, sale.z)?.kind}: ${sale.text}`));
  }
  assert.equal(scooped.size, 2, JSON.stringify(restoredSkids.map(({ x, z, status, cargo }) => ({ x, z, status, cargo }))));
  assert.ok(sales.length >= 2, JSON.stringify(sales));
  assert.ok(sales.every((sale) => /^crusher: .*iron/i.test(sale)), JSON.stringify(sales));
});

test("two skids on the same South Yard face have separate clear digging positions", () => {
  const state = freshGame("Shared South Yard face");
  state.watching = true;
  const skids = [makeVehicle("skid", 3), makeVehicle("skid", 4)];
  const face = state.deposits.find((d) => d.kind === "vein" && d.ore === "dirt" && d.claim === 1)!;
  for (const [i, skid] of skids.entries()) {
    Object.assign(skid, { x: face.x + 16, z: face.z + 8, hired: true, operator: true });
    state.vehicles.push(skid);
    assert.equal(assignCrew(state, state.vehicles.indexOf(skid), i === 0 ? "new" : "1"), "");
  }
  assert.equal(setCrewSource(state, 1, face.id), "");
  const first = crewDigPosition(state, skids[0], face);
  const second = crewDigPosition(state, skids[1], face);
  assert.ok(first && second);
  assert.equal(pointBlocked(first.x, first.z, vehicleStats(skids[0]).radius), false);
  assert.equal(pointBlocked(second.x, second.z, vehicleStats(skids[1]).radius), false);
  assert.ok(Math.hypot(first.x - second.x, first.z - second.z) >= vehicleStats(skids[0]).radius + vehicleStats(skids[1]).radius);
});
