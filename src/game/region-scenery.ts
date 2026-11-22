/**
 * Decide when distant scenery is actually needed. The mining simulation retains
 * every region and its save data; only the expensive display meshes are lazy.
 */
import { areaOf, UNLOCK_CLAIM, VALLEY_CLAIMS } from "@/game/river";
import { MOUNTAIN_CLAIM } from "@/game/mountain";

export type DistantRegion = "river" | "mountain";

export type RegionAccess = {
  claims: readonly number[];
  vehicles: readonly { x: number }[];
};

export function needsDistantScenery(state: RegionAccess, region: DistantRegion): boolean {
  // Existing vehicles (including from imported saves) must never enter
  // missing scenery even if the owning claim is absent or corrupted.
  if (state.vehicles.some((vehicle) => areaOf(vehicle.x) === region)) return true;
  if (region === "river") return state.claims.includes(UNLOCK_CLAIM);
  return state.claims.includes(MOUNTAIN_CLAIM) ||
    state.claims.includes(VALLEY_CLAIMS.quarry) ||
    state.claims.includes(VALLEY_CLAIMS.rim);
}
