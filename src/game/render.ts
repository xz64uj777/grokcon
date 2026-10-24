import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as THREE from "three";
import { BLOCKS, BOUNDS, DEFS, GATE, ORES, PADS, PIT, type BlockKind } from "@/game/catalog";
import type { Deposit, GameState, VehicleId } from "@/game/types";
import { vehicleStats } from "@/game/sim";

const CAMS = [14, 20, 28];

type Rig = {
  root: THREE.Group;
  wheels: THREE.Object3D[];
  spin: number;
  bucket: THREE.Object3D | null;
  boom: THREE.Object3D | null;
  house: THREE.Object3D | null;
  bed: THREE.Object3D | null;
  blade: THREE.Object3D | null;
  load: THREE.Object3D | null;
  dump: number;
  uid: string;
};

type DepositView = {
  group: THREE.Group;
  lease: boolean;
  sign: THREE.Sprite;
  ownedTex: THREE.Texture;
  leaseTex: THREE.Texture;
};

const _look = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _proj = new THREE.Vector3();

export type World = {
  sync: (state: GameState, dt: number, follow: boolean) => void;
  orbit: (dt: number) => void;
  kick: (n: number) => void;
  snap: () => void;
  cycleCam: () => void;
  project: (x: number, y: number, z: number, w: number, h: number) => { x: number; y: number } | null;
  resize: () => void;
  dispose: () => void;
};

