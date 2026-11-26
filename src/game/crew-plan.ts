import type { OreId, PadKind } from "@/game/types";
import { RIVER } from "@/game/river";

/** Loose piles at or above this are a loader/truck job, not a crumb. */
export const PILE_JOB_TONS = 1.5;
/** Small leftovers a skid steer should clear. */
export const CRUMB_TONS = 0.4;

const SKID_CLEANUP_LIMIT = 8;
/** A face still worth a team until it is effectively dug out. */
export const VEIN_JOB_TONS = 0.5;
/** Max dump trucks (or heavies) on one digger. */
export const MAX_TEAM_TRUCKS = 3;

export type PlanRole = "digger" | "truck" | "skid";
export type JobKind = "pile" | "vein" | "crumb";

export type PlanMachine = {
  uid: string;
  defId: string;
  x: number;
  z: number;
  area: string;
  cargo: number;
  cargoOre: OreId | null;
  workClaim: number | null;
  workFace: string | null;
  workPile?: string;
  crewId?: number | null;
};

export type PlanJob = {
  id: string;
  kind: JobKind;
  ore: OreId;
  oreName: string;
  tons: number;
  x: number;
  z: number;
  area: string;
  claim: number;
  claimName: string;
  destKind: PadKind;
  destName: string;
  score: number;
};

export type CrewAssignment = {
  team: number;
  role: PlanRole;
  sourceId: string | null;
  jobKind: JobKind | null;
  ore: OreId | null;
  claimName: string;
  destKind: PadKind | null;
  destName: string;
  partnerUids: string[];
  label: string;
};

export function isPlanDigger(defId: string) {
  return defId === "loader" || defId === "hloader" || defId === "excavator";
}

export function isPlanTruck(defId: string) {
  return defId === "truck" || defId === "heavy";
}

