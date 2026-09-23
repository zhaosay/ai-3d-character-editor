import * as THREE from 'three';
import type { CharacterMeta } from '../../types/global';

/**
 * 程序化示例角色「武侠木偶」男女两版（REAL，无外部文件）。
 * 标准骨骼命名（humanoidMap 全映射）+ 单 Skeleton 多 SkinnedMesh 刚性蒙皮，
 * GLB 导出后拖回仍能识别骨骼（含动画绑定）。
 * 骨骼 Y 布局男女一致（同高约 1.74m），体型靠肩宽/腰臀/四肢粗细/发型区分。
 */

export type DemoGender = 'male' | 'female';

interface GenderParams {
  shoulderX: number;
  pelvisW: number;
  waistW: number;
  chestW: number;
  armR: number;
  forearmR: number;
  thighR: number;
  shinR: number;
  body: THREE.Material;
  accent: THREE.Material;
}

const MALE_BODY = new THREE.MeshStandardMaterial({ color: 0x3d4b5c, roughness: 0.7, metalness: 0.1 });
const MALE_ACCENT = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.5, metalness: 0.3 });
const FEMALE_BODY = new THREE.MeshStandardMaterial({ color: 0x4a3f5c, roughness: 0.7, metalness: 0.1 });
const FEMALE_ACCENT = new THREE.MeshStandardMaterial({ color: 0xc9728a, roughness: 0.5, metalness: 0.3 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x232b36, roughness: 0.8 });

const GENDERS: Record<DemoGender, GenderParams> = {
  male: {
    shoulderX: 0.26, pelvisW: 0.3, waistW: 0.3, chestW: 0.38,
    armR: 0.06, forearmR: 0.055, thighR: 0.08, shinR: 0.065,
    body: MALE_BODY, accent: MALE_ACCENT,
  },
  female: {
    shoulderX: 0.21, pelvisW: 0.34, waistW: 0.26, chestW: 0.34,
    armR: 0.05, forearmR: 0.045, thighR: 0.07, shinR: 0.055,
    body: FEMALE_BODY, accent: FEMALE_ACCENT,
  },
};

interface BoneSpec {
  name: string;
  parent: string | null;
  pos: [number, number, number];
}

function boneSpecs(P: GenderParams): BoneSpec[] {
  return [
    { name: 'Hips', parent: null, pos: [0, 0.95, 0] },
    { name: 'Spine', parent: 'Hips', pos: [0, 0.12, 0] },
    { name: 'Chest', parent: 'Spine', pos: [0, 0.18, 0] },
    { name: 'Neck', parent: 'Chest', pos: [0, 0.18, 0] },
    { name: 'Head', parent: 'Neck', pos: [0, 0.12, 0] },
    { name: 'UpperArm_L', parent: 'Chest', pos: [P.shoulderX, 0.12, 0] },
    { name: 'Forearm_L', parent: 'UpperArm_L', pos: [0, -0.28, 0] },
    { name: 'Hand_L', parent: 'Forearm_L', pos: [0, -0.26, 0] },
    { name: 'UpperArm_R', parent: 'Chest', pos: [-P.shoulderX, 0.12, 0] },
    { name: 'Forearm_R', parent: 'UpperArm_R', pos: [0, -0.28, 0] },
    { name: 'Hand_R', parent: 'Forearm_R', pos: [0, -0.26, 0] },
    { name: 'Thigh_L', parent: 'Hips', pos: [0.1, -0.06, 0] },
    { name: 'Shin_L', parent: 'Thigh_L', pos: [0, -0.44, 0] },
    { name: 'Foot_L', parent: 'Shin_L', pos: [0, -0.42, 0.03] },
    { name: 'Thigh_R', parent: 'Hips', pos: [-0.1, -0.06, 0] },
    { name: 'Shin_R', parent: 'Thigh_R', pos: [0, -0.44, 0] },
    { name: 'Foot_R', parent: 'Shin_R', pos: [0, -0.42, 0.03] },
  ];
}

interface PartSpec {
  geo: THREE.BufferGeometry;
  bone: string;
  mat: THREE.Material;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function capsule(r: number, len: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(r, len, 6, 12);
  g.translate(x, y, z);
  return g;
}

function sphere(r: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 24, 18);
  g.translate(x, y, z);
  return g;
}

function armParts(P: GenderParams, side: 1 | -1): PartSpec[] {
  const sx = P.shoulderX * side;
  const up = side > 0 ? 'UpperArm_L' : 'UpperArm_R';
  const fo = side > 0 ? 'Forearm_L' : 'Forearm_R';
  const hand = side > 0 ? 'Hand_L' : 'Hand_R';
  return [
    { geo: capsule(P.armR, 0.2, sx, 1.23, 0), bone: up, mat: P.body },
    { geo: capsule(P.forearmR, 0.18, sx, 0.96, 0), bone: fo, mat: P.body },
    { geo: box(0.09, 0.16, 0.09, sx, 0.77, 0), bone: hand, mat: DARK },
  ];
}

