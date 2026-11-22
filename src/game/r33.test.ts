import { test } from "node:test";
import assert from "node:assert/strict";
import { freshGame, buyVehicle, toggleCrew, assignCrew } from "@/game/sim";
import {
  TRUCK_WAIT_WINDOW,
  buildHudTeams,
  noteTeamTruckWait,
  teamTruckWaitRatio,
  truckLightForWait,
  truckWaitHint,
} from "@/game/sim/crew.ts";

const dt = 1 / 20;

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

function parkStarters(s: ReturnType<typeof freshGame>) {
  for (const v of s.vehicles) {
    v.operator = false;
    v.hired = false;
  }
}

function hireDigger(s: ReturnType<typeof freshGame>) {
  assert.equal(buyVehicle(s, "excavator"), "");
  const v = s.vehicles[s.vehicles.length - 1];
  const i = s.vehicles.length - 1;
  if (!v.hired) toggleCrew(s, i);
  v.hired = true;
  v.operator = true;
  assert.equal(assignCrew(s, i, "new"), "");
  return v;
}

function runWindow(s: ReturnType<typeof freshGame>, v: { status: string }, waitSeconds: number) {
  const work = Math.max(0, TRUCK_WAIT_WINDOW - waitSeconds);
  for (let i = 0; i < Math.round(work / dt); i++) {
    v.status = "Working Copper bench";
    noteTeamTruckWait(s, dt);
    s.seconds += dt;
  }
  for (let i = 0; i < Math.round(waitSeconds / dt); i++) {
    v.status = "Waiting for truck";
    noteTeamTruckWait(s, dt);
    s.seconds += dt;
  }
}

function setup() {
  const s = freshGame("R33 lights");
  s.cash = 5e6;
  parkStarters(s);
  const digger = hireDigger(s);
  return { s, digger };
}

test("truck wait cutoffs are green under 15%, yellow through 40%, and red above", () => {
  assert.equal(truckLightForWait(0), "green");
  assert.equal(truckLightForWait(0.149), "green");
  assert.equal(truckLightForWait(0.15), "yellow");
  assert.equal(truckLightForWait(0.4), "yellow");
  assert.equal(truckLightForWait(0.401), "red");
  assert.match(truckWaitHint("red"), /add a truck/i);
});

test("a team with no digger has no truck light", () => withSeededRandom(33, () => {
  const s = freshGame("R33 no digger");
  s.cash = 5e6;
  parkStarters(s);
  assert.equal(buyVehicle(s, "truck"), "");
  const i = s.vehicles.length - 1;
  const v = s.vehicles[i]!;
  if (!v.hired) toggleCrew(s, i);
  v.hired = true;
  v.operator = true;
  assert.equal(assignCrew(s, i, "new"), "");
  const row = buildHudTeams(s).find((t) => t.area === "ridge");
  assert.ok(row, "expected a team row");
  assert.equal(row!.truckLight, null);
  assert.equal(row!.truckHint, null);
  assert.equal(teamTruckWaitRatio(s, row!.id, "ridge"), null);
}));

test("a team whose diggers rarely wait shows a green light", () => withSeededRandom(33, () => {
  const { s, digger } = setup();
  runWindow(s, digger, 5);
  const row = buildHudTeams(s).find((t) => t.area === "ridge");
  const ratio = teamTruckWaitRatio(s, row!.id, "ridge") ?? -1;
  const note = `ratio=${ratio.toFixed(3)} light=${row?.truckLight} hint=${row?.truckHint}`;
  assert.ok(ratio < 0.15, note);
  assert.equal(row?.truckLight, "green", note);
  assert.match(row?.truckHint ?? "", /rarely waiting/i);
}));

test("a team that waits some of the time shows a yellow light", () => withSeededRandom(33, () => {
  const { s, digger } = setup();
  runWindow(s, digger, 20);
  const row = buildHudTeams(s).find((t) => t.area === "ridge");
  const ratio = teamTruckWaitRatio(s, row!.id, "ridge") ?? -1;
  const note = `ratio=${ratio.toFixed(3)} light=${row?.truckLight} hint=${row?.truckHint}`;
  assert.ok(ratio >= 0.15 && ratio <= 0.4, note);
  assert.equal(row?.truckLight, "yellow", note);
  assert.match(row?.truckHint ?? "", /some of the time/i);
}));

test("a team that waits often shows a red light telling you to add a truck", () => withSeededRandom(33, () => {
  const { s, digger } = setup();
  runWindow(s, digger, 48);
  const row = buildHudTeams(s).find((t) => t.area === "ridge");
  const ratio = teamTruckWaitRatio(s, row!.id, "ridge") ?? -1;
  const note = `ratio=${ratio.toFixed(3)} light=${row?.truckLight} hint=${row?.truckHint}`;
  assert.ok(ratio > 0.4, note);
  assert.equal(row?.truckLight, "red", note);
  assert.equal(row?.truckHint, "Diggers waiting on trucks — add a truck");
}));
