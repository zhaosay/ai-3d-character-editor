import * as THREE from 'three';
import type { CharacterMeta } from '../../types/global';
import { buildRigged, disposeRigged, type RigPartSpec } from '../../core/rig/skinnedRig';
import {
  buildFactors, clampAppearance,
  type Appearance, type AppearanceFactors,
} from '../../core/character/appearance';

/** Offline adult previs actors with neutral proportions and everyday clothing. */

export type DemoGender = Appearance['gender'];

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
  accentHex: string;
}

const MALE_ACCENT_HEX = '#607979';
const FEMALE_ACCENT_HEX = '#c7bba8';

/** 皮肤：低金属度 + 轻 sheen 模拟皮脂，避免塑料感（更像真人）。 */
function skinMaterial(hex: string, roughness: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(hex),
    roughness: Math.min(Math.max(roughness, 0.25), 0.85),
    metalness: 0,
    specularIntensity: 0.32,
    sheen: 0.18,
    sheenRoughness: 0.72,
    sheenColor: new THREE.Color(hex).lerp(new THREE.Color(0xffffff), 0.35),
  });
}

const GENDERS: Record<DemoGender, GenderParams> = {
  male: {
    shoulderX: 0.24, pelvisTop: 0.15, pelvisBottom: 0.14,
    waistTop: 0.13, waistBottom: 0.15, chestTop: 0.175, chestBottom: 0.125,
    armR: 0.055, forearmR: 0.05, thighR: 0.07, shinR: 0.06,
    deltR: 0.068, elbowR: 0.048, kneeR: 0.058,
    accentHex: MALE_ACCENT_HEX,
  },
  female: {
    shoulderX: 0.19, pelvisTop: 0.17, pelvisBottom: 0.155,
    waistTop: 0.11, waistBottom: 0.13, chestTop: 0.155, chestBottom: 0.115,
    armR: 0.048, forearmR: 0.043, thighR: 0.062, shinR: 0.052,
    deltR: 0.058, elbowR: 0.042, kneeR: 0.052,
    accentHex: FEMALE_ACCENT_HEX,
  },
};

interface BoneSpec {
  name: string;
  parent: string | null;
  pos: [number, number, number];
}

