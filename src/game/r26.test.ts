import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freshGame,
  step,
  buyVehicle,
  toggleCrew,
  assignCrew,
  setFeeder,
  addFeedPile,
  feedId,
  YARD_FEED_RATE,
  crewAssignment,
  buildHud,
} from "@/game/sim";
import { PADS } from "@/game/catalog";
import { exportSave, readSaveText } from "@/game/save";

const idle = { throttle: 0, steer: 0, action: false };

function hireAt(s: ReturnType<typeof freshGame>, id: "loader" | "truck" | "excavator", x: number, z: number) {
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

test("a sluice feeder stays at the plant and feeds the hopper faster than the yard feeder", () => {
  const s = freshGame("R26");
  s.cash = 1e6;
  s.watching = true;
  s.sluice = true;
  s.feedLimit = 1;
  const pad = PADS.find((p) => p.kind === "sluice")!;
  const loader = hireAt(s, "loader", pad.x + 16, pad.z);
  assert.equal(setFeeder(s, s.vehicles.indexOf(loader), "sluice"), "");
  addFeedPile(s, pad, "gold", 12, 1);
  const pile = () => s.deposits.find((d) => d.id === feedId(pad.id));
  s.active = 0;
  for (let i = 0; i < 30 * 12; i++) step(s, idle, 1 / 30, false);
  const left = pile()?.tons ?? 0;
  assert.ok(left < 12 - YARD_FEED_RATE * 8, `hopper barely moved (${left.toFixed(1)} t left; yard would still have ~${(12 - YARD_FEED_RATE * 12).toFixed(1)})`);
  assert.match(loader.status, /Feeding sluice/);
  assert.ok(Math.hypot(loader.x - pad.x, loader.z - pad.z) < 14, `left the sluice at ${loader.x.toFixed(0)},${loader.z.toFixed(0)}`);
  // After the pile is gone it still waits at the plant, not a face.
  for (let i = 0; i < 30 * 20 && (pile()?.tons ?? 0) > 0.05; i++) step(s, idle, 1 / 30, false);
  assert.ok((pile()?.tons ?? 0) <= 0.05, `hopper still has ${pile()?.tons?.toFixed(1)} t`);
  assert.match(loader.status, /Feeding sluice/);
  assert.ok(Math.hypot(loader.x - pad.x, loader.z - pad.z) < 14, `wandered off after the pile cleared`);
});

test("the crew planner does not send a sluice feeder out to another pile", () => {
  const s = freshGame("R26b");
  s.cash = 1e6;
  s.watching = true;
  s.sluice = true;
  const pad = PADS.find((p) => p.kind === "sluice")!;
  const gold = s.deposits.find((d) => d.id === "gold");
  if (gold) gold.tons = 80;
  const loader = hireAt(s, "loader", pad.x + 8, pad.z);
  const truck = hireAt(s, "truck", pad.x + 14, pad.z + 6);
  assert.equal(assignCrew(s, s.vehicles.indexOf(loader), "2"), "");
  assert.equal(assignCrew(s, s.vehicles.indexOf(truck), "2"), "");
  assert.equal(setFeeder(s, s.vehicles.indexOf(loader), "sluice"), "");
  assert.equal(loader.crewId, null);
  addFeedPile(s, pad, "gold", 6, 1);
  s.active = 0;
  for (let i = 0; i < 30 * 20; i++) step(s, idle, 1 / 30, false);
  assert.equal(crewAssignment(s, loader), undefined);
  assert.match(loader.status, /Feeding sluice/);
  if (gold) {
    assert.ok(Math.hypot(loader.x - gold.x, loader.z - gold.z) > 12, `feeder went to the gold face at ${loader.x.toFixed(0)},${loader.z.toFixed(0)}`);
  }
  assert.ok(Math.hypot(loader.x - pad.x, loader.z - pad.z) < 16, `feeder left the sluice at ${loader.x.toFixed(0)},${loader.z.toFixed(0)}`);
});

test("a plant feeder is saved and loads on an old-shaped save", () => {
  const s = freshGame("R26s");
  s.cash = 1e6;
  s.sluice = true;
  const pad = PADS.find((p) => p.kind === "sluice")!;
  const loader = hireAt(s, "loader", pad.x, pad.z);
  assert.equal(setFeeder(s, s.vehicles.indexOf(loader), "sluice"), "");
  const hud = buildHud(s, false);
  const card = hud.crew.find((c) => c.index === s.vehicles.indexOf(loader));
  assert.equal(card?.feederValue, "sluice");
  assert.ok(card?.feederOptions.some((o) => o.value === "sluice" && o.label === "Sluice feeder"));
  const loaded = readSaveText(exportSave(s))!;
  const again = loaded.vehicles.find((v) => v.defId === "loader" && v.feederPad === "sluice");
  assert.ok(again, "feeder pad did not survive save");
  // Old saves without the field still load as Auto.
  const raw = JSON.parse(exportSave(s));
  for (const v of raw.vehicles) delete v.feederPad;
  const legacy = readSaveText(JSON.stringify(raw))!;
  assert.equal(legacy.vehicles.some((v) => v.defId === "loader" && (v.feederPad === "sluice" || v.feederPad === "wash")), false);
});
