/** Grid density for scenery meshes (visual only; collision rules are independent). */
export function terrainMeshSegments(rich: boolean) {
  return rich
    ? { ridge: [170, 170] as const, mountain: [160, 150] as const }
    : { ridge: [128, 128] as const, mountain: [120, 112] as const };
}
