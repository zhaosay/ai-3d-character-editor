import * as THREE from 'three';
import type { RigBoneSpec, RigPartSpec } from './skinnedRig';

/** 描点捏人（独立模块，可单测）：2D 画布关节点 → 标准化 3D 规格。 */

export const SKETCH_W = 400;
export const SKETCH_H = 520;

export interface SketchPoint {
  x: number;
  y: number;
}

export type LandmarkKey = 'head' | 'neck' | 'shoulder' | 'elbow' | 'wrist' | 'hips' | 'knee' | 'ankle';

export const LANDMARK_ORDER: LandmarkKey[] = ['head', 'neck', 'shoulder', 'elbow', 'wrist', 'hips', 'knee', 'ankle'];

export const LANDMARK_LABELS: Record<LandmarkKey, string> = {
  head: '头部中心',
  neck: '颈部',
  shoulder: '左肩',
  elbow: '左肘',
  wrist: '左腕',
  hips: '髋部中心',
  knee: '左膝',
  ankle: '左踝',
};

export interface SketchOptions {
  /** 头半径（米），0.09–0.15 */
  headR: number;
  /** 肢体粗细倍率，0.7–1.3 */
  thickness: number;
}

export type MatRole = 'skin' | 'accent' | 'dark';

export interface SketchPartSpec extends Omit<RigPartSpec, 'mat'> {
  role: MatRole;
}

export interface SketchSpec {
  bones: RigBoneSpec[];
  parts: SketchPartSpec[];
  warnings: string[];
}

/** 画布像素 → 世界米（正面视角，x 右为正，y 上为正）。 */
export function canvasToWorld(p: SketchPoint): [number, number, number] {
  return [((p.x - SKETCH_W / 2) / (SKETCH_W / 2)) * 0.5, ((SKETCH_H - p.y) / SKETCH_H) * 1.9, 0];
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mirrorX = (a: V3): V3 => [-a[0], a[1], a[2]];

function box(w: number, h: number, d: number, c: V3): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(c[0], c[1], c[2]);
  return g;
}

function capsuleBetween(a: V3, b: V3, r: number, cylLen: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3(...sub(b, a));
  if (dir.lengthSq() < 1e-10) dir.set(0, -1, 0);
  const g = new THREE.CapsuleGeometry(r, Math.max(cylLen, 0.02), 6, 12);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
  const mid = mul(add(a, b), 0.5);
  g.translate(mid[0], mid[1], mid[2]);
  return g;
}

function orientCylinder(pBottom: V3, pTop: V3, rBottom: number, rTop: number): THREE.BufferGeometry {
  const h = Math.max(len(sub(pTop, pBottom)), 0.02);
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, 20);
  const dir = new THREE.Vector3(...sub(pTop, pBottom)).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  const mid = mul(add(pBottom, pTop), 0.5);
  g.translate(mid[0], mid[1], mid[2]);
  return g;
}

function sphereAt(r: number, c: V3, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 24, 18);
  g.scale(sx, sy, sz);
  g.translate(c[0], c[1], c[2]);
  return g;
}

/** 子节点与父节点过近时沿当前方向推开，保证骨骼有最小长度。 */
function ensureLength(parent: V3, child: V3, min: number, label: string, warnings: string[]): V3 {
  const d = sub(child, parent);
  const l = len(d);
  if (l >= min) return child;
  const dir: V3 = l > 1e-6 ? mul(d, 1 / l) : [0, -1, 0];
  warnings.push(`${label}两点过近，已自动拉开到 ${min}m`);
  return add(parent, mul(dir, min));
}

const BONE_NAMES = [
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'UpperArm_L', 'Forearm_L', 'Hand_L', 'UpperArm_R', 'Forearm_R', 'Hand_R',
  'Thigh_L', 'Shin_L', 'Foot_L', 'Thigh_R', 'Shin_R', 'Foot_R',
];

