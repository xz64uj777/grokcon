import { test } from "node:test";
import assert from "node:assert/strict";
import { planCrewJobs, honorTeamDest, type PlanJob, type PlanMachine } from "@/game/crew-plan";

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

test("a team railroad dest is ignored when the job already goes to a plant", () => {
  const machines = [
    { ...machine("L1", "loader", 0, 0), crewId: 1 },
    { ...machine("T1", "truck", 4, 0), crewId: 1 },
  ];
  const jobs = [job("gold-a", "pile", "gold", 24, 0, 0, { destKind: "wash", destName: "Wash plant" })];
  const manuals = [{ id: 1, memberUids: ["L1", "T1"], sourceId: "gold-a", destKind: "loadout", destName: "Rail loadout" }];
  const plan = planCrewJobs(machines, jobs, null, manuals);
  assert.equal(plan.get("L1")!.destKind, "wash");
  assert.equal(plan.get("T1")!.destKind, "wash");
  assert.equal(plan.get("L1")!.destName, "Wash plant");
  assert.equal(honorTeamDest("wash", "loadout"), null);
  assert.equal(honorTeamDest("sluice", "loadout"), null);
  assert.equal(honorTeamDest("crusher", "barge"), null);
  assert.equal(honorTeamDest("mill", "loadout"), null);
  assert.equal(honorTeamDest("sluice", "reclaim"), null);
  assert.equal(honorTeamDest("loadout", "loadout"), "loadout");
  assert.equal(honorTeamDest("sluice", "crusher"), "crusher");
});

test("iron still hauls to the railroad when that is the auto dest", () => {
  const machines = [
    { ...machine("L1", "loader", 0, 0), crewId: 1 },
    { ...machine("T1", "truck", 4, 0), crewId: 1 },
  ];
  const jobs = [job("iron-a", "pile", "iron", 24, 0, 0, { destKind: "loadout", destName: "Rail loadout" })];
  const manuals = [{ id: 1, memberUids: ["L1", "T1"], sourceId: "iron-a", destKind: "loadout", destName: "Rail loadout" }];
  const plan = planCrewJobs(machines, jobs, null, manuals);
  assert.equal(plan.get("T1")!.destKind, "loadout");
});

test("a high-value face does not take every dump truck when another digger needs one", () => {
  const machines = [
    machine("E1", "excavator", -80, 16),
    machine("L1", "loader", 0, 20),
    machine("T1", "truck", -70, 20),
    machine("T2", "truck", 10, 20),
    machine("H1", "heavy", 20, 20),
  ];
  const jobs = [
    job("gold", "vein", "gold", 80, -80, 16, { score: 20000, claimName: "Gold creek" }),
    job("iron", "pile", "iron", 24, 0, 22, { score: 2000, claimName: "South yard" }),
  ];
  const plan = planCrewJobs(machines, jobs, null);
  const eTeam = plan.get("E1")!.team;
  const lTeam = plan.get("L1")!.team;
  assert.ok(eTeam && lTeam && eTeam !== lTeam, "diggers should be on two teams");
  const dumpTeams = [plan.get("T1")!.team, plan.get("T2")!.team];
  assert.equal(new Set(dumpTeams).size, 2, `both dump trucks went to one team: T1=${dumpTeams[0]} T2=${dumpTeams[1]}`);
  assert.ok(plan.get("T1")!.team === eTeam || plan.get("T2")!.team === eTeam);
  assert.ok(plan.get("T1")!.team === lTeam || plan.get("T2")!.team === lTeam);
});

test("a loaded truck stays on its team when the job ore changes", () => {
  const machines = [machine("L1", "loader", 0, 0), machine("T1", "truck", 4, 4), machine("T2", "truck", 8, 8)];
  const first = planCrewJobs(machines, [job("iron", "pile", "iron", 24, 0, 0, { score: 2000 })], null);
  assert.equal(first.get("T1")!.team, first.get("L1")!.team);
  const hauling = machines.map((m) => (m.uid === "T1" ? { ...m, cargo: 18, cargoOre: "iron" as const } : m));
  const next = planCrewJobs(hauling, [job("gold", "pile", "gold", 20, 10, 0, { score: 8000 })], first);
  assert.equal(next.get("T1")!.team, next.get("L1")!.team, "iron-loaded truck was dropped from the team");
});

test("a heavy loader shares an excavator's face when there is no pile", () => {
  const machines = [machine("H1", "hloader", 40, 40), machine("E1", "excavator", 48, 50)];
  const jobs = [job("east-rim", "vein", "copper", 200, 74, -22, { score: 8000, claim: 7, claimName: "East rim" })];
  const plan = planCrewJobs(machines, jobs, null);
  assert.equal(plan.get("H1")!.sourceId, "east-rim");
  assert.equal(plan.get("E1")!.sourceId, "east-rim");
  assert.ok(plan.get("H1")!.team !== plan.get("E1")!.team, "sharing diggers should stay on their own teams so trucks can split");
});