export function jobStillValid(kind: JobKind | null, tons: number | null) {
  if (tons == null || kind == null) return false;
  if (kind === "crumb") return tons >= CRUMB_TONS;
  if (kind === "vein") return tons >= VEIN_JOB_TONS;
  return tons >= PILE_JOB_TONS;
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function bankOf(x: number) {
  return Math.sign(x - RIVER.x) || -1;
}

function isWheelLoader(defId: string) {
  return defId === "loader" || defId === "hloader";
}

function dumpCount(team: Team) {
  return team.trucks.filter((t) => t.defId === "truck").length;
}

function allowedJob(m: PlanMachine, j: PlanJob) {
  if (m.area !== j.area) return false;
  if (m.workClaim != null && j.claim !== m.workClaim) return false;
  if (m.workPile && j.id !== m.workPile) return false;
  if (m.workFace && j.kind === "vein" && j.id !== m.workFace) return false;
  return true;
}

export function teamLabel(team: number, role: PlanRole, job: PlanJob | null) {
  if (!job) {
    if (role === "truck") return "Waiting for a loader";
    if (role === "skid") return "Looking for crumbs";
    return "Waiting for a job";
  }
  const ore = job.oreName.toLowerCase();
  const dest = job.destName;
  const at = job.claimName;
  if (role === "skid") {
    if (job.kind === "crumb") return `Clearing crumbs at ${at} -> ${dest}`;
    const skidVerb = job.kind === "vein" ? "digging" : "loading";
    return `${skidVerb} ${ore} at ${at} -> ${dest}`;
  }
  const verb = job.kind === "vein" ? "digging" : "loading";
  return `Team ${team}: ${verb} ${ore} at ${at} -> ${dest}`;
}

function assignment(
  team: number,
  role: PlanRole,
  job: PlanJob | null,
  partners: string[],
  uid: string,
): CrewAssignment {
  return {
    team,
    role,
    sourceId: job?.id ?? null,
    jobKind: job?.kind ?? null,
    ore: job?.ore ?? null,
    claimName: job?.claimName ?? "",
    destKind: job?.destKind ?? null,
    destName: job?.destName ?? "",
    partnerUids: partners.filter((id) => id !== uid),
    label: teamLabel(team, role, job),
  };
}

type Team = { team: number; digger: PlanMachine; trucks: PlanMachine[]; job: PlanJob };

/**
 * Assign hired loaders, excavators, trucks, and skids to jobs.
 * Sticky: a team keeps its pile or face until that source is gone or the destination
 * drops out of the job list. Not saved; the caller recomputes from world state.
 */
export type ManualCrew = {
  id: number;
  memberUids: string[];
  sourceId: string | null;
  destKind: string | null;
  destName: string | null;
};

/** Rail loadout, barge, and the fill buyer are sell points, not recovery plants. */
const SELL_POINT_KINDS = new Set<string>(["loadout", "barge", "reclaim"]);
const PLANT_KINDS = new Set<string>(["wash", "sluice", "crusher", "mill"]);

export function isPlantKind(kind: string) {
  return PLANT_KINDS.has(kind);
}

export function isSellPointKind(kind: string) {
  return SELL_POINT_KINDS.has(kind);
}

/** Keep a chosen plant, but do not send a haul to the railroad (or barge) when a recovery plant is already the job destination. */
export function honorTeamDest(jobDest: PadKind, crewDest: string | null): string | null {
  if (!crewDest) return null;
  if (SELL_POINT_KINDS.has(crewDest) && PLANT_KINDS.has(jobDest)) return null;
  return crewDest;
}

function withDest(job: PlanJob, crew: ManualCrew): PlanJob {
  const dest = honorTeamDest(job.destKind, crew.destKind);
  if (!dest) return job;
  return {
    ...job,
    destKind: dest as PlanJob["destKind"],
    destName: dest === crew.destKind ? crew.destName || job.destName : job.destName,
  };
}

export function planCrewJobs(
  machines: PlanMachine[],
  jobs: PlanJob[],
  prev: Map<string, CrewAssignment> | null,
  manuals: ManualCrew[] = [],
): Map<string, CrewAssignment> {
  const result = new Map<string, CrewAssignment>();
  const areas = [...new Set(machines.map((m) => m.area))];

  for (const area of areas) {
    const ms = machines.filter((m) => m.area === area);
    const areaJobs = jobs.filter((j) => j.area === area);
    const jobById = new Map(areaJobs.map((j) => [j.id, j]));
    const diggers = ms.filter((m) => isPlanDigger(m.defId));
    const trucks = ms.filter((m) => isPlanTruck(m.defId));
    const skids = ms.filter((m) => m.defId === "skid");
    const takenJobs = new Set<string>();
    const usedDiggers = new Set<string>();
    const usedTrucks = new Set<string>();
    const teams: Team[] = [];
    const reserved = new Set(manuals.map((c) => c.id));
    const allocTeam = (prefer?: number) => {
      if (prefer && prefer > 0 && !reserved.has(prefer) && !teams.some((x) => x.team === prefer)) return prefer;
      let n = 1;
      while (reserved.has(n) || teams.some((x) => x.team === n)) n += 1;
      return n;
    };

    const workJobs = areaJobs.filter((j) => j.kind !== "crumb" && jobStillValid(j.kind, j.tons));
    const jobScore = (d: PlanMachine, j: PlanJob) => {
      const d0 = dist(d, j);
      return j.score / (d0 + 10) + (j.kind === "vein" && d0 < 16 ? 5000 : d0 < 40 ? 200 : 0);
    };

    // Player-made crews first: keep their members together, honor a valid
    // chosen pile or plant, and auto-pick a job for the crew if that target is gone.
    for (const crew of [...manuals].sort((a, b) => a.id - b.id)) {
      const members = ms.filter((m) => crew.memberUids.includes(m.uid));
      if (!members.length) continue;
      const ds = members.filter((m) => isPlanDigger(m.defId));
      const ts = members.filter((m) => isPlanTruck(m.defId));
      const ss = members.filter((m) => m.defId === "skid");
      let job: PlanJob | null = null;
      if (crew.sourceId) {
        const wanted = jobById.get(crew.sourceId);
        if (wanted && (wanted.kind === "vein" || jobStillValid(wanted.kind, wanted.tons)) && wanted.area === members[0].area) {
          job = withDest(wanted, crew);
        }
      }
      if (!job) {
        const workers = ds.length ? ds : ss;
        let best: PlanJob | null = null;
        let bestS = -Infinity;
        for (const d of workers) {
          for (const j of workJobs) {
            if (takenJobs.has(j.id) || !allowedJob(d, j)) continue;
            if (d.defId === "excavator" && j.kind !== "vein") continue;
            if (isPlanDigger(d.defId) && d.defId !== "excavator") {
              const pilesOpen = workJobs.some((p) => p.kind === "pile" && !takenJobs.has(p.id));
              if (pilesOpen ? j.kind !== "pile" : j.kind !== "vein") continue;
            }
            if (!ds.length && best?.id === "starter") continue;
            const s = !ds.length && j.id === "starter" ? Infinity : jobScore(d, j);
            if (s > bestS) {
              bestS = s;
              best = j;
            }
          }
        }
        if (best) job = withDest(best, crew);
      }
      for (const d of ds) usedDiggers.add(d.uid);
      for (const t of ts) usedTrucks.add(t.uid);
      const partners = members.map((m) => m.uid);
      if (job) takenJobs.add(job.id);
      for (const d of ds) result.set(d.uid, assignment(crew.id, "digger", job, partners, d.uid));
      // Put the assigned loader first so two trucks on one crew do not
      // both drive to the first loader in vehicle order.
      const assignedLoads = new Map<string, number>();
      const queue = area === "river"
        ? [...ts].sort((a, b) => Number(b.defId === "heavy") - Number(a.defId === "heavy"))
        : ts;
      for (const t of queue) {
        const previous = prev?.get(t.uid);
        let loader: PlanMachine | undefined;
        let bestCost = Infinity;
        for (const d of ds) {
          if (area === "river" && t.defId === "heavy" && bankOf(t.x) !== bankOf(d.x)) continue;
          const keepsBay = previous?.team === crew.id && previous.partnerUids[0] === d.uid;
          const cost = (assignedLoads.get(d.uid) ?? 0) * 10_000 + dist(t, d) - (keepsBay ? 1000 : 0);
          if (cost < bestCost) {
            loader = d;
            bestCost = cost;
          }
        }
        if (loader) assignedLoads.set(loader.uid, (assignedLoads.get(loader.uid) ?? 0) + 1);
        const orderedPartners = loader ? [loader.uid, ...partners.filter((uid) => uid !== loader.uid)] : partners;
        result.set(t.uid, assignment(crew.id, "truck", job, orderedPartners, t.uid));
      }
      for (const s of ss) result.set(s.uid, assignment(crew.id, "skid", job, partners, s.uid));
    }

    const sticky = new Map<number, { digger?: PlanMachine; trucks: PlanMachine[]; job?: PlanJob }>();
    if (prev) {
      for (const d of diggers) {
        if (usedDiggers.has(d.uid) || d.crewId) continue;
        const a = prev.get(d.uid);
        if (!a || a.role !== "digger" || !a.sourceId || reserved.has(a.team)) continue;
        const job = jobById.get(a.sourceId);
        if (!job || !jobStillValid(job.kind, job.tons) || !allowedJob(d, job)) continue;
        // A loader only sits on a face when there is no pile to haul. If a pile
        // shows up, drop the face so the team can go load it.
        if (d.defId !== "excavator" && job.kind === "vein") {
          const pileReady = areaJobs.some(
            (j) =>
              j.kind === "pile" &&
              jobStillValid(j.kind, j.tons) &&
              allowedJob(d, j) &&
              !(d.cargo > 0.15 && d.cargoOre && d.cargoOre === job.ore && j.ore !== job.ore),
          );
          if (pileReady) continue;
        }
        const slot = sticky.get(a.team) ?? { trucks: [], job };
        slot.digger = d;
        slot.job = job;
        sticky.set(a.team, slot);
      }
      for (const t of trucks) {
        if (usedTrucks.has(t.uid) || t.crewId) continue;
        const a = prev.get(t.uid);
        if (!a || a.role !== "truck" || reserved.has(a.team)) continue;
        const slot = sticky.get(a.team);
        if (!slot?.digger) continue;
        slot.trucks.push(t);
      }
    }

    for (const n of [...sticky.keys()].sort((a, b) => a - b)) {
      const slot = sticky.get(n)!;
      if (!slot.digger || !slot.job || takenJobs.has(slot.job.id) || usedDiggers.has(slot.digger.uid)) continue;
      const keep = slot.trucks.filter((t) => !usedTrucks.has(t.uid));
      takenJobs.add(slot.job.id);
      usedDiggers.add(slot.digger.uid);
      for (const t of keep) usedTrucks.add(t.uid);
      teams.push({ team: allocTeam(n), digger: slot.digger, trucks: keep, job: slot.job });
    }

    const fits = (d: PlanMachine, j: PlanJob) => {
      if (takenJobs.has(j.id) || !allowedJob(d, j)) return false;
      if (d.cargo > 0.15 && d.cargoOre && j.ore !== d.cargoOre) return false;
      if (d.workFace && j.kind === "vein") return j.id === d.workFace;
      if (d.defId === "excavator") return j.kind === "vein";
      const pilesOpen = workJobs.some(
        (p) =>
          p.kind === "pile" &&
          !takenJobs.has(p.id) &&
          allowedJob(d, p) &&
          !(d.cargo > 0.15 && d.cargoOre && p.ore !== d.cargoOre),
      );
      return pilesOpen ? j.kind === "pile" : j.kind === "vein";
    };

    for (;;) {
      let best: { d: PlanMachine; j: PlanJob; s: number } | null = null;
      for (const d of diggers) {
        if (usedDiggers.has(d.uid)) continue;
        for (const j of workJobs) {
          if (!fits(d, j)) continue;
          const d0 = dist(d, j);
          // Only a machine already on a face should stick there. A nearby
          // low-value pile must not beat a washable pile across the yard.
          const s = j.score / (d0 + 10) + (j.kind === "vein" && d0 < 16 ? 5000 : d0 < 40 ? 200 : 0);
          if (!best || s > best.s) best = { d, j, s };
        }
      }
      if (!best) break;
      teams.push({ team: allocTeam(), digger: best.d, trucks: [], job: best.j });
      usedDiggers.add(best.d.uid);
      takenJobs.add(best.j.id);
    }

    // A leftover loader can share a face the excavator is already on, instead of
    // standing around looking for a pile that is not there.
    for (const d of diggers) {
      if (usedDiggers.has(d.uid) || d.crewId) continue;
      let share: Team | null = null;
      let shareS = -Infinity;
      for (const team of teams) {
        if (team.job.kind !== "vein" || !allowedJob(d, team.job)) continue;
        if (d.defId === "excavator" && team.job.kind !== "vein") continue;
        const s = jobScore(d, team.job);
        if (s > shareS) {
          shareS = s;
          share = team;
        }
      }
      if (!share) continue;
      usedDiggers.add(d.uid);
      teams.push({ team: allocTeam(), digger: d, trucks: [], job: share.job });
    }

    // Do not permanently retarget a west payloader onto the heavy's east-bank job.
    // That parked the loader east all day and cut west dump-truck throughput.
    // One dump truck per digger stays in place; a free empty loader can still
    // visit the heavy (loaderToOrphanHeavy) without taking the trucks with it.

    const truckFits = (team: Team, t: PlanMachine, ignoreOre = false) => {
      if (team.trucks.length >= MAX_TEAM_TRUCKS) return false;
      if (t.workClaim != null && team.job.claim !== t.workClaim) return false;
      if (!ignoreOre && t.cargo > 0.15 && t.cargoOre && t.cargoOre !== team.job.ore) return false;
      return true;
    };
    const truckScore = (team: Team, t: PlanMachine, dumpsOnly = false) => {
      if (!truckFits(team, t)) return -Infinity;
      if (dumpsOnly && dumpCount(team) >= 1) return -Infinity;
      return -team.trucks.length * 10_000 + team.job.score - dist(t, team.digger) + (t.cargoOre === team.job.ore ? 500 : 0);
    };
    const assignTruck = (t: PlanMachine, scoreOf: (team: Team) => number) => {
      let best: Team | null = null;
      let bestS = -Infinity;
      for (const team of teams) {
        const s = scoreOf(team);
        if (s > bestS) {
          bestS = s;
          best = team;
        }
      }
      if (best && bestS > -Infinity) {
        best.trucks.push(t);
        usedTrucks.add(t.uid);
        return true;
      }
      return false;
    };

    // A truck already carrying a load stays on its previous team so it can dump
    // and come back, even if the team's job ore just changed.
    if (prev) {
      for (const t of trucks) {
        if (usedTrucks.has(t.uid) || t.crewId || t.cargo <= 0.15) continue;
        const a = prev.get(t.uid);
        if (!a || a.role !== "truck") continue;
        const team = teams.find((x) => x.team === a.team);
        if (team && truckFits(team, t, true)) {
          team.trucks.push(t);
          usedTrucks.add(t.uid);
        }
      }
    }

    // Give each digger a dump truck before any team gets a second, so a high-value
    // face cannot hoard every truck and leave a full loader waiting.
    for (const t of trucks) {
      if (t.defId !== "truck" || usedTrucks.has(t.uid)) continue;
      assignTruck(t, (team) => truckScore(team, t, true));
    }
    for (const t of trucks) {
      if (t.defId !== "truck" || usedTrucks.has(t.uid)) continue;
      assignTruck(t, (team) => truckScore(team, t, false));
    }
    for (const t of trucks) {
      if (t.defId !== "heavy" || usedTrucks.has(t.uid)) continue;
      assignTruck(t, (team) => {
        if (!truckFits(team, t)) return -Infinity;
        const loaderBonus = isWheelLoader(team.digger.defId) ? 8000 : 0;
        const bankBonus = t.area === "river" && bankOf(team.job.x) === bankOf(t.x) ? 12_000 : 0;
        return bankBonus + loaderBonus - team.trucks.length * 2000 + team.job.score - dist(t, team.digger);
      });
    }

    for (const team of teams) {
      const partners = [team.digger.uid, ...team.trucks.map((t) => t.uid)];
      result.set(team.digger.uid, assignment(team.team, "digger", team.job, partners, team.digger.uid));
      for (const t of team.trucks) {
        result.set(t.uid, assignment(team.team, "truck", team.job, partners, t.uid));
      }
    }

    for (const d of diggers) {
      if (!result.has(d.uid)) result.set(d.uid, assignment(0, "digger", null, [], d.uid));
    }
    for (const t of trucks) {
      if (!result.has(t.uid)) result.set(t.uid, assignment(0, "truck", null, [], t.uid));
    }

    const crumbs = areaJobs
      .filter((j) => j.kind === "crumb" && jobStillValid(j.kind, j.tons))
      .sort((a, b) => b.score - a.score || b.tons - a.tons);
    const takenCrumbs = new Set<string>();
    for (const s of skids) {
      if (result.has(s.uid) || s.crewId) continue;
      const prevA = prev?.get(s.uid);
      let job = s.workPile ? jobById.get(s.workPile) : undefined;
      if (!job && (s.cargo <= 0.15 || s.cargoOre === "iron")) {
        const starter = jobById.get("starter");
        if (starter && jobStillValid(starter.kind, starter.tons) && allowedJob(s, starter) &&
            !takenJobs.has(starter.id) && !takenCrumbs.has(starter.id)) job = starter;
      }
      if (!job && prevA?.role === "skid" && prevA.sourceId) {
        const held = jobById.get(prevA.sourceId);
        if (held && held.kind === "crumb" && jobStillValid(held.kind, held.tons) && allowedJob(s, held)) job = held;
      }
      if (!job) job = crumbs.find((j) => j.ore !== "dirt" && !takenCrumbs.has(j.id) && allowedJob(s, j));
      if (!job) {
        const smallPiles = areaJobs.filter((j) =>
          j.kind === "pile" && j.tons < SKID_CLEANUP_LIMIT && !takenJobs.has(j.id) &&
          !takenCrumbs.has(j.id) && allowedJob(s, j),
        );
        smallPiles.sort((a, b) => dist(s, a) - dist(s, b));
        job = smallPiles[0];
      }
      if (job) {
        takenCrumbs.add(job.id);
        result.set(s.uid, assignment(0, "skid", { ...job, kind: "crumb" }, [], s.uid));
        continue;
      }
      // Prefer ore faces to very small dirt spills or opening more overburden.
      const veins = areaJobs
        .filter((j) => j.kind === "vein" && jobStillValid(j.kind, j.tons) && allowedJob(s, j))
        .sort((a, b) => {
          const material = Number(a.ore === "dirt") - Number(b.ore === "dirt");
          if (material) return material;
          const da = dist(s, a);
          const db = dist(s, b);
          if (da < 16 !== db < 16) return da < 16 ? -1 : 1;
          return Number(takenJobs.has(a.id)) - Number(takenJobs.has(b.id)) || b.score - a.score;
        });
      const vein = veins[0];
      const dirtPile = (!vein || vein.ore === "dirt") && areaJobs.find((j) =>
        j.ore === "dirt" && j.kind === "crumb" &&
        !takenCrumbs.has(j.id) && !takenJobs.has(j.id) && allowedJob(s, j),
      );
      if (dirtPile) {
        takenCrumbs.add(dirtPile.id);
        result.set(s.uid, assignment(0, "skid", { ...dirtPile, kind: "crumb" }, [], s.uid));
      } else if (vein) {
        result.set(s.uid, assignment(0, "skid", vein, [], s.uid));
      } else {
        result.set(s.uid, assignment(0, "skid", null, [], s.uid));
      }
    }
  }

  return result;
}
