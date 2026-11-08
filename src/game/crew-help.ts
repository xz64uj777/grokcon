import type { CrewCard } from "@/game/types";

type CrewStatus = Pick<CrewCard, "status" | "where" | "hired" | "operator" | "active">;

/** Explain only states that commonly leave players unsure what to do next. */
export function crewExplanation(crew: CrewStatus): string | null {
  if (crew.where === "On the lowboy") return "This machine is on the trailer and will be unloaded at its assigned map.";
  if (!crew.hired && !crew.active) return "Hire an operator if you want this machine to work while you drive another one.";
  if (crew.hired && !crew.operator) return "The operator is off duty. Turn them on to restart this machine.";
  if (crew.status === "Backing off a wall") return "It hit an obstacle and is backing up before trying to move again.";
  if (crew.status === "Backing off a pile") return "The pile is in the way. It backs off, then comes at it again.";
  if (crew.status === "Backing up") return "It is backing up to line up. There is no wall there.";
  if (crew.status === "Making room") return "Another machine is in the way. It will pull aside and go around.";
  if (crew.status.startsWith("Backing off ")) return "Backing away from the face is part of the dozer's normal push cycle; it should push again shortly.";
  if (crew.status === "Backed out of the west cliff") return "The west wall blocked its route, so it was moved back to safe ground.";
  if (crew.status === "Needs a payloader") return "A loader or excavator needs to bring material to this truck.";
  if (crew.status === "Waiting for a ready dump truck") return "The loader is holding its material here until its assigned truck is backed into the bay.";
  if (crew.status === "Waiting to load" || crew.status === "Waiting off the pile" || crew.status.startsWith("Waiting beside")) return "The truck is parked off to the side and stays there until the bed is loaded.";
  if (crew.status.startsWith("In line")) return "This truck is waiting its turn. It stays back until the one ahead is loaded.";
  if (crew.status.startsWith("Wash line")) return "Waiting its turn at the wash plant. Only one machine dumps at a time.";
  if (crew.status === "Staying off the pile") return "Keeping clear of the face. It only backs into the load bay from the open side.";
  if (crew.status === "In the load bay" || crew.status === "Backing into the bay" || crew.status === "Lining up at the bay" || crew.status === "Turning to back in") return "Backed into a bay clear of the pile, nose pointing out. It stays there until it is loaded, then drives straight out.";
  if (crew.status === "Waiting at the pile" || crew.status === "Back to the pile") return "Parked back from the pile. It stays there until a loader comes back to fill it.";
  if (crew.status === "Making a pile for the loader" || crew.status === "Stockpiling for the loader" || crew.status === "Stockpiled for the loader") return "Skid steers drop a pile off to the side. A loader or excavator loads that into the trucks.";
  if (crew.status.startsWith("Waiting on the ")) return "It is waiting for another machine to work nearby or come closer.";
  if (crew.status === "No material at assigned source") return "This source has no material to work right now. Choose another source in the crew settings.";
  if (crew.status === "No face in reach") return "There is no mineable face nearby. Check the selected source and map.";
  if (crew.status === "Looking for work") return "No suitable job is available here. Check that the right claim is leased and selected.";
  if (crew.status === "Bridge flooded") return "The bridge is temporarily closed by flooding. Wait for it to reopen.";
  if (crew.status === "Too heavy for the bridge") return "This machine is too heavy for the bridge. Use a lighter machine or another route.";
  if (crew.status === "Heading to the fuel pumps" || crew.status === "At the gas pump" || crew.status === "At the diesel pump") return "It is filling at the yard pump, which is cheaper than a delivery.";
  if (crew.status === "Towed to the fuel pumps") return "It ran dry on the mountain and was towed to the pumps.";
  if (crew.status === "Out of fuel") return "The tank is empty. Fill it at a pump, or order a delivery if you are driving it.";
  if (crew.status.startsWith("Hot brakes")) return "The brakes heated up on a steep loaded drop. It will slow down until they cool.";
  if (crew.status === "Heading to the rockslide" || crew.status === "Clearing the rockslide") return "One idle dozer or loader is opening the switchback. Assigned faces stay on the dig.";
  if (crew.status === "Heading to feed the plant" || crew.status.startsWith("Feeding the ")) return "It is one of the machines you sent to feed a plant. The rest stay on their job.";
  return null;
}
