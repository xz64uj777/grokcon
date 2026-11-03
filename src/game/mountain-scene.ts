/** High mountain scenery: snowy ground, switchback road, snow-capped bench walls, peaks and pines. Looks only. */
import * as THREE from "three";
import { drapeMesh, heightAt } from "@/game/terrain";
import { MILL, MOUNTAIN_BOUNDS as B, SWITCHBACKS, GAP_HALF, X1, switchbackBlocks } from "@/game/mountain";

type Track = <T extends { dispose: () => void }>(g: T) => T;
type Std = (color: number, opts?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.MeshStandardMaterial;

function snowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#e9edf0";
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 260; i++) {
      const v = 205 + ((i * 53) % 45);
      g.fillStyle = `rgba(${v - 12},${v - 6},${v},0.35)`;
      g.fillRect((i * 37) % 128, (i * 71) % 128, 2 + (i % 4), 2 + (i % 3));
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildMountain(scene: THREE.Scene, track: Track, std: Std) {
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(320, 300, 160, 150)), std(0xdfe4e8, { map: track(snowTexture()), roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(X1, 0, 0);
  ground.receiveShadow = true;
  drapeMesh(ground, 0);
  scene.add(ground);

  // Ploughed gravel haul road: runs along each bench and turns through its gap.
  const road = std(0x7d7368, { roughness: 1 });
  const lane = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const m = new THREE.Mesh(track(new THREE.PlaneGeometry(9, len, 2, Math.max(2, Math.round(len / 2)))), road);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -Math.atan2(x1 - x0, z1 - z0);
    m.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    drapeMesh(m, 0.06);
    m.receiveShadow = true;
    scene.add(m);
  };
  let px = MILL.x;
  let pz = MILL.z;
  for (const w of SWITCHBACKS) {
    lane(px, pz, w.gapX, pz);
    lane(w.gapX, pz, w.gapX, w.z - 8);
    px = w.gapX;
    pz = w.z - 13;
  }
  lane(px, pz, X1 - 40, pz);

  // Snow caps on the bench walls.
  const snow = std(0xf4f7f9, { roughness: 0.9 });
  // Bench walls: rock that stays inside its collision footprint (two set-back steps).
  const wallRock = std(0x6b5a4a, { roughness: 0.95, flatShading: true });
  switchbackBlocks().forEach((b, i) => {
    const base = Math.floor(i / 2) * 5;
    const low = new THREE.Mesh(track(new THREE.BoxGeometry(b.sx, b.sy * 0.6, b.sz)), wallRock);
    low.position.set(b.x, base + b.sy * 0.3, b.z);
    const high = new THREE.Mesh(track(new THREE.BoxGeometry(b.sx - 0.6, b.sy * 0.4, b.sz * 0.7)), wallRock);
    high.position.set(b.x, base + b.sy * 0.8, b.z);
    for (const m of [low, high]) {
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
    }
  });
  switchbackBlocks().forEach((b, i) => {
    const cap = new THREE.Mesh(track(new THREE.BoxGeometry(b.sx - 0.6, 0.4, b.sz * 0.7)), snow);
    cap.position.set(b.x, Math.floor(i / 2) * 5 + b.sy + 0.2, b.z);
    cap.castShadow = true;
    scene.add(cap);
  });

  // Peaks around the edge and pines on the lower slopes.
  const rock = std(0x6e6a66, { roughness: 1, flatShading: true });
  const peakCap = std(0xf6f8fa, { roughness: 0.8, flatShading: true });
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const r = 120 + (i % 3) * 18;
    const h = 40 + ((i * 17) % 30);
    const g = new THREE.Group();
    const base = new THREE.Mesh(track(new THREE.ConeGeometry(h * 0.8, h, 6)), rock);
    base.position.y = h / 2;
    const top = new THREE.Mesh(track(new THREE.ConeGeometry(h * 0.3, h * 0.38, 6)), peakCap);
    top.position.y = h * 0.82;
    g.add(base, top);
    g.position.set(X1 + Math.cos(a) * r, 0, Math.sin(a) * r * 0.9);
    scene.add(g);
  }
  const pine = std(0x2f4a36, { roughness: 1, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const x = B.minX + 4 + ((i * 47) % (B.maxX - B.minX - 8));
    const z = 40 + ((i * 13) % 24);
    if (Math.abs(x - MILL.x) < 16 || SWITCHBACKS.some((w) => Math.abs(x - w.gapX) < GAP_HALF)) continue;
    const t = new THREE.Mesh(track(new THREE.ConeGeometry(1.6, 6, 7)), pine);
    t.position.set(x, heightAt(x, z) + 3, z + (i % 2 ? 3 : -2));
    t.castShadow = true;
    scene.add(t);
  }
}