function legParts(P: GenderParams, side: 1 | -1): PartSpec[] {
  const sx = 0.1 * side;
  const th = side > 0 ? 'Thigh_L' : 'Thigh_R';
  const sh = side > 0 ? 'Shin_L' : 'Shin_R';
  const foot = side > 0 ? 'Foot_L' : 'Foot_R';
  return [
    { geo: capsule(P.thighR, 0.32, sx, 0.67, 0), bone: th, mat: DARK },
    { geo: capsule(P.shinR, 0.3, sx, 0.24, 0), bone: sh, mat: P.body },
    { geo: box(0.11, 0.07, 0.26, sx, 0.035, 0.1), bone: foot, mat: DARK },
  ];
}

/** 躯干 + 性别特征：男束发平顶 / 女长发+发髻+胸型 */
function torsoParts(P: GenderParams, gender: DemoGender): PartSpec[] {
  const parts: PartSpec[] = [
    { geo: box(P.pelvisW, 0.18, 0.2, 0, 0.95, 0), bone: 'Hips', mat: P.body },
    { geo: box(P.pelvisW + 0.02, 0.06, 0.22, 0, 1.02, 0), bone: 'Hips', mat: P.accent }, // 腰带
    { geo: box(P.waistW, 0.22, 0.2, 0, 1.13, 0), bone: 'Spine', mat: P.body },
    { geo: box(P.chestW, 0.26, 0.24, 0, 1.3, 0), bone: 'Chest', mat: P.body },
    { geo: box(0.1, 0.1, 0.1, 0, 1.46, 0), bone: 'Neck', mat: P.body },
    { geo: sphere(0.12, 0, 1.62, 0), bone: 'Head', mat: P.body },
    { geo: box(0.2, 0.07, 0.2, 0, 1.71, 0), bone: 'Head', mat: P.accent }, // 抹额
  ];
  if (gender === 'female') {
    parts.push(
      { geo: box(0.28, 0.13, 0.1, 0, 1.32, 0.13), bone: 'Chest', mat: P.body }, // 胸型
      { geo: box(0.18, 0.38, 0.08, 0, 1.48, -0.12), bone: 'Head', mat: DARK }, // 长发
      { geo: sphere(0.06, 0, 1.7, -0.1), bone: 'Head', mat: DARK }, // 发髻
    );
  } else {
    parts.push(
      { geo: box(0.2, 0.06, 0.22, 0, 1.72, 0), bone: 'Head', mat: DARK }, // 束发平顶
    );
  }
  return parts;
}

export interface DemoCharacter {
  scene: THREE.Group;
  meta: CharacterMeta;
  dispose: () => void;
}

export function buildDemoCharacter(gender: DemoGender = 'male'): DemoCharacter {
  const P = GENDERS[gender];
  const specs = boneSpecs(P);
  const PARTS: PartSpec[] = [
    ...torsoParts(P, gender),
    ...armParts(P, 1),
    ...armParts(P, -1),
    ...legParts(P, 1),
    ...legParts(P, -1),
  ];
  const scene = new THREE.Group();
  scene.name = gender === 'female' ? 'DemoWuxiaFemale' : 'DemoWuxiaMale';

  const bones = new Map<string, THREE.Bone>();
  for (const spec of specs) {
    const b = new THREE.Bone();
    b.name = spec.name;
    b.position.fromArray(spec.pos);
    bones.set(spec.name, b);
    if (spec.parent) bones.get(spec.parent)!.add(b);
    else scene.add(b);
  }
  scene.updateMatrixWorld(true);
  const ordered = specs.map((s) => bones.get(s.name)!);
  const indexOf = new Map(ordered.map((b, i) => [b.name, i]));
  const skeleton = new THREE.Skeleton(ordered);

  const geometries: THREE.BufferGeometry[] = [];
  for (const part of PARTS) {
    const geo = part.geo;
    geometries.push(geo);
    const count = geo.attributes['position'].count;
    const si = new Uint16Array(count * 4);
    const sw = new Float32Array(count * 4);
    const bi = indexOf.get(part.bone)!;
    for (let i = 0; i < count; i++) {
      si[i * 4] = bi;
      sw[i * 4] = 1;
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const mesh = new THREE.SkinnedMesh(geo, part.mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.bind(skeleton);
    mesh.normalizeSkinWeights();
    scene.add(mesh);
  }
  scene.updateMatrixWorld(true);

  const meta: CharacterMeta = {
    id: `demo-${gender}-${Date.now()}`,
    fileName: gender === 'female' ? 'demo-wuxia-female.glb' : 'demo-wuxia-male.glb',
    fileSize: 0,
    gltfInfo: { meshes: PARTS.length, materials: 3, bones: specs.length, hasSkin: true, hasAnimations: 0 },
  };

  const dispose = () => {
    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) mesh.geometry.dispose();
    });
  };

  return { scene, meta, dispose };
}