function boneSpecs(P: GenderParams, F: AppearanceFactors): BoneSpec[] {
  const sx = F.girth;
  const sy = F.heightScale;
  return [
    { name: 'Hips', parent: null, pos: [0, 1.02 * sy, 0] },
    { name: 'Spine', parent: 'Hips', pos: [0, 0.13 * sy, 0] },
    { name: 'Chest', parent: 'Spine', pos: [0, 0.19 * sy, 0] },
    { name: 'Neck', parent: 'Chest', pos: [0, 0.17 * sy, 0] },
    { name: 'Head', parent: 'Neck', pos: [0, 0.13 * sy, 0] },
    { name: 'UpperArm_L', parent: 'Chest', pos: [P.shoulderX * sx, 0.16 * sy, 0] },
    { name: 'Forearm_L', parent: 'UpperArm_L', pos: [0, -0.3 * sy, 0] },
    { name: 'Hand_L', parent: 'Forearm_L', pos: [0, -0.28 * sy, 0] },
    { name: 'UpperArm_R', parent: 'Chest', pos: [-P.shoulderX * sx, 0.16 * sy, 0] },
    { name: 'Forearm_R', parent: 'UpperArm_R', pos: [0, -0.3 * sy, 0] },
    { name: 'Hand_R', parent: 'Forearm_R', pos: [0, -0.28 * sy, 0] },
    { name: 'Thigh_L', parent: 'Hips', pos: [0.09 * sx, -0.06 * sy, 0] },
    { name: 'Shin_L', parent: 'Thigh_L', pos: [0, -0.48 * sy, 0] },
    { name: 'Foot_L', parent: 'Shin_L', pos: [0, -0.46 * sy, 0.02] },
    { name: 'Thigh_R', parent: 'Hips', pos: [-0.09 * sx, -0.06 * sy, 0] },
    { name: 'Shin_R', parent: 'Thigh_R', pos: [0, -0.48 * sy, 0] },
    { name: 'Foot_R', parent: 'Shin_R', pos: [0, -0.46 * sy, 0.02] },
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

function headProfile(gender: DemoGender, F: AppearanceFactors): THREE.BufferGeometry {
  const Fp = F.faceProfile;
  const hs = F.headScale;
  const hg = F.headGirth;
  const jaw = (gender === 'male' ? 0.064 : 0.059) * Fp.jaw * hg;
  const cheek = (gender === 'male' ? 0.081 : 0.076) * Fp.cheek * hg;
  const profile = new THREE.LatheGeometry([
    new THREE.Vector2(0, -0.124 * hs), new THREE.Vector2(0.038 * hg, -0.12 * hs),
    new THREE.Vector2(jaw, -0.096 * hs), new THREE.Vector2(cheek * 0.96, -0.052 * hs),
    new THREE.Vector2(cheek, 0.005 * hs), new THREE.Vector2(cheek * 0.94, 0.053 * hs),
    new THREE.Vector2(cheek * 0.78 * Fp.temple, 0.087 * hs), new THREE.Vector2(0.044 * hg, 0.115 * hs),
    new THREE.Vector2(0, 0.124 * hs),
  ], 32);
  profile.scale(1, 1, 0.84);
  // 下巴：chin 决定下巴前伸/后收
  profile.translate(0, 0, 0.01 * hg + (Fp.chin - 1) * 0.012);
  // 头随身高长高（位置按 hy，尺寸按 hs）
  profile.translate(0, 1.72 * F.heightScale, 0);
  profile.name = 'head-profile';
  return profile;
}

function cylinder(rTop: number, rBottom: number, h: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, 20);
  g.translate(x, y, z);
  return g;
}

interface Mats {
  skin: THREE.Material;
  cloth: THREE.Material;
  dark: THREE.Material;
  shoe: THREE.Material;
  sole: THREE.Material;
  hair: THREE.Material;
  eye: THREE.Material;
  lip: THREE.Material;
  white: THREE.Material;
}

function makeMats(a: Appearance): Mats {
  return {
    skin: skinMaterial(a.skinColor, a.skinRoughness),
    cloth: new THREE.MeshStandardMaterial({ color: new THREE.Color(a.clothColor), roughness: 0.9, metalness: 0 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x232b36, roughness: 0.8 }),
    shoe: new THREE.MeshStandardMaterial({ color: 0x34363a, roughness: 0.78 }),
    sole: new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.88 }),
    hair: new THREE.MeshStandardMaterial({ color: new THREE.Color(a.hairColor), roughness: 0.86 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x30251f, roughness: 0.48 }),
    lip: new THREE.MeshStandardMaterial({ color: 0x996b60, roughness: 0.8 }),
    white: new THREE.MeshStandardMaterial({ color: 0xded9ce, roughness: 0.9 }),
  };
}

function armParts(P: GenderParams, side: 1 | -1, M: Mats, F: AppearanceFactors): PartSpec[] {
  const x = P.shoulderX * F.girth * side;
  const up = side > 0 ? 'UpperArm_L' : 'UpperArm_R';
  const fo = side > 0 ? 'Forearm_L' : 'Forearm_R';
  const hand = side > 0 ? 'Hand_L' : 'Hand_R';
  const g = F.girth;
  return [
    { geo: sphere(P.deltR * 1.13 * g, x, 1.48 * F.heightScale, 0, 1, 1.2, 1), bone: up, mat: M.cloth, theme: 'cloth' },
    { geo: capsule(P.armR * 1.15 * g, 0.18 * F.heightScale, x, 1.37 * F.heightScale, 0), bone: up, mat: M.cloth, theme: 'cloth' },
    { geo: sphere(P.elbowR * g, x, 1.2 * F.heightScale, 0), bone: fo, mat: M.skin, theme: 'skin' },
    { geo: capsule(P.forearmR * 0.86 * g, 0.20 * F.heightScale, x, 1.07 * F.heightScale, 0), bone: fo, mat: M.skin, theme: 'skin' },
    { geo: sphere(0.045 * g, x, 0.872 * F.heightScale, 0.008, 0.72, 1.45, 0.48), bone: hand, mat: M.skin, theme: 'skin' },
    { geo: sphere(0.018 * g, x - side * 0.026 * g, 0.887 * F.heightScale, 0.021, 0.7, 1.65, 0.8), bone: hand, mat: M.skin, theme: 'skin' },
  ];
}

