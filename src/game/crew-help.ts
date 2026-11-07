import type { CrewCard } from "@/game/types";

type CrewStatus = Pick<CrewCard, "status" | "where" | "hired" | "operator" | "active">;

/** Explain only states that commonly leave players unsure what to do next. */
export function crewExplanation(crew: CrewStatus): string | null {
  if (crew.where === "On the lowboy") return "This machine is on the trailer and will be unloaded at its assigned map.";
  if (!crew.hired && !crew.active) return "Hire an operator if you want this machine to work while you drive another one.";
  if (crew.hired && !crew.operator) return "The operator is off duty. Turn them on to restart this machine.";
  if (crew.status === "Backing off a wall") return "It hit an obstacle and is backing up before trying to move again.";
  if (crew.status.startsWith("Backing off ")) return "Backing away from the face is part of the dozer's normal push cycle; it should push again shortly.";
  if (crew.status === "Backed out of the west cliff") return "The west wall blocked its route, so it was moved back to safe ground.";
  if (crew.status === "Needs a payloader") return "A loader or excavator needs to bring material to this truck.";
  if (crew.status.startsWith("Waiting on the ")) return "It is waiting for another machine to work nearby or come closer.";
  if (crew.status === "No material at assigned source") return "This source has no material to work right now. Choose another source in the crew settings.";
  if (crew.status === "No face in reach") return "There is no mineable face nearby. Check the selected source and map.";
  if (crew.status === "Looking for work") return "No suitable job is available here. Check that the right claim is leased and selected.";
  if (crew.status === "Bridge flooded") return "The bridge is temporarily closed by flooding. Wait for it to reopen.";
  if (crew.status === "Too heavy for the bridge") return "This machine is too heavy for the bridge. Use a lighter machine or another route.";
  return null;
}