test("a river heavy keeps the payloader free to visit, without moving it onto the east job", () => {
  const west = 1000 - 40;
  const east = 1000 + 40;
  const machines: PlanMachine[] = [
    { uid: "E1", defId: "excavator", x: west, z: 30, area: "river", cargo: 0, cargoOre: null, workClaim: null, workFace: null },
    { uid: "L1", defId: "loader", x: west, z: 20, area: "river", cargo: 0, cargoOre: null, workClaim: null, workFace: null },
    { uid: "T1", defId: "truck", x: west, z: 24, area: "river", cargo: 0, cargoOre: null, workClaim: null, workFace: null },
    { uid: "T2", defId: "truck", x: west, z: 28, area: "river", cargo: 0, cargoOre: null, workClaim: null, workFace: null },
    { uid: "H1", defId: "heavy", x: east, z: 10, area: "river", cargo: 0, cargoOre: null, workClaim: null, workFace: null },
  ];
  const jobs: PlanJob[] = [
    job("west-silver", "vein", "silver", 80, west, 12, { score: 9000, area: "river", claim: 5, claimName: "River bars" }),
    job("west-gold", "vein", "gold", 80, west, 40, { score: 8000, area: "river", claim: 5, claimName: "River bars" }),
    job("east-bar", "vein", "silver", 60, east, 8, { score: 5000, area: "river", claim: 5, claimName: "River bars" }),
  ];
  const plan = planCrewJobs(machines, jobs, null);
  const loaderJob = plan.get("L1")!;
  const excavatorJob = plan.get("E1")!;
  const heavyPartners = plan.get("H1")!.partnerUids;
  const dumpTeams = [plan.get("T1")!.team, plan.get("T2")!.team];
  assert.ok(heavyPartners.includes("L1"), `heavy should stay with the payloader so it can visit: partners=${heavyPartners.join(",")}`);
  assert.ok(loaderJob.sourceId !== "east-bar", `payloader was permanently retargeted to ${loaderJob.sourceId}`);
  assert.equal(new Set(dumpTeams).size, 2, `both dump trucks went to one team: T1=${dumpTeams[0]} T2=${dumpTeams[1]}`);
});

test("an idle skid picks an unassigned small pile ahead of a new face", () => {
  const machines = [machine("L1", "loader", -70, 22), machine("T1", "truck", -50, 22), machine("S1", "skid", 42, 48)];
  const jobs = [
    job("gold-stock", "pile", "gold", 400, -72, 20),
    job("dirt-by-diesel", "pile", "dirt", 4, 44, 48),
    job("dirt-by-bench", "pile", "dirt", 3.6, -35, 30),
    job("gold-face", "vein", "gold", 170, -80, 16),
  ];
  const manuals = [{ id: 1, memberUids: ["L1", "T1"], sourceId: "gold-stock", destKind: null, destName: null }];
  const plan = planCrewJobs(machines, jobs, null, manuals);
  assert.equal(plan.get("S1")?.sourceId, "dirt-by-diesel");
  assert.equal(plan.get("S1")?.jobKind, "crumb");
  assert.equal(plan.get("L1")?.sourceId, "gold-stock");
});

test("a team pinned to a temporarily depleted Gold Creek face does not switch to South yard", () => {
  const machines = [machine("L1", "loader", 0, 0), machine("T1", "truck", 6, 0)];
  const jobs = [
    job("gold", "vein", "gold", 0, -80, 16, { claim: 3 }),
    job("yard-gold", "pile", "gold", 40, 6, 0),
  ];
  const manuals = [{ id: 2, memberUids: ["L1", "T1"], sourceId: "gold", destKind: null, destName: null }];
  const plan = planCrewJobs(machines, jobs, null, manuals);
  assert.equal(plan.get("L1")?.sourceId, "gold");
  assert.equal(plan.get("T1")?.sourceId, "gold");
});

test("a starter skid picks the gate iron pile before opening the dirt face", () => {
  const machines = [machine("S", "skid", 5, 40)];
  const jobs = [job("starter", "pile", "iron", 40, -2, 22), job("dirt", "vein", "dirt", 520, 16, 36)];
  const plan = planCrewJobs(machines, jobs, null);
  assert.equal(plan.get("S")?.sourceId, "starter");
  assert.equal(plan.get("S")?.destKind, "crusher");

  const loaderPlan = planCrewJobs([...machines, machine("L", "loader", 0, 24)], jobs, null);
  assert.equal(loaderPlan.get("L")?.sourceId, "starter");
  assert.equal(loaderPlan.get("S")?.sourceId, "dirt");
});

test("a two-skid South Yard team chooses the loose iron before a dirt face", () => {
  const machines = [machine("S1", "skid", 12, 36), machine("S2", "skid", 14, 36), machine("T1", "truck", 8, 26)];
  const starter = job("starter", "pile", "iron", 40, -2, 22);
  const dirt = job("dirt", "vein", "dirt", 500, 14, 36, { score: 20000 });
  const crews = [{ id: 1, memberUids: ["S1", "S2", "T1"], sourceId: null, destKind: null, destName: null }];
  const planned = planCrewJobs(machines, [dirt, starter], null, crews);
  for (const machine of machines) assert.equal(planned.get(machine.uid)?.sourceId, "starter");
});

test("Auto cleans the starter iron before repeating a reclaim dirt job", () => {
  const skid = machine("S", "skid", 10, 30);
  const jobs = [job("starter", "pile", "iron", 40, -2, 22), job("dirt-crumb", "crumb", "dirt", 1, 16, 36)];
  assert.equal(planCrewJobs([skid], jobs, null).get(skid.uid)?.sourceId, "starter");
});

test("Auto takes an available ore face before opening more overburden or reclaim dirt", () => {
  const skid = machine("S", "skid", 16, 36);
  const jobs = [
    job("overburden", "vein", "dirt", 400, 16, 36),
    job("dirt-crumb", "crumb", "dirt", 1, 17, 36),
    job("iron-face", "vein", "iron", 30, 30, 38),
  ];
  assert.equal(planCrewJobs([skid], jobs, null).get(skid.uid)?.sourceId, "iron-face");
  assert.equal(planCrewJobs([skid], jobs.slice(0, 2), null).get(skid.uid)?.sourceId, "dirt-crumb");
});