function legParts(P: GenderParams, side: 1 | -1, M: Mats, F: AppearanceFactors): PartSpec[] {
  const x = 0.09 * F.girth * side;
  const th = side > 0 ? 'Thigh_L' : 'Thigh_R';
  const sh = side > 0 ? 'Shin_L' : 'Shin_R';
  const foot = side > 0 ? 'Foot_L' : 'Foot_R';
  const g = F.girth;
  const hy = F.heightScale;
  return [
    { geo: capsule(P.thighR * 1.12 * g, 0.37 * hy, x, 0.735 * hy, 0), bone: th, mat: M.dark },
    { geo: sphere(P.kneeR * 1.05 * g, x, 0.48 * hy, 0), bone: sh, mat: M.dark },
    { geo: capsule(P.shinR * g, 0.31 * hy, x, 0.265 * hy, 0), bone: sh, mat: M.dark },
    { geo: sphere(0.06 * g, x, 0.055, 0.078, 1.08, 0.78, 1.85), bone: foot, mat: M.shoe },
    { geo: box(0.12 * g, 0.018, 0.25, x, 0.012, 0.078), bone: foot, mat: M.sole },
  ];
}

function torsoParts(P: GenderParams, gender: DemoGender, M: Mats, F: AppearanceFactors, A: Appearance): PartSpec[] {
  const g = F.girth;
  const hy = F.heightScale;
  const hg = F.headGirth;
  const hs = F.headScale;
  const eye = F.eyeScale;
  const brow = F.browScale;
  const nose = F.noseScale;
  const mouth = F.mouthScale;
  const parts: PartSpec[] = [
    { geo: sphere(P.pelvisTop * g, 0, 1.015 * hy, 0, 1.08, 0.72, 0.74), bone: 'Hips', mat: M.dark },
    { geo: sphere(P.waistTop * g, 0, 1.19 * hy, 0, 1.08, 1.45, 0.78), bone: 'Spine', mat: M.cloth, theme: 'cloth' },
    { geo: sphere(P.chestTop * g, 0, 1.375 * hy, 0, 1.12, 0.95, 0.68), bone: 'Chest', mat: M.cloth, theme: 'cloth' },
    { geo: cylinder(0.045 * hg, 0.055 * hg, 0.12 * hs, 0, 1.565 * hy, 0), bone: 'Neck', mat: M.skin, theme: 'skin' },
    { geo: headProfile(gender, F), bone: 'Head', mat: M.skin, theme: 'skin' },
    // 鼻（位置随身高，尺寸随脸/头系数）
    { geo: sphere(0.014 * hg, 0, 1.708 * hy, 0.078 * hg, 0.56 * nose, 1.35 * nose * hs, 1.0), bone: 'Head', mat: M.skin, theme: 'skin' },
    // 嘴
    { geo: sphere(0.016 * hg, 0, 1.677 * hy, 0.075 * hg, 1.05 * mouth, 0.20 * hs, 0.25), bone: 'Head', mat: M.lip },
  ];
  for (const side of [-1, 1]) {
    const ex = side * 0.032 * hg;
    const ey = 1.734 * hy;
    const ez = 0.069 * hg;
    // 眼眶 / 眼白 / 虹膜 / 上睫毛
    parts.push(
      { geo: sphere(0.014 * hg, side * 0.079 * hg, 1.716 * hy, 0, 0.63, 1.5 * hs, 0.85), bone: 'Head', mat: M.skin, theme: 'skin' },
      { geo: sphere(0.011 * hg * eye, ex, ey, ez, 1, 0.36 * eye * hs, 0.3), bone: 'Head', mat: M.white },
      { geo: sphere(0.0047 * hg * eye, ex, ey, ez + 0.003, 1, 0.85 * eye * hs, 0.55), bone: 'Head', mat: M.eye },
      { geo: sphere(0.018 * hg, side * 0.033 * hg, 1.752 * hy, 0.068 * hg, 1, 0.24 * brow * hs, 0.6), bone: 'Head', mat: M.hair },
    );
  }
  // 耳
  for (const side of [-1, 1]) {
    parts.push({ geo: sphere(0.012 * hg, side * 0.098 * hg, 1.715 * hy, 0.004, 0.5, 1.3 * hs, 0.9), bone: 'Head', mat: M.skin, theme: 'skin' });
  }
  if (A.hairStyle === 'bald') {
    // 光头：无发部件
  } else if (A.hairStyle === 'buzz') {
    const cap = new THREE.SphereGeometry(0.113 * hg, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.4);
    cap.scale(0.87, 1.06 * hs, 0.91);
    cap.translate(0, 1.721 * hy, 0.003);
    parts.push({ geo: cap, bone: 'Head', mat: M.hair });
  } else {
    const arc = A.hairStyle === 'long' ? 0.5 : 0.48;
    const cap = new THREE.SphereGeometry(0.113 * hg, 32, 20, 0, Math.PI * 2, 0, Math.PI * arc);
    cap.scale(0.87, 1.08 * hs, 0.91);
    cap.translate(0, 1.721 * hy, 0.003);
    parts.push({ geo: cap, bone: 'Head', mat: M.hair });
  }
  if (A.hairStyle === 'short' || A.hairStyle === 'bob' || A.hairStyle === 'long') {
    for (let i = 0; i < 5; i++) {
      parts.push({ geo: sphere(0.027 * hg, -0.063 * hg + i * 0.03 * hg, (1.792 + i * 0.004) * hy, 0.05 * hg, 1.05, 0.6, 1.9), bone: 'Head', mat: M.hair });
    }
  }
  if (A.hairStyle === 'bob' || A.hairStyle === 'long') {
    parts.push({ geo: sphere(0.105 * hg, 0, 1.653 * hy, -0.068 * hg, 0.93, 1.65 * hs, 0.53), bone: 'Head', mat: M.hair });
    parts.push({ geo: sphere(0.035 * hg, -0.087 * hg, 1.704 * hy, -0.012 * hg, 0.65, 2.4, 1.5), bone: 'Head', mat: M.hair });
    parts.push({ geo: sphere(0.035 * hg, 0.087 * hg, 1.704 * hy, -0.012 * hg, 0.65, 2.4, 1.5), bone: 'Head', mat: M.hair });
    if (A.hairStyle === 'long') {
      parts.push({ geo: sphere(0.09 * hg, 0, 1.5 * hy, -0.12 * hg, 0.8, 2.4, 0.7), bone: 'Head', mat: M.hair });
    }
  }
  return parts;
}
export interface DemoCharacter {
  scene: THREE.Group;
  meta: CharacterMeta;
  dispose: () => void;
}

