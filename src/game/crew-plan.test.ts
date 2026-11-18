import { test } from "node:test";
import assert from "node:assert/strict";
import { planCrewJobs, type PlanJob, type PlanMachine } from "@/game/crew-plan";

function machine(uid: string, defId: string, x: number, z: number): PlanMachine {
  return { uid, defId, x, z, area: "ridge", cargo: 0, cargoOre: null, workClaim: null, workFace: null };
}

function job(id: string, kind: PlanJob["kind"], ore: PlanJob["ore"], tons: number, x: number, z: number, extra: Partial<PlanJob> = {}): PlanJob {
  const names = { dirt: "Dirt", iron: "Iron", copper: "Copper", gold: "Gold gravel", silver: "River silver" };
  const dest = ore === "iron" ? { destKind: "crusher" as const, destName: "Crusher" } : { destKind: "sluice" as const, destName: "Sluice" };
  return {
    id,
    kind,
    ore,
    oreName: names[ore],
    tons,
    x,
    z,
    area: "ridge",
    claim: extra.claim ?? 1,
    claimName: extra.claimName ?? "South yard",
    score: extra.score ?? tons * 10,
    ...dest,
    ...extra,
  };
}

test("two loaders take two piles and each keeps one truck", () => {
  const machines = [
    machine("L1", "loader", 0, 0),
    machine("L2", "loader", 80, 0),
    machine("T1", "truck", 4, 4),
    machine("T2", "truck", 84, 4),
  ];
  const jobs = [job("dirt-a", "pile", "dirt", 24, 0, 0, { score: 2000, claimName: "South yard" }), job("iron-b", "pile", "iron", 24, 80, 0, { score: 1500, claimName: "South yard" })];
  const plan = planCrewJobs(machines, jobs, null);
  const a = plan.get("L1")!;
  const b = plan.get("L2")!;
  assert.ok(a.sourceId && b.sourceId && a.sourceId !== b.sourceId, "each loader should get its own pile");
  const trucks = [plan.get("T1")!, plan.get("T2")!];
  assert.equal(new Set(trucks.map((t) => t.team)).size, 2);
  assert.equal(plan.get("T1")!.partnerUids.includes(plan.get("T1")!.team === a.team ? "L1" : "L2"), true);
  const again = planCrewJobs(machines.map((m) => ({ ...m, x: m.x + 3 })), jobs, plan);
  assert.equal(again.get("L1")!.sourceId, a.sourceId);
  assert.equal(again.get("L2")!.sourceId, b.sourceId);
  assert.equal(again.get("L1")!.team, a.team);
});

test("a third truck joins an existing team instead of inventing a second job", () => {
  const machines = [machine("L1", "loader", 0, 0), machine("T1", "truck", 4, 4)];
  const jobs = [job("dirt-a", "pile", "dirt", 30, 0, 0, { score: 2000 })];
  const first = planCrewJobs(machines, jobs, null);
  assert.equal(first.get("L1")!.partnerUids.includes("T1"), true);
  const withTwo = planCrewJobs([...machines, machine("T2", "truck", 8, 8)], jobs, first);
  assert.equal(withTwo.get("L1")!.sourceId, "dirt-a");
  assert.deepEqual(withTwo.get("L1")!.partnerUids.slice().sort(), ["T1", "T2"]);
  assert.equal(withTwo.get("T2")!.team, first.get("L1")!.team);
});

test("a team is reassigned once its pile is gone", () => {
  const machines = [machine("L1", "loader", 0, 0), machine("T1", "truck", 4, 4)];
  const first = planCrewJobs(machines, [job("dirt-a", "pile", "dirt", 24, 0, 0, { score: 2000 })], null);
  assert.equal(first.get("L1")!.sourceId, "dirt-a");
  const next = planCrewJobs(machines, [job("iron-b", "pile", "iron", 20, 10, 0, { score: 1200 })], first);
  assert.equal(next.get("L1")!.sourceId, "iron-b");
  assert.ok(next.get("L1")!.label.includes("Iron") || next.get("L1")!.label.includes("iron"));
});

