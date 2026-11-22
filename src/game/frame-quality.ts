/** Dynamic resolution scaling for mobile GPUs.
 * The fixed-step simulation stays at 60 Hz; only 3D render pixel density adapts.
 * Recovery is deliberately slower than degradation to avoid visible oscillation.
 */
export function createAdaptiveResolution() {
  let scale = 1;
  let seconds = 0;
  let frames = 0;
  let fastWindows = 0;

  function sample(dt: number): boolean {
    // Ignore tab suspension and invalid browser timings.
    if (!Number.isFinite(dt) || dt <= 0 || dt >= 0.2) return false;
    seconds += dt;
    frames++;
    if (seconds < 2) return false;

    const fps = frames / seconds;
    seconds = 0;
    frames = 0;

    if (fps < 43 && scale > 0.65) {
      scale = Math.max(0.65, Math.round((scale - 0.1) * 100) / 100);
      fastWindows = 0;
      return true;
    }

    if (fps > 56 && scale < 1) {
      fastWindows++;
      if (fastWindows >= 4) {
        scale = Math.min(1, Math.round((scale + 0.05) * 100) / 100);
        fastWindows = 0;
        return true;
      }
    } else {
      fastWindows = 0;
    }
    return false;
  }

  return { get scale() { return scale; }, sample };
}
