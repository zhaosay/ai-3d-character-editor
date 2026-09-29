import * as THREE from 'three';
import type { CharacterMeta } from '../../types/global';
import { buildRigged, disposeRigged, type RigPartSpec } from '../../core/rig/skinnedRig';

/** Offline adult previs actors with neutral proportions and everyday clothing. */

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

const MALE_BODY = new THREE.MeshPhysicalMaterial({ color: 0xc99b7b, roughness: 0.68, metalness: 0, specularIntensity: 0.22, sheen: 0.08, sheenColor: 0xd2957e });
const MALE_ACCENT = new THREE.MeshStandardMaterial({ color: 0x607979, roughness: 0.9, metalness: 0 });
const FEMALE_BODY = new THREE.MeshPhysicalMaterial({ color: 0xd4aa8c, roughness: 0.68, metalness: 0, specularIntensity: 0.22, sheen: 0.08, sheenColor: 0xe4ad93 });
const FEMALE_ACCENT = new THREE.MeshStandardMaterial({ color: 0xc7bba8, roughness: 0.9, metalness: 0 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x232b36, roughness: 0.8 });
const SHOE = new THREE.MeshStandardMaterial({ color: 0x34363a, roughness: 0.78 });
const SOLE = new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.88 });

const HAIR = new THREE.MeshStandardMaterial({ color: 0x201b19, roughness: 0.86 });
const EYE = new THREE.MeshStandardMaterial({ color: 0x30251f, roughness: 0.48 });
const LIP = new THREE.MeshStandardMaterial({ color: 0x996b60, roughness: 0.8 });
const WHITE = new THREE.MeshStandardMaterial({ color: 0xded9ce, roughness: 0.9 });

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

function headProfile(gender: DemoGender): THREE.BufferGeometry {
  const jaw = gender === 'male' ? 0.064 : 0.059;
  const cheek = gender === 'male' ? 0.081 : 0.076;
  const profile = new THREE.LatheGeometry([
    new THREE.Vector2(0, -0.124), new THREE.Vector2(0.038, -0.12),
    new THREE.Vector2(jaw, -0.096), new THREE.Vector2(cheek * 0.96, -0.052),
    new THREE.Vector2(cheek, 0.005), new THREE.Vector2(cheek * 0.94, 0.053),
    new THREE.Vector2(cheek * 0.78, 0.087), new THREE.Vector2(0.044, 0.115),
    new THREE.Vector2(0, 0.124),
  ], 32);
  profile.scale(1, 1, 0.84);
  profile.translate(0, 1.72, 0.01);
  profile.name = 'head-profile';
  return profile;
}

function cylinder(rTop: number, rBottom: number, h: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, 20);
  g.translate(x, y, z);
  return g;
}

function armParts(P: GenderParams, side: 1 | -1): PartSpec[] {
  const x = P.shoulderX * side;
  const up = side > 0 ? 'UpperArm_L' : 'UpperArm_R';
  const fo = side > 0 ? 'Forearm_L' : 'Forearm_R';
  const hand = side > 0 ? 'Hand_L' : 'Hand_R';
  return [
    { geo: sphere(P.deltR * 1.13, x, 1.48, 0, 1, 1.2, 1), bone: up, mat: P.accent, theme: 'cloth' },
    { geo: capsule(P.armR * 1.15, 0.18, x, 1.37, 0), bone: up, mat: P.accent, theme: 'cloth' },
    { geo: sphere(P.elbowR, x, 1.2, 0), bone: fo, mat: P.body, theme: 'skin' },
    { geo: capsule(P.forearmR * 0.86, 0.20, x, 1.07, 0), bone: fo, mat: P.body, theme: 'skin' },
    { geo: sphere(0.045, x, 0.872, 0.008, 0.72, 1.45, 0.48), bone: hand, mat: P.body, theme: 'skin' },
    { geo: sphere(0.018, x - side * 0.026, 0.887, 0.021, 0.7, 1.65, 0.8), bone: hand, mat: P.body, theme: 'skin' },
  ];
}

