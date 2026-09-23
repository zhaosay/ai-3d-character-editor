import * as THREE from 'three';
import type { CharacterMeta } from '../../types/global';
import { buildRigged, disposeRigged, type RigPartSpec } from '../../core/rig/skinnedRig';

/**
 * 程序化示例角色「武侠人物」男女两版（REAL，无外部文件）。
 * 修长四肢 + 圆柱躯干 + 关节球 + 鼻子/发型，标准骨骼命名（humanoidMap 全映射），
 * 单 Skeleton 多 SkinnedMesh 刚性蒙皮，GLB 导出后拖回仍能识别骨骼（含动画绑定）。
 * 骨骼 Y 布局男女一致（约 1.83m），体型靠肩宽/腰臀/四肢粗细/发型区分。
 */

export type DemoGender = 'male' | 'female';

interface GenderParams {
  shoulderX: number;
  pelvisTop: number;
  pelvisBottom: number;
  waistTop: number;
  waistBottom: number;
  chestTop: number;
  chestBottom: number;
  armR: number;
  forearmR: number;
  thighR: number;
  shinR: number;
  deltR: number;
  elbowR: number;
  kneeR: number;
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
    shoulderX: 0.24, pelvisTop: 0.15, pelvisBottom: 0.14,
    waistTop: 0.13, waistBottom: 0.15, chestTop: 0.175, chestBottom: 0.125,
    armR: 0.055, forearmR: 0.05, thighR: 0.07, shinR: 0.06,
    deltR: 0.068, elbowR: 0.048, kneeR: 0.058,
    body: MALE_BODY, accent: MALE_ACCENT,
  },
  female: {
    shoulderX: 0.19, pelvisTop: 0.17, pelvisBottom: 0.155,
    waistTop: 0.11, waistBottom: 0.13, chestTop: 0.155, chestBottom: 0.115,
    armR: 0.048, forearmR: 0.043, thighR: 0.062, shinR: 0.052,
    deltR: 0.058, elbowR: 0.042, kneeR: 0.052,
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
    { name: 'Hips', parent: null, pos: [0, 1.02, 0] },
    { name: 'Spine', parent: 'Hips', pos: [0, 0.13, 0] },
    { name: 'Chest', parent: 'Spine', pos: [0, 0.19, 0] },
    { name: 'Neck', parent: 'Chest', pos: [0, 0.17, 0] },
    { name: 'Head', parent: 'Neck', pos: [0, 0.13, 0] },
    { name: 'UpperArm_L', parent: 'Chest', pos: [P.shoulderX, 0.16, 0] },
    { name: 'Forearm_L', parent: 'UpperArm_L', pos: [0, -0.3, 0] },
    { name: 'Hand_L', parent: 'Forearm_L', pos: [0, -0.28, 0] },
    { name: 'UpperArm_R', parent: 'Chest', pos: [-P.shoulderX, 0.16, 0] },
    { name: 'Forearm_R', parent: 'UpperArm_R', pos: [0, -0.3, 0] },
    { name: 'Hand_R', parent: 'Forearm_R', pos: [0, -0.28, 0] },
    { name: 'Thigh_L', parent: 'Hips', pos: [0.09, -0.06, 0] },
    { name: 'Shin_L', parent: 'Thigh_L', pos: [0, -0.48, 0] },
    { name: 'Foot_L', parent: 'Shin_L', pos: [0, -0.46, 0.02] },
    { name: 'Thigh_R', parent: 'Hips', pos: [-0.09, -0.06, 0] },
    { name: 'Shin_R', parent: 'Thigh_R', pos: [0, -0.48, 0] },
    { name: 'Foot_R', parent: 'Shin_R', pos: [0, -0.46, 0.02] },
  ];
}

type PartSpec = RigPartSpec;

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

function sphere(r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 24, 18);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

function cylinder(rTop: number, rBottom: number, h: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, 20);
  g.translate(x, y, z);
  return g;
}

function armParts(P: GenderParams, side: 1 | -1): PartSpec[] {
  const sx = P.shoulderX * side;
  const up = side > 0 ? 'UpperArm_L' : 'UpperArm_R';
  const fo = side > 0 ? 'Forearm_L' : 'Forearm_R';
  const hand = side > 0 ? 'Hand_L' : 'Hand_R';
  return [
    { geo: sphere(P.deltR, sx, 1.5, 0), bone: up, mat: P.body, theme: 'skin' }, // 三角肌
    { geo: capsule(P.armR, 0.22, sx, 1.35, 0), bone: up, mat: P.body, theme: 'skin' },
    { geo: sphere(P.elbowR, sx, 1.2, 0), bone: fo, mat: P.body, theme: 'skin' }, // 肘
    { geo: capsule(P.forearmR, 0.2, sx, 1.06, 0), bone: fo, mat: P.body, theme: 'skin' },
    { geo: box(0.07, 0.15, 0.075, sx, 0.845, 0), bone: hand, mat: DARK, theme: 'cloth' },
  ];
}