export function buildSketchSpec(
  landmarks: Partial<Record<LandmarkKey, SketchPoint>>,
  opts: SketchOptions,
): SketchSpec {
  for (const k of LANDMARK_ORDER) {
    const p = landmarks[k];
    if (!p) throw new Error(`缺少描点：${LANDMARK_LABELS[k]}（${LANDMARK_ORDER.indexOf(k) + 1}/8）`);
    if (!(p.x >= 0 && p.x <= SKETCH_W && p.y >= 0 && p.y <= SKETCH_H)) {
      throw new Error(`${LANDMARK_LABELS[k]}超出画布`);
    }
  }
  const warnings: string[] = [];
  const headR = Math.min(Math.max(opts.headR, 0.09), 0.15);
  const thick = Math.min(Math.max(opts.thickness, 0.7), 1.3);

  const P = (k: LandmarkKey) => canvasToWorld(landmarks[k]!);
  let head = P('head');
  const neck = P('neck');
  let shoulderL = P('shoulder');
  let elbowL = P('elbow');
  let wristL = P('wrist');
  const hips = P('hips');
  let kneeL = P('knee');
  let ankleL = P('ankle');

  head = ensureLength(neck, head, 0.08, '头颈', warnings);
  shoulderL = ensureLength(neck, shoulderL, 0.1, '颈肩', warnings);
  elbowL = ensureLength(shoulderL, elbowL, 0.15, '上臂', warnings);
  wristL = ensureLength(elbowL, wristL, 0.15, '前臂', warnings);
  kneeL = ensureLength(hips, kneeL, 0.2, '大腿', warnings);
  ankleL = ensureLength(kneeL, ankleL, 0.25, '小腿', warnings);

  // 右侧镜像
  const shoulderR = mirrorX(shoulderL);
  const elbowR = mirrorX(elbowL);
  const wristR = mirrorX(wristL);
  const kneeR = mirrorX(kneeL);
  const ankleR = mirrorX(ankleL);

  // 躯干链 + 腿根/头关节
  const spine = lerp(hips, neck, 0.35);
  const chest = lerp(hips, neck, 0.7);
  const headJoint = lerp(neck, head, 0.35);
  const thighJL: V3 = [kneeL[0], hips[1] - 0.05, 0];
  const thighJR = mirrorX(thighJL);
  const toeL: V3 = [ankleL[0], ankleL[1] - 0.005, ankleL[2] + 0.13];
  const toeR = mirrorX(toeL);

  // 归一化：缩放到头顶 1.82m，双脚落到 0.03m
  const ankleMidY = (ankleL[1] + ankleR[1]) / 2;
  const headTop = head[1] + headR;
  const span = headTop - ankleMidY;
  if (!(span > 0.3)) throw new Error('头到脚距离过小，请重新描点');
  let s = 1.79 / span;
  if (s < 0.5 || s > 2.5) {
    warnings.push('身高超出常规范围，已钳制缩放');
    s = Math.min(Math.max(s, 0.5), 2.5);
  }
  const ankleMidX = (ankleL[0] + ankleR[0]) / 2;
  const norm = (p: V3): V3 => [ankleMidX + (p[0] - ankleMidX) * s, 0.03 + (p[1] - ankleMidY) * s, p[2] * s];

  const W: Record<string, V3> = {
    Hips: norm(hips), Spine: norm(spine), Chest: norm(chest), Neck: norm(neck), Head: norm(headJoint),
    headC: norm(head),
    UpperArm_L: norm(shoulderL), Forearm_L: norm(elbowL), Hand_L: norm(wristL),
    UpperArm_R: norm(shoulderR), Forearm_R: norm(elbowR), Hand_R: norm(wristR),
    Thigh_L: norm(thighJL), Shin_L: norm(kneeL), Foot_L: norm(ankleL),
    Thigh_R: norm(thighJR), Shin_R: norm(kneeR), Foot_R: norm(ankleR),
    toeL: norm(toeL), toeR: norm(toeR),
  };

  const parents: Record<string, string | null> = {
    Hips: null, Spine: 'Hips', Chest: 'Spine', Neck: 'Chest', Head: 'Neck',
    UpperArm_L: 'Chest', Forearm_L: 'UpperArm_L', Hand_L: 'Forearm_L',
    UpperArm_R: 'Chest', Forearm_R: 'UpperArm_R', Hand_R: 'Forearm_R',
    Thigh_L: 'Hips', Shin_L: 'Thigh_L', Foot_L: 'Shin_L',
    Thigh_R: 'Hips', Shin_R: 'Thigh_R', Foot_R: 'Shin_R',
  };
  const bones: RigBoneSpec[] = BONE_NAMES.map((name) => {
    const parent = parents[name]!;
    const pw: V3 = parent ? W[parent] : [0, 0, 0];
    return { name, parent, pos: sub(W[name], pw) };
  });

  // 体型跟随肩宽
  const shoulderHalf = Math.abs(W['UpperArm_L'][0]);
  const waistR = Math.min(Math.max(shoulderHalf * 0.55, 0.09), 0.16);
  const chestR = waistR + 0.03;
  const pelvisR = waistR + 0.02;
  const armR = 0.052 * thick;
  const foreR = 0.046 * thick;
  const thighR = 0.066 * thick;
  const shinR = 0.055 * thick;

  const segLen = (a: string, b: string) => len(sub(W[b], W[a]));

  const parts: SketchPartSpec[] = [];
  const add = (p: SketchPartSpec) => parts.push(p);
  // 躯干
  add({ geo: orientCylinder(W['Hips'], lerp(W['Hips'], W['Chest'], 0.45), pelvisR, waistR), bone: 'Hips', role: 'skin' } as SketchPartSpec);
  add({ geo: box(pelvisR * 2 + 0.02, 0.05, 0.22, [0, W['Hips'][1] + 0.07, 0]), bone: 'Hips', role: 'accent' } as SketchPartSpec);
  add({ geo: orientCylinder(lerp(W['Hips'], W['Chest'], 0.4), lerp(W['Hips'], W['Chest'], 0.72), waistR, waistR), bone: 'Spine', role: 'skin' } as SketchPartSpec);
  add({ geo: orientCylinder(lerp(W['Hips'], W['Chest'], 0.68), W['Chest'], waistR, chestR), bone: 'Chest', role: 'skin' } as SketchPartSpec);
  // 头颈
  const neckLen = segLen('Neck', 'Head');
  add({ geo: capsuleBetween(W['Neck'], W['Head'], 0.05 * thick, neckLen * 0.6), bone: 'Neck', role: 'skin' } as SketchPartSpec);
  add({ geo: sphereAt(headR, W['headC'], 0.92, 1.08, 0.95), bone: 'Head', role: 'skin' } as SketchPartSpec);
  add({ geo: sphereAt(headR * 0.14, [W['headC'][0] - headR * 0.36, W['headC'][1] + headR * 0.12, W['headC'][2] + headR * 0.88]), bone: 'Head', role: 'dark' } as SketchPartSpec);
  add({ geo: sphereAt(headR * 0.14, [W['headC'][0] + headR * 0.36, W['headC'][1] + headR * 0.12, W['headC'][2] + headR * 0.88]), bone: 'Head', role: 'dark' } as SketchPartSpec);
  add({ geo: box(headR * 1.6, headR * 0.5, headR * 1.7, [W['headC'][0], W['headC'][1] + headR * 0.95, W['headC'][2] - headR * 0.1]), bone: 'Head', role: 'dark' } as SketchPartSpec);
  // 四肢（左右）
  for (const side of ['L', 'R'] as const) {
    const UA = `UpperArm_${side}`;
    const FO = `Forearm_${side}`;
    const HA = `Hand_${side}`;
    const TH = `Thigh_${side}`;
    const SH = `Shin_${side}`;
    const FT = `Foot_${side}`;
    add({ geo: sphereAt(armR + 0.012, W[UA]), bone: UA, role: 'skin' } as SketchPartSpec);
    add({ geo: capsuleBetween(W[UA], W[FO], armR, segLen(UA, FO) * 0.7), bone: UA, role: 'skin' } as SketchPartSpec);
    add({ geo: sphereAt(foreR, W[FO]), bone: FO, role: 'skin' } as SketchPartSpec);
    add({ geo: capsuleBetween(W[FO], W[HA], foreR, segLen(FO, HA) * 0.7), bone: FO, role: 'skin' } as SketchPartSpec);
    add({ geo: box(0.07, 0.15, 0.075, [W[HA][0], W[HA][1] - 0.07, W[HA][2]]), bone: HA, role: 'dark' } as SketchPartSpec);
    add({ geo: capsuleBetween(W[TH], W[SH], thighR, segLen(TH, SH) * 0.7), bone: TH, role: 'dark' } as SketchPartSpec);
    add({ geo: sphereAt(shinR + 0.004, W[SH]), bone: SH, role: 'skin' } as SketchPartSpec);
    add({ geo: capsuleBetween(W[SH], W[FT], shinR, segLen(SH, FT) * 0.7), bone: SH, role: 'skin' } as SketchPartSpec);
    add({ geo: box(0.095, 0.07, 0.25, [W[FT][0], 0.035, W[FT][2] + 0.06]), bone: FT, role: 'dark' } as SketchPartSpec);
  }

  return { bones, parts, warnings };
}