function legParts(P: GenderParams, side: 1 | -1): PartSpec[] {
  const x = 0.09 * side;
  const th = side > 0 ? 'Thigh_L' : 'Thigh_R';
  const sh = side > 0 ? 'Shin_L' : 'Shin_R';
  const foot = side > 0 ? 'Foot_L' : 'Foot_R';
  return [
    { geo: capsule(P.thighR * 1.12, 0.37, x, 0.735, 0), bone: th, mat: DARK },
    { geo: sphere(P.kneeR * 1.05, x, 0.48, 0), bone: sh, mat: DARK },
    { geo: capsule(P.shinR, 0.31, x, 0.265, 0), bone: sh, mat: DARK },
    { geo: sphere(0.06, x, 0.055, 0.078, 1.08, 0.78, 1.85), bone: foot, mat: SHOE },
    { geo: box(0.12, 0.018, 0.25, x, 0.012, 0.078), bone: foot, mat: SOLE },
  ];
}

function torsoParts(P: GenderParams, gender: DemoGender): PartSpec[] {
  const parts: PartSpec[] = [
    { geo: sphere(P.pelvisTop, 0, 1.015, 0, 1.08, 0.72, 0.74), bone: 'Hips', mat: DARK },
    { geo: sphere(P.waistTop, 0, 1.19, 0, 1.08, 1.45, 0.78), bone: 'Spine', mat: P.accent, theme: 'cloth' },
    { geo: sphere(P.chestTop, 0, 1.375, 0, 1.12, 0.95, 0.68), bone: 'Chest', mat: P.accent, theme: 'cloth' },
    { geo: cylinder(0.045, 0.055, 0.12, 0, 1.565, 0), bone: 'Neck', mat: P.body, theme: 'skin' },
    { geo: headProfile(gender), bone: 'Head', mat: P.body, theme: 'skin' },
    { geo: sphere(0.014, 0, 1.708, 0.078, 0.56, 1.35, 1.0), bone: 'Head', mat: P.body, theme: 'skin' },
    { geo: sphere(0.016, 0, 1.677, 0.075, 1.05, 0.20, 0.25), bone: 'Head', mat: LIP },
  ];
  for (const side of [-1, 1]) {
    parts.push(
      { geo: sphere(0.014, side * 0.079, 1.716, 0, 0.63, 1.5, 0.85), bone: 'Head', mat: P.body, theme: 'skin' },
      { geo: sphere(0.011, side * 0.032, 1.734, 0.069, 1, 0.36, 0.3), bone: 'Head', mat: WHITE },
      { geo: sphere(0.0047, side * 0.032, 1.734, 0.072, 1, 0.85, 0.55), bone: 'Head', mat: EYE },
      { geo: sphere(0.018, side * 0.033, 1.752, 0.068, 1, 0.24, 0.6), bone: 'Head', mat: HAIR },
    );
  }
  // Partial spherical cap leaves the face open; overlapping locks break its silhouette.
  const cap = new THREE.SphereGeometry(0.113, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.48);
  cap.scale(0.87, 1.08, 0.91);
  cap.translate(0, 1.721, 0.003);
  parts.push({ geo: cap, bone: 'Head', mat: HAIR });
  for (let i = 0; i < 5; i++) {
    parts.push({ geo: sphere(0.027, -0.063 + i * 0.03, 1.792 + i * 0.004, 0.05, 1.05, 0.6, 1.9), bone: 'Head', mat: HAIR });
  }
  if (gender === 'female') {
    parts.push(
      { geo: sphere(0.105, 0, 1.653, -0.068, 0.93, 1.65, 0.53), bone: 'Head', mat: HAIR },
      { geo: sphere(0.035, -0.087, 1.704, -0.012, 0.65, 2.4, 1.5), bone: 'Head', mat: HAIR },
      { geo: sphere(0.035, 0.087, 1.704, -0.012, 0.65, 2.4, 1.5), bone: 'Head', mat: HAIR },
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
    gender === 'female' ? 'PrevisFemale' : 'PrevisMale',
    specs.map((s) => ({ name: s.name, parent: s.parent, pos: s.pos })),
    PARTS,
  ).scene;
  scene.userData['themable'] = true;

  const meta: CharacterMeta = {
    id: `demo-${gender}-${Date.now()}`,
    fileName: gender === 'female' ? 'previs-female.glb' : 'previs-male.glb',
    fileSize: 0,
    gltfInfo: { meshes: PARTS.length, materials: new Set(PARTS.map((p) => p.mat)).size, bones: specs.length, hasSkin: true, hasAnimations: 0 },
  };

  const dispose = () => disposeRigged(scene);

  return { scene, meta, dispose };
}
