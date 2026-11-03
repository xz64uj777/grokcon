/**
 * Ground height. One pure function so the sim (grades, roll-back, tipping) and the
 * renderer (ground mesh, machines, piles, camera) agree on the same hills.
 *
 * - Ridge pit: the floor sits 3.5 m down, with a ramp up through the pit gate.
 * - High mountain: each switchback bench is 5 m higher than the one below. The
 *   bench walls are the steep step; the gaps are ramps (about 20% at the steepest).
 * - Rolling ground elsewhere in the mountain; the valley stays flat (river plain).
 */
import { GAP_HALF, MOUNTAIN_SPLIT, SWITCHBACKS } from "@/game/mountain";

export const PIT_DEPTH = 3.5;
export const BENCH_RISE = 5;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function pitHeight(x: number, z: number) {
  // Pit floor box (inside the walls), eased at the edges; the gate ramp climbs z 2 → 20.
  // Edges ease inside the pit walls, so the drivable floor stays level.
  const inX = smooth(-60, -52, x) * (1 - smooth(40, 48, x));
  const inZ = (1 - smooth(-6, 20, z)) * smooth(-60, -52, z);
  return -PIT_DEPTH * inX * inZ;
}

function mountainHeight(x: number, z: number) {
  let h = 0;
  for (const w of SWITCHBACKS) {
    // Distance into the gap (1 = middle of the ramp, 0 = solid bench wall).
    const gap = 1 - smooth(GAP_HALF - 4, GAP_HALF + 2, Math.abs(x - w.gapX));
    const half = 3 + gap * 15; // wall: steep 6 m step; gap: 36 m ramp
    h += BENCH_RISE * smooth(w.z + half, w.z - half, z);
  }
  h += Math.sin(x * 0.07) * Math.cos(z * 0.09) * 0.5;
  return h;
}

export function heightAt(x: number, z: number) {
  if (x > MOUNTAIN_SPLIT) return mountainHeight(x, z);
  if (x < 500) return pitHeight(x, z);
  return 0;
}

/** Grade along a heading (rise/run, + is uphill) and across it (+ means the right side is high). */
export function gradeAt(x: number, z: number, yaw: number) {
  const e = 1.2;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const along = (heightAt(x + fx * e, z + fz * e) - heightAt(x - fx * e, z - fz * e)) / (2 * e);
  const rx = -fz;
  const rz = fx;
  const side = (heightAt(x + rx * e, z + rz * e) - heightAt(x - rx * e, z - rz * e)) / (2 * e);
  return { along, side };
}

/** Top-speed share when climbing: steeper grades slow a machine down. Downhill does not speed it past its cap. */
export function climbFactor(along: number, forward: boolean) {
  const up = forward ? along : -along;
  return up > 0 ? Math.max(0.35, 1 - up * 2.4) : 1;
}

/** Gravity's pull along the slope (m/s²), scaled for rolling resistance. */
export function rollAccel(along: number) {
  return -9.8 * along * 0.55;
}

/** Bake a flat mesh into world space and lay every vertex on the ground (plus a small lift). Render only. */
export function drapeMesh(mesh: { updateMatrix: () => void; matrix: unknown; geometry: { applyMatrix4: (m: never) => void; attributes: Record<string, { count: number; getX: (i: number) => number; getZ: (i: number) => number; setY: (i: number, y: number) => void; needsUpdate: boolean }>; computeVertexNormals: () => void }; position: { set: (x: number, y: number, z: number) => void }; rotation: { set: (x: number, y: number, z: number) => void }; scale: { set: (x: number, y: number, z: number) => void } }, lift: number) {
  mesh.updateMatrix();
  mesh.geometry.applyMatrix4(mesh.matrix as never);
  mesh.position.set(0, 0, 0);
  mesh.rotation.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  const pos = mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)) + lift);
  pos.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}