test("skid steers take crumbs; loaders ignore them", () => {
  const machines = [machine("L1", "loader", 0, 0), machine("S1", "skid", 2, 2), machine("T1", "truck", 6, 6)];
  const jobs = [job("crumb", "crumb", "copper", 0.8, 2, 2, { score: 80, claimName: "Copper bench" }), job("pile", "pile", "dirt", 24, 20, 0, { score: 2000 })];
  const plan = planCrewJobs(machines, jobs, null);
  assert.equal(plan.get("L1")!.sourceId, "pile");
  assert.equal(plan.get("S1")!.sourceId, "crumb");
  assert.equal(plan.get("S1")!.role, "skid");
  assert.match(plan.get("S1")!.label, /Clearing crumbs at Copper bench -> Sluice/);
});

test("an excavator takes a face while a loader takes a pile", () => {
  const machines = [machine("E1", "excavator", 0, 0), machine("L1", "loader", 40, 0), machine("T1", "truck", 4, 4), machine("T2", "truck", 44, 4)];
  const jobs = [job("gold", "vein", "gold", 80, 0, 0, { score: 8000, claimName: "Gold creek" }), job("dirt", "pile", "dirt", 24, 40, 0, { score: 2000 })];
  const plan = planCrewJobs(machines, jobs, null);
  assert.equal(plan.get("E1")!.sourceId, "gold");
  assert.equal(plan.get("L1")!.sourceId, "dirt");
  assert.match(plan.get("E1")!.label, /Team \d+: digging gold gravel at Gold creek -> Sluice/);
  assert.match(plan.get("L1")!.label, /Team \d+: loading dirt /);
});

test("a loader parked on a face switches to a pile that appears", () => {
  const machines = [machine("L1", "loader", 0, 0), machine("T1", "truck", 4, 4)];
  const face = job("gold", "vein", "gold", 80, 0, 0, { score: 8000, claimName: "Gold creek" });
  const first = planCrewJobs(machines, [face], null);
  assert.equal(first.get("L1")!.sourceId, "gold");
  const pile = job("dirt", "pile", "dirt", 20, 8, 0, { score: 2000 });
  const next = planCrewJobs(machines, [face, pile], first);
  assert.equal(next.get("L1")!.sourceId, "dirt");
});

test("a skid with no crumbs self-hauls a leftover face", () => {
  const machines = [machine("S1", "skid", 0, 0), machine("E1", "excavator", 10, 0)];
  const jobs = [job("gold", "vein", "gold", 80, 0, 0, { score: 8000, area: "ridge", claimName: "Gold creek" })];
  const plan = planCrewJobs(machines, jobs, null);
  assert.equal(plan.get("E1")!.sourceId, "gold");
  assert.equal(plan.get("S1")!.sourceId, "gold");
  assert.equal(plan.get("S1")!.role, "skid");
});

test("a manual crew of one loader and two trucks stays on the chosen pile and plant", () => {
  const machines = [
    { ...machine("L1", "loader", 0, 0), crewId: 1 },
    { ...machine("T1", "truck", 4, 0), crewId: 1 },
    { ...machine("T2", "truck", 6, 0), crewId: 1 },
    machine("L2", "loader", 80, 0),
    machine("T3", "truck", 84, 0),
  ];
  const jobs = [
    job("dirt-a", "pile", "dirt", 24, 0, 0, { score: 100, destKind: "sluice", destName: "Sluice" }),
    job("gold-b", "pile", "gold", 24, 80, 0, { score: 9000, destKind: "sluice", destName: "Sluice" }),
  ];
  const manuals = [{ id: 1, memberUids: ["L1", "T1", "T2"], sourceId: "dirt-a", destKind: "crusher", destName: "Crusher" }];
  const plan = planCrewJobs(machines, jobs, null, manuals);
  assert.equal(plan.get("L1")!.team, 1);
  assert.equal(plan.get("T1")!.team, 1);
  assert.equal(plan.get("T2")!.team, 1);
  assert.equal(plan.get("L1")!.sourceId, "dirt-a");
  assert.equal(plan.get("T1")!.sourceId, "dirt-a");
  assert.equal(plan.get("T2")!.sourceId, "dirt-a");
  assert.equal(plan.get("L1")!.destKind, "crusher");
  assert.equal(plan.get("T2")!.destName, "Crusher");
  assert.equal(plan.get("L2")!.sourceId, "gold-b");
  assert.notEqual(plan.get("L2")!.team, 1);
  assert.equal(plan.get("T3")!.team, plan.get("L2")!.team);
});

