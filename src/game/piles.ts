/** Loose pile size and shape from tonnage. Bulk rock is about 1.7 t/m³ and settles at ~37° (height ≈ 0.75 × radius). */
export const BULK_DENSITY = 1.7;
export const REPOSE = 0.75;

export type PileShape = { kind: "heap" | "cone" | "windrow"; radius: number; height: number; stretch: number };

export function pileShape(tons: number): PileShape {
  const t = Math.max(0, tons);
  const vol = t / BULK_DENSITY;
  // Cone volume π r² h / 3 with h = 0.75 r.
  const r = Math.max(0.6, Math.cbrt(vol / ((Math.PI * REPOSE) / 3)));
  if (t < 6) return { kind: "heap", radius: r, height: r * 0.55, stretch: 1 };
  if (t < 60) return { kind: "cone", radius: r, height: r * REPOSE, stretch: 1 };
  // Big stockpiles are pushed out into a long ridge: same volume, longer and lower.
  const stretch = Math.min(2.2, 1 + (t - 60) / 120);
  const rr = r / Math.sqrt(stretch);
  return { kind: "windrow", radius: rr, height: rr * REPOSE, stretch };
}

/** Solid heart of a loose pile. The outside is loose rock you can dig; the middle stops a machine. */
export function pileFootprint(tons: number) {
  const s = pileShape(Math.max(0.4, tons));
  return { rx: s.radius * 0.62, rz: s.radius * s.stretch * 0.62 };
}