function legParts(P: GenderParams, side: 1 | -1): PartSpec[] {
  const sx = 0.09 * side;
  const th = side > 0 ? 'Thigh_L' : 'Thigh_R';
  const sh = side > 0 ? 'Shin_L' : 'Shin_R';
  const foot = side > 0 ? 'Foot_L' : 'Foot_R';
  return [
    { geo: capsule(P.thighR, 0.32, sx, 0.67, 0), bone: th, mat: DARK, theme: 'cloth' },
    { geo: capsule(P.shinR, 0.3, sx, 0.24, 0), bone: sh, mat: P.body, theme: 'skin' },
    { geo: box(0.11, 0.07, 0.26, sx, 0.035, 0.1), bone: foot, mat: DARK, theme: 'cloth' },
  ];
}

/** 躯干 + 性别特征：男束发 / 女长发+发髻+胸型 */
function torsoParts(P: GenderParams, gender: DemoGender): PartSpec[] {
  const parts: PartSpec[] = [
    { geo: cylinder(P.pelvisTop, P.pelvisBottom, 0.18, 0, 1.02, 0), bone: 'Hips', mat: P.body, theme: 'skin' },
    { geo: box(P.pelvisTop * 2 + 0.02, 0.05, 0.22, 0, 1.09, 0), bone: 'Hips', mat: P.accent, theme: 'cloth' }, // 腰带
    { geo: cylinder(P.waistTop, P.waistBottom, 0.24, 0, 1.21, 0), bone: 'Spine', mat: P.body, theme: 'skin' },
    { geo: cylinder(P.chestTop, P.chestBottom, 0.28, 0, 1.37, 0), bone: 'Chest', mat: P.body, theme: 'skin' },
    { geo: cylinder(0.05, 0.058, 0.16, 0, 1.535, 0), bone: 'Neck', mat: P.body, theme: 'skin' },
    { geo: sphere(0.108, 0, 1.72, 0.01, 0.92, 1.08, 0.95), bone: 'Head', mat: P.body, theme: 'skin' },
    { geo: box(0.03, 0.05, 0.035, 0, 1.705, 0.11), bone: 'Head', mat: P.body, theme: 'skin' }, // 鼻
    { geo: sphere(0.016, 0.042, 1.735, 0.1), bone: 'Head', mat: DARK, theme: 'cloth' }, // 眼
    { geo: sphere(0.016, -0.042, 1.735, 0.1), bone: 'Head', mat: DARK, theme: 'cloth' },
    { geo: box(0.21, 0.055, 0.21, 0, 1.77, 0.005), bone: 'Head', mat: P.accent, theme: 'cloth' }, // 抹额
  ];
  if (gender === 'female') {
    parts.push(
      { geo: sphere(0.068, 0.075, 1.4, 0.105), bone: 'Chest', mat: P.body, theme: 'skin' }, // 胸型
      { geo: sphere(0.068, -0.075, 1.4, 0.105), bone: 'Chest', mat: P.body, theme: 'skin' },
      { geo: box(0.17, 0.42, 0.07, 0, 1.54, -0.125), bone: 'Head', mat: DARK, theme: 'cloth' }, // 长发
      { geo: sphere(0.06, 0, 1.82, -0.085), bone: 'Head', mat: DARK, theme: 'cloth' }, // 发髻
    );
  } else {
    parts.push(
      { geo: box(0.19, 0.05, 0.2, 0, 1.835, 0.005), bone: 'Head', mat: DARK, theme: 'cloth' }, // 束发
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
  const scene = buildRigged(
    gender === 'female' ? 'DemoWuxiaFemale' : 'DemoWuxiaMale',
    specs.map((s) => ({ name: s.name, parent: s.parent, pos: s.pos })),
    PARTS,
  ).scene;
  scene.userData['themable'] = true;

  const meta: CharacterMeta = {
    id: `demo-${gender}-${Date.now()}`,
    fileName: gender === 'female' ? 'demo-wuxia-female.glb' : 'demo-wuxia-male.glb',
    fileSize: 0,
    gltfInfo: { meshes: PARTS.length, materials: 3, bones: specs.length, hasSkin: true, hasAnimations: 0 },
  };

  const dispose = () => disposeRigged(scene);

  return { scene, meta, dispose };
}
