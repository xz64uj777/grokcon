/** Simulation entry. Public functions stay on this module so existing imports do not change. */

export type { Control, StepFX, WorkOpts } from "./sim/types.ts";
export { MARKET_PADS, MARKET_KEYS, unitPrice, basePrice, contractUnit } from "./sim/economy.ts";
export { faceOf, gateFor, claimAreaOf, vehicleStats, freshGame, padOpen, homeClaim, currentArea, valleyOpen, areaName, mountainUnlockable, mountainOpen, haulTarget, haulFee } from "./sim/world.ts";
export { FEED_PADS, dumpsToFeed, FEED_RATES, YARD_FEED_RATE, YARD_FEED_KEEP, FEED_REACH, FEED_CALL_RANGE, feedId, addFeedPile } from "./sim/feed.ts";
export { plannedPad, SHORT_CARRY_RANGE } from "./sim/jobs.ts";
export { DIGGER_HOLD_SECONDS, TRUCK_IDLE_SECONDS, loadTruck } from "./sim/haulers.ts";
export { BAY_YIELD_SECONDS } from "./sim/bay.ts";
export { trailerCircles } from "./sim/motion.ts";
export { ROAD_CLEAR_BONUS, spawnRockslide, rainNow, groundFactor, blastEscapeTarget, blastPilePoint, drillTestHole, blastPrice, startBlast } from "./sim/blast.ts";
export { assignCrew, setCrewSource, setCrewDest, setFeeder, feederOptions, teamSourceOptions, teamDestOptions, refreshCrewPlan, crewAssignment, crewDisplayStatus } from "./sim/crew.ts";
export { lotButtons, lotBuy, setControlMode, shiftGear, repairVehicle, overhaulVehicle, buyVehicle, buyWashPlant, ensureLowboy, toggleDeck, sourceOptions, haulMachine, goOtherArea, buySluicePlant, buyClaim, buyUpgrade, toggleCrew, sellVehicle, setActive } from "./sim/office.ts";
export { nearPileLabel, buildHud, opsCtx, opsAction } from "./sim/hud.ts";
export { step } from "./sim/tick.ts";