export function createWorld(host: HTMLElement): World {
  const canvas = document.createElement("canvas");
  canvas.className = "absolute inset-0 h-full w-full";
  host.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.setClearColor(0xc48462, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc48462);
  scene.fog = new THREE.Fog(0xc49072, 70, 210);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.2, 320);
  camera.position.set(30, 24, 70);

  const hemi = new THREE.HemisphereLight(0xffe0c4, 0x3a2e24, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd7b0, 3.1);
  sun.position.set(48, 72, 26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -90;
  sun.shadow.camera.right = 90;
  sun.shadow.camera.top = 90;
  sun.shadow.camera.bottom = -90;
  sun.shadow.camera.near = 8;
  sun.shadow.camera.far = 180;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x8fb4c8, 0.55);
  fill.position.set(-40, 30, -20);
  scene.add(fill);

  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(g: T) => {
    disposables.push(g);
    return g;
  };

  const std = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.04, ...opts });
    track(m);
    return m;
  };

  const paint = std(0xe6b325, { roughness: 0.5, metalness: 0.12 });
  const paintDark = std(0xb68416, { roughness: 0.55, metalness: 0.1 });
  const cabMat = std(0x221f1c, { roughness: 0.4, metalness: 0.25 });
  const glass = std(0xb7d7e2, { roughness: 0.12, metalness: 0.15, transparent: true, opacity: 0.55 });
  const tire = std(0x1a1917, { roughness: 0.95, metalness: 0.02 });
  const steel = std(0x8d949b, { roughness: 0.32, metalness: 0.72 });
  const rust = std(0x8d4d34, { roughness: 0.72, metalness: 0.12 });
  const cream = std(0xd7cdc0, { roughness: 0.6, metalness: 0.05 });
  const white = std(0xe7e2d8, { roughness: 0.46, metalness: 0.08 });
  const orange = std(0xe26a2c, { roughness: 0.5, metalness: 0.1 });
  const beaconMat = std(0xe26a2c, { emissive: 0xe26a2c, emissiveIntensity: 0.7, roughness: 0.4 });
  const brassMat = std(0xe6b325, { emissive: 0xe6b325, emissiveIntensity: 0.45, roughness: 0.4 });

  const blockMat: Record<BlockKind, THREE.MeshStandardMaterial> = {
    wall: std(0x6e5842, { roughness: 0.95 }),
    building: std(0x4a514f, { roughness: 0.7, metalness: 0.18 }),
    rock: std(0x5a554e, { roughness: 0.95 }),
  };

  const buckets = new Map<BlockKind, THREE.BufferGeometry[]>();
  for (const b of BLOCKS) {
    const g = new THREE.BoxGeometry(b.sx, b.sy, b.sz);
    g.translate(b.x, b.sy / 2, b.z);
    const list = buckets.get(b.kind) ?? [];
    list.push(g);
    buckets.set(b.kind, list);
  }
  for (const [kind, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    track(merged);
    const mesh = new THREE.Mesh(merged, blockMat[kind]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  const groundTex = track(makeGroundTexture());
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(340, 340)), std(0xffffff, { map: groundTex, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const pitMat = std(0x3c342c, { roughness: 1 });
  const pit = new THREE.Mesh(track(new THREE.CircleGeometry(1, 48)), pitMat);
  pit.rotation.x = -Math.PI / 2;
  pit.position.set(PIT.x, 0.025, PIT.z);
  pit.scale.set(PIT.rx, PIT.rz, 1);
  pit.receiveShadow = true;
  scene.add(pit);
  const bench = new THREE.Mesh(track(new THREE.RingGeometry(0.62, 0.78, 40)), std(0x5c4b3a, { roughness: 1 }));
  bench.rotation.x = -Math.PI / 2;
  bench.position.set(PIT.x, 0.03, PIT.z);
  bench.scale.set(PIT.rx, PIT.rz, 1);
  bench.receiveShadow = true;
  scene.add(bench);

  const roadMat = std(0x3a342c, { roughness: 1 });
  addRoad(scene, track, roadMat, 7, 34, -1, 34);
  addRoad(scene, track, roadMat, 28, 12, 22, 30);
  addRoad(scene, track, roadMat, 78, 8, -40, 22);

  const wheelGeo = track(new THREE.CylinderGeometry(0.46, 0.46, 0.38, 12));
  const hubGeo = track(new THREE.CylinderGeometry(0.16, 0.16, 0.42, 8));

  function addWheel(parent: THREE.Object3D, x: number, y: number, z: number) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const mesh = new THREE.Mesh(wheelGeo, tire);
    mesh.rotation.z = Math.PI / 2;
    g.add(mesh);
    const hub = new THREE.Mesh(hubGeo, steel);
    hub.rotation.z = Math.PI / 2;
    g.add(hub);
    parent.add(g);
    return g;
  }

  function box(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, shadow = true) {
    const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  const rigs = new Map<string, Rig>();
  const depositViews = new Map<string, DepositView>();
  let companyTex: THREE.Texture | null = null;
  let companySign: THREE.Sprite | null = null;
  let lastCompany = "";

  function buildRig(id: VehicleId, uid: string): Rig {
    const root = new THREE.Group();
    const wheels: THREE.Object3D[] = [];
    let bucket: THREE.Object3D | null = null;
    let boom: THREE.Object3D | null = null;
    let house: THREE.Object3D | null = null;
    let bed: THREE.Object3D | null = null;
    let blade: THREE.Object3D | null = null;
    let load: THREE.Object3D | null = null;
    const body = id === "pickup" ? rust : id === "truck" ? white : id === "heavy" ? orange : paint;
    const trim = id === "pickup" ? cream : id === "truck" ? orange : paintDark;

    if (id === "pickup") {
      box(root, 1.55, 0.32, 3.5, 0, 0.7, 0.1, body);
      box(root, 1.4, 0.85, 1.25, 0, 1.25, -0.55, cream);
      box(root, 1.15, 0.55, 1.05, 0, 1.35, -0.55, glass, false);
      box(root, 1.35, 0.28, 0.85, 0, 0.9, -1.55, body);
      box(root, 1.5, 0.4, 1.55, 0, 0.95, 1.05, trim);
      load = makeCargoLoad(root, 1.3, 0.35, 1.3, 0, 1.25, 1.05);
      wheels.push(addWheel(root, -0.85, 0.46, -1.15), addWheel(root, 0.85, 0.46, -1.15));
      wheels.push(addWheel(root, -0.85, 0.46, 1.05), addWheel(root, 0.85, 0.46, 1.05));
    } else if (id === "skid") {
      box(root, 1.35, 0.55, 1.7, 0, 0.7, 0.1, body);
      box(root, 1.15, 0.7, 0.9, 0, 1.25, 0.25, cabMat);
      box(root, 0.9, 0.4, 0.7, 0, 1.35, 0.2, glass, false);
      box(root, 0.12, 0.12, 1.5, -0.55, 1.15, -0.55, steel);
      box(root, 0.12, 0.12, 1.5, 0.55, 1.15, -0.55, steel);
      bucket = new THREE.Group();
      bucket.position.set(0, 0.55, -1.35);
      box(bucket, 1.4, 0.42, 0.48, 0, 0.15, 0, steel);
      // Short cutting edge and individual teeth, rather than a smooth toy-like bucket.
      box(bucket, 1.44, 0.1, 0.12, 0, -0.06, -0.28, paintDark);
      for (let i = 0; i < 5; i++) {
        const tooth = new THREE.Mesh(track(new THREE.ConeGeometry(0.075, 0.24, 5)), steel);
        tooth.rotation.x = -Math.PI / 2;
        tooth.position.set(-0.56 + i * 0.28, -0.08, -0.39);
        bucket.add(tooth);
      }
      root.add(bucket);
      load = makeCargoLoad(bucket, 1.1, 0.22, 0.28, 0, 0.28, 0.05);
      box(root, 0.28, 0.32, 1.5, -0.72, 0.4, 0, cabMat);
      box(root, 0.28, 0.32, 1.5, 0.72, 0.4, 0, cabMat);
    } else if (id === "dozer") {
      box(root, 0.42, 0.45, 2.5, -0.85, 0.45, 0, cabMat);
      box(root, 0.42, 0.45, 2.5, 0.85, 0.45, 0, cabMat);
      box(root, 1.5, 0.7, 2.3, 0, 0.95, 0.15, body);
      box(root, 1.25, 0.75, 1.05, 0, 1.6, 0.15, cabMat);
      box(root, 1.05, 0.45, 0.85, 0, 1.7, 0.1, glass, false);
      blade = new THREE.Group();
      blade.position.set(0, 0.55, -1.7);
      box(blade, 2.15, 0.85, 0.22, 0, 0.35, 0, steel);
      root.add(blade);
      box(root, 0.45, 0.35, 0.7, 0, 0.7, 1.45, trim);
    } else if (id === "loader") {
      wheels.push(addWheel(root, -0.95, 0.62, -1.15), addWheel(root, 0.95, 0.62, -1.15));
      wheels.push(addWheel(root, -0.95, 0.62, 1.25), addWheel(root, 0.95, 0.62, 1.25));
      box(root, 1.7, 0.7, 2.8, 0, 1.15, 0.2, body);
      box(root, 1.4, 0.9, 1.2, 0, 1.85, 0.55, cabMat);
      box(root, 1.15, 0.5, 1.0, 0, 1.95, 0.5, glass, false);
      box(root, 0.16, 0.16, 2.1, -0.45, 1.55, -1.15, steel);
      box(root, 0.16, 0.16, 2.1, 0.45, 1.55, -1.15, steel);
      bucket = new THREE.Group();
      bucket.position.set(0, 0.7, -2.15);
      box(bucket, 2.05, 0.7, 0.7, 0, 0.25, 0, steel);
      // Wide loader cutting lip with five distinct replaceable-looking teeth.
      box(bucket, 2.08, 0.12, 0.16, 0, -0.08, -0.38, paintDark);
      for (let i = 0; i < 7; i++) {
        const tooth = new THREE.Mesh(track(new THREE.ConeGeometry(0.09, 0.28, 5)), steel);
        tooth.rotation.x = -Math.PI / 2;
        tooth.position.set(-0.82 + i * 0.273, -0.11, -0.49);
        bucket.add(tooth);
      }
      root.add(bucket);
      load = makeCargoLoad(bucket, 1.7, 0.35, 0.45, 0, 0.55, 0.05);
    } else if (id === "excavator") {
      box(root, 0.45, 0.4, 2.6, -0.7, 0.4, 0.1, cabMat);
      box(root, 0.45, 0.4, 2.6, 0.7, 0.4, 0.1, cabMat);
      house = new THREE.Group();
      house.position.set(0, 0.85, 0.2);
      box(house, 1.7, 0.7, 2.0, 0, 0.45, 0, body);
      box(house, 1.2, 0.7, 1.15, 0, 1.1, 0.15, cabMat);
      box(house, 1.05, 0.45, 1.0, 0, 1.15, 0.1, glass, false);
      box(house, 0.8, 0.45, 0.7, 0, 0.7, 1.15, trim);
      boom = new THREE.Group();
      boom.position.set(0, 0.9, -0.7);
      box(boom, 0.28, 0.28, 1.7, 0, 0.55, -0.7, paintDark);
      const stick = new THREE.Group();
      stick.position.set(0, 0.7, -1.45);
      box(stick, 0.22, 0.22, 1.25, 0, -0.25, -0.45, steel);
      bucket = new THREE.Group();
      bucket.position.set(0, -0.45, -1.05);
      box(bucket, 0.85, 0.45, 0.5, 0, -0.05, 0, steel);
      for (let i = 0; i < 4; i++) {
        const tooth = new THREE.Mesh(track(new THREE.ConeGeometry(0.06, 0.18, 5)), steel);
        tooth.rotation.x = -Math.PI / 2;
        tooth.position.set(-0.3 + i * 0.2, -0.2, -0.3);
        bucket.add(tooth);
      }
      load = makeCargoLoad(bucket, 0.65, 0.22, 0.32, 0, 0.12, 0.02);
      stick.add(bucket);
      boom.add(stick);
      house.add(boom);
      root.add(house);
    } else {
      const len = id === "heavy" ? 1.25 : 1;
      box(root, 1.7 * len, 0.45, 2.1, 0, 1.05, -1.7 * len, body);
      box(root, 1.55 * len, 1.15, 1.5, 0, 1.7, -2.15 * len, cabMat);
      box(root, 1.3 * len, 0.6, 1.25, 0, 1.85, -2.15 * len, glass, false);
      bed = new THREE.Group();
      bed.position.set(0, 1.15, 1.55 * len);
      box(bed, 1.9 * len, 0.85, 3.3 * len, 0, 0.45, -1.3 * len, trim);
      box(bed, 1.7 * len, 0.12, 3.0 * len, 0, 0.12, -1.3 * len, steel, false);
      load = makeCargoLoad(bed, 1.6 * len, 0.55, 2.6 * len, 0, 0.5, -1.3 * len);
      root.add(bed);
      const wx = 0.95 * len;
      wheels.push(addWheel(root, -wx, 0.52, -2.2 * len), addWheel(root, wx, 0.52, -2.2 * len));
      wheels.push(addWheel(root, -wx, 0.55, 0.35 * len), addWheel(root, wx, 0.55, 0.35 * len));
      wheels.push(addWheel(root, -wx, 0.55, 1.45 * len), addWheel(root, wx, 0.55, 1.45 * len));
    }

    const shadow = new THREE.Mesh(track(new THREE.CircleGeometry(DEFS[id].radius * 0.95, 14)), std(0x000000, { transparent: true, opacity: 0.28, roughness: 1 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.04;
    root.add(shadow);
    scene.add(root);
    return { root, wheels, spin: 0, bucket, boom, house, bed, blade, load, dump: 0, uid };
  }

  const rockGeometries = [
    track(new THREE.DodecahedronGeometry(1, 0)),
    track(new THREE.IcosahedronGeometry(1, 0)),
    track(new THREE.TetrahedronGeometry(1, 0)),
  ];
  function oreMat(ore: number) {
    return std(ore, { roughness: 0.96, flatShading: true });
  }
  const oreMaterials: Record<string, THREE.MeshStandardMaterial> = {
    dirt: oreMat(ORES.dirt.color),
    iron: oreMat(ORES.iron.color),
    copper: oreMat(ORES.copper.color),
    gold: oreMat(ORES.gold.color),
  };
  function makeCargoLoad(parent: THREE.Object3D, width: number, height: number, depth: number, x: number, y: number, z: number): THREE.Group {
    const pile = new THREE.Group();
    pile.position.set(x, y, z);
    const count = Math.max(7, Math.min(24, Math.round(width * depth * 5)));
    for (let i = 0; i < count; i++) {
      const size = 0.11 + ((i * 7) % 5) * 0.025;
      const rock = new THREE.Mesh(rockGeometries[i % rockGeometries.length], oreMaterials.iron);
      const angle = i * 2.399963229728653;
      const radius = Math.sqrt((i + 0.5) / count);
      rock.position.set(
        Math.cos(angle) * radius * width * 0.43,
        (0.22 + ((i * 3) % 5) * 0.12) * height,
        Math.sin(angle) * radius * depth * 0.43,
      );
      rock.rotation.set(i * 0.61, angle, i * 0.37);
      rock.scale.set(size * 1.15, size * 0.8, size);
      rock.castShadow = true;
      rock.receiveShadow = true;
      pile.add(rock);
    }
    parent.add(pile);
    return pile;
  }

  const lockedMat = std(0x4a463f, { roughness: 1, flatShading: true });
  function makeDeposit(d: Deposit): DepositView {
    const group = new THREE.Group();
    const mat = oreMaterials[d.ore];
    // Many small, irregular fragments read as broken ore/gravel rather than
    // a few oversized boulders. The vein still has a rough exposed-rock core.
    const count = d.kind === "vein" ? 30 : 22;
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(rockGeometries[i % rockGeometries.length], mat);
      const angle = i * 2.399963229728653;
      const ring = 0.22 + Math.sqrt((i + 0.5) / count) * (d.kind === "vein" ? 2.05 : 1.8);
      const size = d.kind === "vein"
        ? 0.18 + ((i * 7) % 9) * 0.035
        : 0.12 + ((i * 5) % 7) * 0.028;
      mesh.position.set(Math.cos(angle) * ring, size * 0.62, Math.sin(angle) * ring);
      mesh.rotation.set((i * 0.71) % 1.8, angle, (i * 0.43) % 1.2);
      mesh.scale.set(size * (0.8 + (i % 3) * 0.18), size * (0.65 + (i % 4) * 0.12), size * (0.75 + (i % 5) * 0.1));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    if (d.kind === "vein") {
      // A low, fractured outcrop beneath the loose fragments.
      const core = new THREE.Mesh(rockGeometries[0], mat);
      core.position.set(0, 0.24, 0);
      core.scale.set(1.25, 0.42, 1.05);
      core.rotation.set(0.18, 0.4, -0.12);
      core.castShadow = true;
      core.receiveShadow = true;
      group.add(core);
    }
    group.position.set(d.x, 0, d.z);
    scene.add(group);
    const ownedTex = track(textTexture(d.sign, "#e6b325"));
    const leaseTex = track(textTexture(`${d.sign}  LEASE`, "#e26a2c"));
    const sign = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: ownedTex, transparent: true, depthWrite: false, fog: false })));
    sign.position.set(d.x, 5.2, d.z);
    sign.scale.set(7.2, 3.4, 1);
    scene.add(sign);
    return { group, lease: false, sign, ownedTex, leaseTex };
  }

  for (const pad of PADS) {
    const ring = new THREE.Mesh(
      track(new THREE.TorusGeometry(pad.r * 0.72, 0.14, 6, 28)),
      pad.kind === "sluice" ? brassMat : beaconMat,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(pad.x, 0.08, pad.z);
    scene.add(ring);
    const pole = new THREE.Mesh(track(new THREE.CylinderGeometry(0.08, 0.08, 4.5, 6)), steel);
    pole.position.set(pad.x, 2.3, pad.z);
    scene.add(pole);
    const lamp = new THREE.Mesh(track(new THREE.SphereGeometry(0.28, 10, 8)), pad.kind === "reclaim" ? brassMat : beaconMat);
    lamp.position.set(pad.x, 4.6, pad.z);
    scene.add(lamp);
    const sign = new THREE.Sprite(
      track(new THREE.SpriteMaterial({ map: track(textTexture(pad.name.toUpperCase(), "#f4efe6")), transparent: true, depthWrite: false, fog: false })),
    );
    sign.position.set(pad.x, 6.2, pad.z);
    sign.scale.set(7.5, 3.2, 1);
    scene.add(sign);
  }

  const gatePost = new THREE.Mesh(track(new THREE.CylinderGeometry(0.12, 0.12, 3.2, 6)), beaconMat);
  gatePost.position.set(GATE.x, 1.6, GATE.z);
  scene.add(gatePost);

  buildSluice(scene, track, box, steel, std);
  const crusherAnimators: ((time: number) => void)[] = [];
  buildCrusherDressing(scene, track, box, steel, orange, crusherAnimators);
  buildRidges(scene, track, std);
  buildTrees(scene, track, std);
  buildFence(scene, track, std);

  const dustCount = 70;
  const dustPos = new Float32Array(dustCount * 3);
  const dustLife = new Float32Array(dustCount);
  const dustGeo = track(new THREE.BufferGeometry());
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(
    dustGeo,
    track(new THREE.PointsMaterial({ color: 0xcbb8a0, size: 0.35, transparent: true, opacity: 0.45, depthWrite: false })),
  );
  scene.add(dust);

  let camIdx = 1;
  let orbitAng = 0.4;
  let shake = 0;
  let snapNext = false;
  let bound: GameState | null = null;
  const clock = { t: 0 };

  function ensure(state: GameState) {
    const live = new Set(state.vehicles.map((v) => v.uid));
    for (const [uid, rig] of rigs) {
      if (!live.has(uid)) {
        scene.remove(rig.root);
        rigs.delete(uid);
      }
    }
    for (const v of state.vehicles) {
      if (!rigs.has(v.uid)) rigs.set(v.uid, buildRig(v.defId, v.uid));
    }
    const dlive = new Set(state.deposits.map((d) => d.id));
    for (const [id, view] of depositViews) {
      if (!dlive.has(id)) {
        scene.remove(view.group);
        scene.remove(view.sign);
        depositViews.delete(id);
      }
    }
    for (const d of state.deposits) {
      if (!depositViews.has(d.id)) depositViews.set(d.id, makeDeposit(d));
    }
    if (state.company !== lastCompany) {
      lastCompany = state.company;
      if (companySign) scene.remove(companySign);
      companyTex?.dispose();
      companyTex = track(textTexture(state.company.toUpperCase(), "#f4efe6"));
      companySign = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: companyTex, transparent: true, depthWrite: false, fog: false })));
      companySign.position.set(22, 6.4, 54);
      companySign.scale.set(8, 3.2, 1);
      scene.add(companySign);
    }
  }

  function frameCamera(state: GameState, dt: number, follow: boolean) {
    if (!follow) {
      orbitAng += dt * 0.08;
      const r = 68;
      _desired.set(PIT.x + Math.sin(orbitAng) * r, 32, PIT.z + Math.cos(orbitAng) * 52);
      camera.position.lerp(_desired, 1 - Math.exp(-1.5 * dt));
      camera.lookAt(PIT.x, 1, PIT.z);
      return;
    }
    const v = state.vehicles[state.active];
    if (!v) return;
    const dist = CAMS[camIdx];
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    _desired.set(v.x - fx * dist, 2.2 + dist * 0.42, v.z - fz * dist);
    if (snapNext) {
      camera.position.copy(_desired);
      snapNext = false;
    } else {
      camera.position.lerp(_desired, 1 - Math.exp(-3.4 * dt));
    }
    _look.set(v.x + fx * 5, 1.6, v.z + fz * 5);
    camera.lookAt(_look);
    if (shake > 0) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake * 0.6;
      shake = Math.max(0, shake - dt * 1.4);
    }
  }

  function sync(state: GameState, dt: number, follow: boolean) {
    clock.t += dt;
    for (const animate of crusherAnimators) animate(clock.t);
    if (bound !== state) bound = state;
    ensure(state);
    for (const v of state.vehicles) {
      const rig = rigs.get(v.uid);
      if (!rig) continue;
      rig.root.position.set(v.x, 0, v.z);
      rig.root.rotation.y = v.yaw;
      rig.spin += v.speed * dt * 1.7;
      for (const w of rig.wheels) w.rotation.x = rig.spin;
      const k = 1 - Math.exp(-8 * dt);
      if (rig.bucket) {
        const target = v.busy ? 0.7 : 0.05;
        rig.bucket.rotation.x += (target - rig.bucket.rotation.x) * k;
      }
      if (rig.boom) {
        const target = -0.35 + (v.busy ? Math.sin(clock.t * 3.2) * 0.45 : 0);
        rig.boom.rotation.x += (target - rig.boom.rotation.x) * k;
      }
      if (rig.house) {
        const target = v.busy ? Math.sin(clock.t * 1.5) * 0.45 : 0;
        rig.house.rotation.y += (target - rig.house.rotation.y) * k;
      }
      if (rig.blade) {
        const target = v.busy ? -0.15 : 0.2;
        rig.blade.position.y += (0.45 + target - rig.blade.position.y) * k;
      }
      if (rig.bed) {
        const target = v.busy && DEFS[v.defId].receives ? 0.62 : 0;
        rig.dump += (target - rig.dump) * k;
        rig.bed.rotation.x = rig.dump;
      }
      if (rig.load) {
        const cap = vehicleStats(v).capacity;
        const f = cap > 0 ? v.cargo / cap : 0;
        rig.load.visible = f > 0.04;
        rig.load.scale.y = Math.max(0.08, f);
        const material = oreMaterials[v.cargoOre ?? "iron"];
        rig.load.traverse((part) => {
          if (part instanceof THREE.Mesh) part.material = material;
        });
      }
    }
    for (const d of state.deposits) {
      const view = depositViews.get(d.id);
      if (!view) continue;
      const owned = state.claims.includes(d.claim);
      view.group.position.set(d.x, 0, d.z);
      const fullness = d.max > 0 ? Math.max(0, Math.min(1, d.tons / d.max)) : 0;
      // Keep each fragment realistically sized; depletion reduces the pile's
      // footprint instead of scaling individual stones up into giant boulders.
      const s = (d.kind === "vein" ? 0.72 : 0.58) + fullness * (d.kind === "vein" ? 0.42 : 0.38);
      view.group.scale.setScalar(s);
      view.group.visible = d.tons > 0.15 || d.regen > 0;
      for (const child of view.group.children) {
        const mesh = child as THREE.Mesh;
        mesh.material = owned ? oreMaterials[d.ore] : lockedMat;
      }
      if (view.lease !== !owned) {
        view.lease = !owned;
        (view.sign.material as THREE.SpriteMaterial).map = owned ? view.ownedTex : view.leaseTex;
      }
      view.sign.position.set(d.x, 4.6 + Math.min(2, s), d.z);
    }
    const player = state.vehicles[state.active];
    if (player && Math.abs(player.speed) > 2.5) {
      const fx = -Math.sin(player.yaw);
      const fz = -Math.cos(player.yaw);
      for (let i = 0; i < 3; i++) {
        const idx = (Math.floor(clock.t * 30) + i) % dustCount;
        if (dustLife[idx] > 0) continue;
        dustPos[idx * 3] = player.x - fx * 1.8 + (Math.random() - 0.5);
        dustPos[idx * 3 + 1] = 0.3;
        dustPos[idx * 3 + 2] = player.z - fz * 1.8 + (Math.random() - 0.5);
        dustLife[idx] = 0.6;
      }
    }

    // Give active digging and scooping visible ground-contact feedback without
    // changing the mining simulation or adding work to the save data.
    state.vehicles.forEach((v, vehicleIndex) => {
      const def = DEFS[v.defId];
      if (!v.busy || (def.dig <= 0 && def.scoop <= 0)) return;
      const fx = -Math.sin(v.yaw);
      const fz = -Math.cos(v.yaw);
      for (let i = 0; i < 3; i++) {
        const idx = (Math.floor(clock.t * 48) + vehicleIndex * 11 + i * 7) % dustCount;
        if (dustLife[idx] > 0) continue;
        dustPos[idx * 3] = v.x + fx * 2.1 + (Math.random() - 0.5) * 1.8;
        dustPos[idx * 3 + 1] = 0.22 + Math.random() * 0.18;
        dustPos[idx * 3 + 2] = v.z + fz * 2.1 + (Math.random() - 0.5) * 1.8;
        dustLife[idx] = 0.42 + Math.random() * 0.2;
      }
    });
    for (let i = 0; i < dustCount; i++) {
      if (dustLife[i] <= 0) {
        dustPos[i * 3 + 1] = -10;
        continue;
      }
      dustLife[i] -= dt;
      dustPos[i * 3 + 1] += dt * 0.8;
    }
    (dustGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    frameCamera(state, dt, follow);
    renderer.render(scene, camera);
  }

  function resize() {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, w > 1400 ? 1.25 : 1.5);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  resize();

  return {
    sync,
    orbit(dt: number) {
      if (bound) sync(bound, dt, false);
    },
    kick(n) {
      shake = Math.min(0.6, shake + n);
    },
    snap() {
      snapNext = true;
    },
    cycleCam() {
      camIdx = (camIdx + 1) % CAMS.length;
    },
    project(x, y, z, w, h) {
      _proj.set(x, y, z).project(camera);
      if (_proj.z > 1) return null;
      return { x: (_proj.x * 0.5 + 0.5) * w, y: (-_proj.y * 0.5 + 0.5) * h };
    },
    resize,
    dispose() {
      renderer.dispose();
      disposables.forEach((d) => d.dispose());
      canvas.remove();
    },
  };
}