test("when a chosen pile is gone the same crew auto-picks another job", () => {
  const machines = [
    { ...machine("L1", "loader", 0, 0), crewId: 1 },
    { ...machine("T1", "truck", 4, 0), crewId: 1 },
    { ...machine("T2", "truck", 6, 0), crewId: 1 },
  ];
  const manuals = [{ id: 1, memberUids: ["L1", "T1", "T2"], sourceId: "dirt-a", destKind: null, destName: null }];
  const jobs = [job("gold-b", "pile", "gold", 24, 10, 0, { score: 9000 })];
  const plan = planCrewJobs(machines, jobs, null, manuals);
  assert.equal(plan.get("L1")!.team, 1);
  assert.equal(plan.get("T1")!.team, 1);
  assert.equal(plan.get("T2")!.team, 1);
  assert.equal(plan.get("L1")!.sourceId, "gold-b");
  assert.ok(plan.get("T1")!.partnerUids.includes("L1"));
  assert.ok(plan.get("T1")!.partnerUids.includes("T2"));
});

test("an invalid plant on a manual crew uses the job's usual dest", () => {
  const machines = [
    { ...machine("L1", "loader", 0, 0), crewId: 1 },
    { ...machine("T1", "truck", 4, 0), crewId: 1 },
  ];
  const manuals = [{ id: 1, memberUids: ["L1", "T1"], sourceId: "dirt-a", destKind: null, destName: null }];
  const jobs = [job("dirt-a", "pile", "dirt", 24, 0, 0, { destKind: "sluice", destName: "Sluice" })];
  const plan = planCrewJobs(machines, jobs, null, manuals);
  assert.equal(plan.get("L1")!.sourceId, "dirt-a");
  assert.equal(plan.get("L1")!.destKind, "sluice");
  assert.equal(plan.get("L1")!.destName, "Sluice");
});

test("two diggers on one manual crew share one job", () => {
  const machines = [
    { ...machine("L1", "loader", 0, 0), crewId: 1 },
    { ...machine("L2", "loader", 8, 0), crewId: 1 },
    { ...machine("T1", "truck", 4, 0), crewId: 1 },
  ];
  const manuals = [{ id: 1, memberUids: ["L1", "L2", "T1"], sourceId: "dirt-a", destKind: null, destName: null }];
  const jobs = [
    job("dirt-a", "pile", "dirt", 24, 0, 0, { score: 100 }),
    job("gold-b", "pile", "gold", 24, 80, 0, { score: 9000 }),
  ];
  const plan = planCrewJobs(machines, jobs, null, manuals);
  assert.equal(plan.get("L1")!.team, 1);
  assert.equal(plan.get("L2")!.team, 1);
  assert.equal(plan.get("L1")!.sourceId, "dirt-a");
  assert.equal(plan.get("L2")!.sourceId, "dirt-a");
  assert.equal(plan.get("T1")!.sourceId, "dirt-a");
});

test("auto machines do not reuse a reserved manual team number", () => {
  const machines = [
    { ...machine("L1", "loader", 0, 0), crewId: 1 },
    { ...machine("T1", "truck", 4, 0), crewId: 1 },
    machine("L2", "loader", 80, 0),
    machine("T2", "truck", 84, 0),
  ];
  const manuals = [{ id: 1, memberUids: ["L1", "T1"], sourceId: "dirt-a", destKind: null, destName: null }];
  const jobs = [
    job("dirt-a", "pile", "dirt", 24, 0, 0, { score: 100 }),
    job("gold-b", "pile", "gold", 24, 80, 0, { score: 9000 }),
  ];
  const plan = planCrewJobs(machines, jobs, null, manuals);
  assert.equal(plan.get("L1")!.team, 1);
  assert.notEqual(plan.get("L2")!.team, 1);
  assert.equal(plan.get("T2")!.team, plan.get("L2")!.team);
});
