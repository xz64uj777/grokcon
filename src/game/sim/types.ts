/** Shared control and step types for the sim. */

import type { OreId } from "@/game/types";

export type Control = {
  throttle: number;
  steer: number;
  action: boolean;
  brake: number;
};


export type StepFX = {
  dig: boolean;
  blasts: { x: number; z: number }[];
  sales: { x: number; z: number; text: string; player: boolean }[];
  breaks: { x: number; z: number; tx: number; tz: number; ore: OreId }[];
};

/** How the action key/gesture is being used this frame. */

/** How the action key/gesture is being used this frame. */
export type WorkOpts = {
  phase: "auto" | "fill" | "dump";
  cut: "auto" | "top" | "toe";
  quality: number;
};


export const AUTO_PLAYER: WorkOpts = { phase: "auto", cut: "auto", quality: 0.8 };

export const AUTO_CREW: WorkOpts = { phase: "auto", cut: "auto", quality: 0.85 };


export const ZERO: Control = { throttle: 0, steer: 0, action: false, brake: 0 };