function addRoad(
  scene: THREE.Scene,
  track: <T extends { dispose: () => void }>(g: T) => T,
  mat: THREE.Material,
  w: number,
  h: number,
  x: number,
  z: number,
) {
  const geo = track(new THREE.PlaneGeometry(w, h));
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.04, z);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function textTexture(text: string, accent: string) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 220;
  const g = c.getContext("2d");
  if (!g) {
    const tex = new THREE.CanvasTexture(c);
    return tex;
  }
  g.fillStyle = "rgba(20,18,16,0.88)";
  g.fillRect(0, 0, 512, 220);
  g.strokeStyle = accent;
  g.lineWidth = 10;
  g.strokeRect(8, 8, 496, 204);
  g.fillStyle = "#f4efe6";
  g.font = "700 64px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const label = text.length > 18 ? text.slice(0, 18) : text;
  g.fillText(label, 256, 110);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGroundTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#6a5d4c";
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1800; i++) {
      g.fillStyle = i % 2 ? "#5b4f40" : "#7a6c58";
      g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(28, 28);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildSluice(
  scene: THREE.Scene,
  track: <T extends { dispose: () => void }>(g: T) => T,
  box: (parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, shadow?: boolean) => THREE.Mesh,
  steel: THREE.Material,
  std: (color: number, opts?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.MeshStandardMaterial,
) {
  const root = new THREE.Group();
  root.position.set(-80, 0, 36);
  box(root, 2.2, 1.6, 2.2, 0, 1.3, -3.2, steel);
  box(root, 1.4, 0.35, 8, 0, 1.15, 1, std(0x6e5a3a, { roughness: 0.7, metalness: 0.2 }));
  const water = new THREE.Mesh(track(new THREE.BoxGeometry(1.1, 0.12, 7.2)), std(0x3f7c84, { transparent: true, opacity: 0.75, roughness: 0.2, metalness: 0.1 }));
  water.position.set(0, 1.28, 1);
  root.add(water);
  scene.add(root);
}

function buildCrusherDressing(
  scene: THREE.Scene,
  track: <T extends { dispose: () => void }>(g: T) => T,
  box: (parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, shadow?: boolean) => THREE.Mesh,
  steel: THREE.Material,
  orange: THREE.Material,
  animators: ((time: number) => void)[],
) {
  // Compact tracked mobile jaw crusher: undercarriage, engine bay, feed hopper,
  // crushing chamber, safety rails and a raised discharge conveyor.
  const root = new THREE.Group();
  root.position.set(42, 0, 28);
  const rubber = track(new THREE.MeshStandardMaterial({ color: 0x252523, roughness: 0.98 }));
  const darkSteel = track(new THREE.MeshStandardMaterial({ color: 0x383b3b, roughness: 0.78, metalness: 0.25 }));
  const yellow = orange;
  const belt = track(new THREE.MeshStandardMaterial({ color: 0x252729, roughness: 0.92 }));
  const glass = track(new THREE.MeshStandardMaterial({ color: 0x526b70, roughness: 0.32, metalness: 0.15 }));
  const addCyl = (radiusTop: number, radiusBottom: number, height: number, x: number, y: number, z: number, mat: THREE.Material, segments = 10) => {
    const mesh = new THREE.Mesh(track(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments)), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };

  // Twin crawler tracks with visible rollers.
  for (const x of [-1.55, 1.55]) {
    box(root, 0.62, 0.62, 5.2, x, 0.48, 0.25, rubber);
    box(root, 0.67, 0.12, 4.35, x, 0.78, 0.25, darkSteel);
    for (let i = 0; i < 5; i++) {
      const roller = addCyl(0.22, 0.22, 0.16, x, 0.43, -1.55 + i * 0.9, steel, 10);
      roller.rotation.z = Math.PI / 2;
    }
  }
  box(root, 3.5, 0.38, 4.7, 0, 1.02, 0.2, darkSteel);
  box(root, 2.25, 0.82, 1.8, 0.2, 1.62, 1.12, yellow);
  box(root, 1.85, 0.48, 1.45, 0.2, 2.18, 1.12, darkSteel);
  box(root, 1.42, 0.34, 0.08, 0.2, 2.18, 0.36, glass, false);
  // Engine cover and service details.
  box(root, 1.55, 1.1, 1.45, -1.02, 1.8, 1.25, yellow);
  box(root, 1.18, 0.12, 1.1, -1.02, 2.38, 1.25, darkSteel);
  for (let i = 0; i < 4; i++) box(root, 0.06, 0.5, 0.72, -1.64 + i * 0.22, 1.78, 1.25, darkSteel, false);
  // Feed hopper: broad rim, sloped sides and deep dark throat.
  box(root, 2.45, 0.18, 2.1, 0.2, 2.88, -1.25, steel);
  box(root, 2.05, 0.16, 1.72, 0.2, 2.7, -1.25, darkSteel);
  const hopperSideA = box(root, 0.16, 0.78, 1.9, -0.93, 2.48, -1.25, yellow);
  hopperSideA.rotation.z = -0.22;
  const hopperSideB = box(root, 0.16, 0.78, 1.9, 1.33, 2.48, -1.25, yellow);
  hopperSideB.rotation.z = 0.22;
  box(root, 2.2, 0.68, 0.16, 0.2, 2.43, -2.18, yellow);
  // Jaw chamber and guarded side panels.
  box(root, 2.05, 1.7, 1.45, 0.2, 1.95, -0.12, yellow);
  box(root, 1.42, 1.25, 0.12, 0.2, 1.92, -0.9, darkSteel);
  box(root, 0.16, 1.0, 0.18, -0.45, 1.9, -0.98, steel);
  box(root, 0.16, 1.0, 0.18, 0.85, 1.9, -0.98, steel);
  // Exposed drive flywheel makes the crusher read as working plant, not a static prop.
  const flywheel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.56, 0.56, 0.16, 20)), darkSteel);
  flywheel.rotation.z = Math.PI / 2;
  flywheel.position.set(1.36, 1.95, -0.1);
  flywheel.castShadow = true;
  root.add(flywheel);
  const flywheelHub = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, 0.2, 12)), steel);
  flywheelHub.rotation.z = Math.PI / 2;
  flywheelHub.position.copy(flywheel.position);
  root.add(flywheelHub);
  // Amber beacon pulses slowly while the flywheel turns.
  const beaconMat = new THREE.MeshStandardMaterial({ color: 0xffa21a, emissive: 0xff7a00, emissiveIntensity: 0.4, roughness: 0.35 });
  track(beaconMat);
  const beacon = new THREE.Mesh(track(new THREE.CylinderGeometry(0.15, 0.18, 0.22, 10)), beaconMat);
  beacon.position.set(-1.02, 2.52, 1.25);
  root.add(beacon);
  animators.push((time) => {
    flywheel.rotation.x = time * 5.5;
    flywheelHub.rotation.x = flywheel.rotation.x;
    beaconMat.emissiveIntensity = 0.25 + (Math.sin(time * 3.2) + 1) * 0.48;
  });
  // Angled discharge conveyor with belt and side guards.
  const conveyor = new THREE.Group();
  conveyor.position.set(0.25, 1.35, -0.7);
  conveyor.rotation.x = -0.34;
  box(conveyor, 1.35, 0.18, 5.6, 0, 0.7, -2.25, darkSteel);
  box(conveyor, 1.04, 0.06, 5.25, 0, 0.82, -2.25, belt, false);
  box(conveyor, 0.1, 0.28, 5.3, -0.62, 0.84, -2.25, yellow);
  box(conveyor, 0.1, 0.28, 5.3, 0.62, 0.84, -2.25, yellow);
  // Raised belt cleats travel down the conveyor so the discharge looks active.
  const beltCleats: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const cleat = box(conveyor, 0.92, 0.045, 0.07, 0, 0.87, -4.65 + i * 0.68, steel, false);
    beltCleats.push(cleat);
  }
  animators.push((time) => {
    for (let i = 0; i < beltCleats.length; i++) {
      beltCleats[i].position.z = -4.65 + ((i * 0.68 + time * 0.85) % 5.1);
    }
  });
  root.add(conveyor);
  // Hydraulic support, access ladder and operator/service platform.
  const supportA = box(root, 0.13, 1.4, 0.13, -0.5, 1.1, -2.5, steel);
  supportA.rotation.x = -0.28;
  const supportB = box(root, 0.13, 1.4, 0.13, 0.75, 1.1, -2.5, steel);
  supportB.rotation.x = -0.28;
  box(root, 1.7, 0.1, 0.75, 0.2, 2.15, 0.95, steel);
  box(root, 0.08, 0.55, 0.08, -0.6, 2.45, 0.95, steel);
  box(root, 0.08, 0.55, 0.08, 1.0, 2.45, 0.95, steel);
  box(root, 1.55, 0.08, 0.08, 0.2, 2.7, 0.95, steel, false);
  // A short feed chute and discharge pile anchor the machine to the site.
  const feed = box(root, 1.5, 0.16, 1.25, 0.2, 1.25, -1.5, steel);
  feed.rotation.x = -0.18;
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  scene.add(root);
}