/** 程序化示例人物：仅对内置男/女角色有效，appearance 决定体型/面部/发型。 */
export function buildDemoCharacter(gender: DemoGender = 'male', appearance?: Partial<Appearance>): DemoCharacter {
  const a = clampAppearance({ ...(appearance ?? {}), gender: appearance?.gender ?? gender });
  const F = buildFactors(a);
  const P = GENDERS[a.gender];
  const M = makeMats(a);
  const specs = boneSpecs(P, F);
  const PARTS: PartSpec[] = [
    ...torsoParts(P, a.gender, M, F, a),
    ...armParts(P, 1, M, F),
    ...armParts(P, -1, M, F),
    ...legParts(P, 1, M, F),
    ...legParts(P, -1, M, F),
  ];
  const scene = buildRigged(
    a.gender === 'female' ? 'PrevisFemale' : 'PrevisMale',
    specs.map((s) => ({ name: s.name, parent: s.parent, pos: s.pos })),
    PARTS,
  ).scene;
  scene.userData['themable'] = true;
  scene.userData['appearance'] = a;

  const meta: CharacterMeta = {
    id: `demo-${a.gender}-${Date.now()}`,
    fileName: a.gender === 'female' ? 'previs-female.glb' : 'previs-male.glb',
    fileSize: 0,
    gltfInfo: { meshes: PARTS.length, materials: new Set(PARTS.map((p) => p.mat)).size, bones: specs.length, hasSkin: true, hasAnimations: 0 },
    appearanceSource: a,
  };

  const dispose = () => disposeRigged(scene);

  return { scene, meta, dispose };
}
