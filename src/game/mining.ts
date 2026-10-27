/**
 * Hands-on mining rules: overburden, ore purity, benches, wall slides, blasting.
 * Pure functions on a plain "seam" record so they can be tested on their own.
 */

export type Seam = {
  /** Tons of dirt still sitting on top of this face. */
  overburden: number;
  /** Best purity a clean cut can reach (0..1). */
  grade: number;
  /** Wall stress 0..1. At 1 the wall slides. */
  stress: number;
  /** Current bench (layer) number, starting at 1. */
  bench: number;
  /** Ore tons dug on this bench so far. */
  benchProgress: number;
  /** Hard rock digs slowly until it is blasted. */
  hard: boolean;
  /** A test hole has been drilled, so the grade and dirt depth are known. */
  tested: boolean;
};

export const BENCH_TONS = 100;
export const LAYER_OVERBURDEN = 30;
export const SLIDE_TONS = 25;
export const HARD_RATE = 0.45;
export const BLAST_TONS = 70;
export const BLAST_RADIUS = 22;
export const SAFE_DISTANCE = BLAST_RADIUS;
export const TEST_HOLE_COST = 150;
/** Flat price of one blast (one charge), paid when you start drilling. */
export const BLAST_COST = 750;
export const DRILL_SECONDS = 10;
export const FUSE_SECONDS = 6;
export const MIN_PURITY = 0.3;

export type CutResult = {
  /** true = ore came off, false = overburden dirt came off. */
  ore: boolean;
  tons: number;
  purity: number;
  slide: boolean;
  benched: boolean;
};

export function digRate(seam: Seam) {
  return seam.hard ? HARD_RATE : 1;
}

export function clampPurity(p: number) {
  return Math.max(MIN_PURITY, Math.min(1, p));
}

/** Clean scoop → purity near the face grade. Sloppy scoop → dirt mixed in. */
export function cutPurity(seam: Seam, quality: number, undercut: boolean) {
  const q = Math.max(0, Math.min(1, quality));
  return clampPurity(seam.grade * (0.7 + 0.3 * q) * (undercut ? 0.8 : 1));
}

/**
 * Take one bite out of a face. Mutates the seam.
 * cut "auto" (crew, Space key) always strips the top first, which is the safe way.
 * cut "toe" digs ore under the dirt. Quick, but stresses the wall and mixes dirt in.
 */
export function cutFace(seam: Seam, bite: number, cut: "top" | "toe" | "auto", quality: number): CutResult {
  const tons = Math.max(0, bite);
  const mode = cut === "auto" ? (seam.overburden > 0.05 ? "top" : "toe") : cut;
  if (mode === "top" && seam.overburden > 0.05) {
    const take = Math.min(tons, seam.overburden);
    seam.overburden -= take;
    if (seam.overburden < 0.05) seam.overburden = 0;
    seam.stress = Math.max(0, seam.stress - take / 30);
    return { ore: false, tons: take, purity: 1, slide: false, benched: false };
  }
  const undercut = seam.overburden > 0.05;
  const purity = cutPurity(seam, quality, undercut);
  let slide = false;
  if (undercut) {
    seam.stress += tons / 14;
    if (seam.stress >= 1) {
      seam.stress = 0;
      seam.overburden += SLIDE_TONS;
      slide = true;
    }
  } else {
    seam.stress = Math.max(0, seam.stress - tons / 60);
  }
  seam.benchProgress += tons;
  let benched = false;
  if (seam.benchProgress >= BENCH_TONS) {
    seam.benchProgress -= BENCH_TONS;
    seam.bench += 1;
    seam.overburden += LAYER_OVERBURDEN;
    benched = true;
  }
  return { ore: true, tons, purity, slide, benched };
}

export function mixPurity(aTons: number, aPurity: number, bTons: number, bPurity: number) {
  const t = aTons + bTons;
  if (t <= 1e-6) return bPurity;
  return clampPurity((aTons * aPurity + bTons * bPurity) / t);
}

/** Price factor for a load. Dirt is sold as dirt, so purity does not apply. */
export function purityFactor(ore: string, purity: number) {
  if (ore === "dirt") return 1;
  return clampPurity(purity);
}

/** One blast per face per in-game day. */
export function canBlastToday(lastBlastDay: number, today: number) {
  return lastBlastDay !== today;
}

export function blastYield(oreTons: number) {
  return Math.max(0, Math.min(oreTons, BLAST_TONS));
}

/** Damage (0..1) a machine takes from a blast at this distance. */
export function blastDamage(dist: number) {
  if (dist >= BLAST_RADIUS) return 0;
  return 0.6 * (1 - dist / BLAST_RADIUS);
}

export function repairCost(price: number, damage: number) {
  if (damage <= 0.001) return 0;
  return Math.round(150 + Math.max(price, 2000) * 0.06 * damage);
}

/** How much a damaged machine slows down (1 = like new). */
export function damageFactor(damage: number) {
  return 1 - Math.max(0, Math.min(1, damage)) * 0.5;
}