function buildRidges(scene: THREE.Scene, track: <T extends { dispose: () => void }>(g: T) => T, std: (color: number, opts?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.MeshStandardMaterial) {
  const mat = std(0x5a4638, { roughness: 1 });
  const spots: [number, number, number][] = [
    [-70, -8, 18],
    [8, -4, 22],
    [78, -2, 16],
    [-110, 8, 14],
    [120, 12, 20],
  ];
  for (const [x, z, h] of spots) {
    const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(30, h, 16)), mat);
    mesh.position.set(x, h / 2 - 4, z);
    scene.add(mesh);
  }
}

function buildTrees(scene: THREE.Scene, track: <T extends { dispose: () => void }>(g: T) => T, std: (color: number, opts?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.MeshStandardMaterial) {
  const trunk = std(0x5a4634, { roughness: 0.9 });
  const leaf = std(0x3d4a3a, { roughness: 0.9 });
  const spots: [number, number][] = [
    [-30, 64],
    [8, 66],
    [48, 64],
    [78, -58],
    [-78, -62],
    [36, -66],
  ];
  for (const [x, z] of spots) {
    const t = new THREE.Mesh(track(new THREE.CylinderGeometry(0.22, 0.38, 2.2, 5)), trunk);
    t.position.set(x, 1.1, z);
    const c = new THREE.Mesh(track(new THREE.ConeGeometry(1.5, 3.4, 6)), leaf);
    c.position.set(x, 3.3, z);
    scene.add(t, c);
  }
}

function buildFence(scene: THREE.Scene, track: <T extends { dispose: () => void }>(g: T) => T, std: (color: number, opts?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.MeshStandardMaterial) {
  const geo = track(new THREE.BoxGeometry(0.18, 1.3, 0.18));
  const mat = std(0x6a5b48, { roughness: 0.9 });
  const posts: THREE.Matrix4[] = [];
  const step = 10;
  const m = new THREE.Matrix4();
  for (let x = BOUNDS.minX; x <= BOUNDS.maxX; x += step) {
    posts.push(m.clone().setPosition(x, 0.65, BOUNDS.minZ));
    posts.push(m.clone().setPosition(x, 0.65, BOUNDS.maxZ));
  }
  for (let z = BOUNDS.minZ + step; z < BOUNDS.maxZ; z += step) {
    posts.push(m.clone().setPosition(BOUNDS.minX, 0.65, z));
    posts.push(m.clone().setPosition(BOUNDS.maxX, 0.65, z));
  }
  const mesh = new THREE.InstancedMesh(geo, mat, posts.length);
  posts.forEach((p, i) => mesh.setMatrixAt(i, p));
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
}
