import { test } from "node:test";
import assert from "node:assert/strict";
import { crewExplanation } from "@/game/crew-help";

const crew = (status: string, extra: Partial<Parameters<typeof crewExplanation>[0]> = {}) => ({
  status,
  where: "",
  hired: true,
  operator: true,
  active: false,
  ...extra,
});

test("crew explanations tell players how to respond to common blockers", () => {
  assert.match(crewExplanation(crew("Backing off a wall")) ?? "", /obstacle/);
  assert.match(crewExplanation(crew("Making room")) ?? "", /go around/);
  assert.match(crewExplanation(crew("Backing off Deep Copper")) ?? "", /normal push cycle/);
  assert.match(crewExplanation(crew("Needs a payloader")) ?? "", /loader or excavator/);
  assert.match(crewExplanation(crew("Waiting for a ready dump truck")) ?? "", /assigned truck is backed into the bay/);
  assert.match(crewExplanation(crew("Waiting on the Excavator")) ?? "", /waiting for another machine/);
  assert.match(crewExplanation(crew("No material at assigned source")) ?? "", /Choose another source/);
  assert.match(crewExplanation(crew("Bridge flooded")) ?? "", /Wait for it to reopen/);
  assert.match(crewExplanation(crew("Heading to the fuel pumps")) ?? "", /yard pump/);
  assert.match(crewExplanation(crew("Hot brakes · pull out or ease off")) ?? "", /slow down/);
  assert.match(crewExplanation(crew("Clearing the rockslide")) ?? "", /Assigned faces/);
  assert.match(crewExplanation(crew("Heading to feed the plant")) ?? "", /rest stay/);
});

test("crew explanations suggest hiring or resuming operators and stay quiet for normal work", () => {
  assert.match(crewExplanation(crew("Parked", { hired: false })) ?? "", /Hire an operator/);
  assert.match(crewExplanation(crew("Parked", { operator: false })) ?? "", /off duty/);
  assert.equal(crewExplanation(crew("Working Gold Gravel")), null);
});
