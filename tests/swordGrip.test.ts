import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { detectIKChains } from '../src/core/ik/chains';
import { swordAnchorsWorld, guardTarget, facingBasis, GUARD_SPEC, STRIKE_SPEC, gripSpanIsPlausible, scaleStanceToLeg, DEFAULT_SWORD_STANCE } from '../src/core/weapon/grip';
import { solveTwoHandedGrip } from '../src/core/weapon/gripSolve';
import type { Vec3Tuple } from '../src/types/global';

function bone(parent: THREE.Object3D, name: string, x: number, y: number, z = 0): THREE.Bone {
  const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent.add(b); return b;
}

/** 与 buildDemoCharacter 同构：_L 在 +X，_R 在 −X，面朝 +Z，骨骼无初始旋转 */
function rig(sy = 0.96477) {
  const g = new THREE.Group();
  const hips = bone(g, 'Hips', 0, 0.984, 0);
  const spine = bone(hips, 'Spine', 0, 0.125, 0);
  const chest = bone(spine, 'Chest', 0, 0.184, 0);
  const neck = bone(chest, 'Neck', 0, 0.16, 0);
  bone(neck, 'Head', 0, 0.1, 0);
  const ur = bone(chest, 'UpperArm_R', -0.24, 0.16, 0);
  const fr = bone(ur, 'Forearm_R', 0, -0.3 * sy, 0);
  bone(fr, 'Hand_R', 0, -0.28 * sy, 0);
  const ul = bone(chest, 'UpperArm_L', 0.24, 0.16, 0);
  const fl = bone(ul, 'Forearm_L', 0, -0.3 * sy, 0);
  bone(fl, 'Hand_L', 0, -0.28 * sy, 0);
  const tr = bone(hips, 'Thigh_R', -0.1, -0.1, 0);
  const sr = bone(tr, 'Shin_R', 0, -0.42 * sy, 0);
  bone(sr, 'Foot_R', 0, -0.4 * sy, 0);
  const tl = bone(hips, 'Thigh_L', 0.1, -0.1, 0);
  const sl = bone(tl, 'Shin_L', 0, -0.42 * sy, 0);
  bone(sl, 'Foot_L', 0, -0.4 * sy, 0);
  g.updateWorldMatrix(true, true);
  return { g, hips };
}

/** demo rig：左肩 +X、右肩 −X、脊柱向上 */
const DEMO_LEFT = new THREE.Vector3(0.24, 1.33, 0);
const DEMO_RIGHT = new THREE.Vector3(-0.24, 1.33, 0);
const DEMO_MIDLINE = DEMO_LEFT.clone().add(DEMO_RIGHT).multiplyScalar(0.5);
const demoBasis = () => facingBasis(DEMO_LEFT, DEMO_RIGHT, new THREE.Vector3(0, 1, 0));

const swordR = { attachTo: 'hand.R' as const, attachOffset: [0, 0, 0] as Vec3Tuple, rotationY: 0, size: { width: 0.045, height: 0.045, length: 0.9 } };
const swordL = { ...swordR, attachTo: 'hand.L' as const };

describe('sword grip anchors', () => {
  it('锚点沿剑的 +Y 轴排列（刃向），柄尾在主手下方', () => {
    const { g } = rig();
    const hand = g.getObjectByName('Hand_R') as THREE.Bone;
    const a = swordAnchorsWorld(hand, swordR);
    // 默认握把/柄尾相隔 9cm，沿局部 +Y
    expect(a.grip.distanceTo(a.pommel)).toBeCloseTo(0.09, 3);
    // 静息姿（骨骼无旋转）下剑轴 = 世界 +Y，柄尾在握点下方
    expect(a.pommel.y).toBeLessThan(a.grip.y);
    expect(a.grip.y - a.pommel.y).toBeCloseTo(0.09, 3);
    expect(gripSpanIsPlausible(a)).toBe(true);
  });

  it('剑长只影响刃尖，不影响握点（换剑不脱手）', () => {
    const { g } = rig();
    const hand = g.getObjectByName('Hand_R') as THREE.Bone;
    const short = swordAnchorsWorld(hand, swordR);
    const long = swordAnchorsWorld(hand, { ...swordR, size: { ...swordR.size, length: 1.6 } });
    expect(long.grip.distanceTo(short.grip)).toBeLessThan(1e-9);
    expect(long.pommel.distanceTo(short.pommel)).toBeLessThan(1e-9);
    // tip = length*1.02 → Δ = 0.7*1.02
    expect(long.tip.distanceTo(short.tip)).toBeCloseTo(0.7 * 1.02, 6);
  });

  it('attachOffset 生效（剑柄整体平移，两手一起跟过去）', () => {
    const { g } = rig();
    const hand = g.getObjectByName('Hand_R') as THREE.Bone;
    const base = swordAnchorsWorld(hand, swordR);
    const off = swordAnchorsWorld(hand, { ...swordR, attachOffset: [0, 0.05, 0] });
    expect(off.grip.y - base.grip.y).toBeCloseTo(0.05, 6);
    expect(off.pommel.y - base.pommel.y).toBeCloseTo(0.05, 6);
  });
});

describe('facingBasis', () => {
  it('由解剖推出朝向，不靠「面朝 +Z」约定', () => {
    const b = demoBasis();
    expect(b.forward.x).toBeCloseTo(0, 6);
    expect(b.forward.z).toBeCloseTo(1, 6);   // demo rig 确实面朝 +Z
    expect(b.left.x).toBeCloseTo(1, 6);      // 角色左侧在 +X
  });

  it('整体旋转后朝向跟着转（不锁死世界轴）', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const rot = (v: THREE.Vector3) => v.clone().applyQuaternion(q);
    const b = facingBasis(rot(DEMO_LEFT), rot(DEMO_RIGHT), rot(new THREE.Vector3(0, 1, 0)));
    // left(1,0,0) 绕 Y 转 90° → (0,0,-1)；forward = left×up = (0,0,-1)×(0,1,0) = (1,0,0)
    expect(b.forward.x).toBeCloseTo(1, 6);
    expect(b.forward.z).toBeCloseTo(0, 6);
  });

  it('退化输入（两肩重合）退回安全默认值，不产生 NaN', () => {
    const b = facingBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0));
    expect(b.forward.toArray()).toEqual([0, 0, 1]);
    expect(Number.isNaN(b.forward.x)).toBe(false);
  });
});

describe('guardTarget 体型自适应', () => {
  it('目标随臂长线性缩放（1.6m 与 1.9m 角色同比例）', () => {
    const sh = new THREE.Vector3(-0.24, 1.33, 0);
    const basis = demoBasis();
    const small = guardTarget(sh, 0.50, basis, DEMO_MIDLINE, GUARD_SPEC);
    const big = guardTarget(sh, 0.62, basis, DEMO_MIDLINE, GUARD_SPEC);
    const dSmall = small.distanceTo(sh);
    const dBig = big.distanceTo(sh);
    expect(dBig / dSmall).toBeCloseTo(0.62 / 0.50, 2);
  });

  it('目标落在身前且向中线内收', () => {
    const sh = new THREE.Vector3(-0.24, 1.33, 0);
    const t = guardTarget(sh, 0.58, demoBasis(), DEMO_MIDLINE, GUARD_SPEC);
    expect(t.z).toBeGreaterThan(0.2);          // 身前
    expect(t.x).toBeGreaterThan(-0.24);         // 向中线内收
    expect(Math.abs(t.x)).toBeLessThan(0.2);
  });

  it('出剑伸展位比护手位更远、更高', () => {
    const sh = new THREE.Vector3(-0.24, 1.33, 0);
    const g = guardTarget(sh, 0.58, demoBasis(), DEMO_MIDLINE, GUARD_SPEC);
    const s = guardTarget(sh, 0.58, demoBasis(), DEMO_MIDLINE, STRIKE_SPEC);
    expect(s.z).toBeGreaterThan(g.z);
    expect(s.y).toBeGreaterThan(g.y);
  });
});

describe('solveTwoHandedGrip', () => {
  const setup = (sy?: number) => {
    const { g, hips } = rig(sy);
    const chains = detectIKChains(buildSkeletonTree(g));
    return { g, hips, chains };
  };

  it('右手持剑：双手都落在锚点上（<3cm）', () => {
    const { g, hips, chains } = setup();
    const r = solveTwoHandedGrip(g, chains, hips, swordR)!;
    expect(r).not.toBeNull();
    expect(r.offSide).toBe('L');
    expect(r.mainToGripM).toBeLessThan(0.03);
    expect(r.offToPommelM).toBeLessThan(0.03);
    expect(r.reached).toBe(true);
    expect(r.clamped).toBe(false);
  });

  it('左手持剑：副手变成右手，且同样握住', () => {
    const { g, hips, chains } = setup();
    const r = solveTwoHandedGrip(g, chains, hips, swordL)!;
    expect(r.offSide).toBe('R');
    expect(r.offToPommelM).toBeLessThan(0.03);
    expect(r.reached).toBe(true);
  });

  it('双手伸展率都在合理区间（肘不锁死也不贴肩）', () => {
    const { g, hips, chains } = setup();
    const r = solveTwoHandedGrip(g, chains, hips, swordR)!;
    expect(r.mainExtension).toBeGreaterThan(0.55);
    expect(r.mainExtension).toBeLessThan(0.98);
    expect(r.offExtension).toBeGreaterThan(0.4);
    expect(r.offExtension).toBeLessThan(0.99);
  });

  it('体型更大（臂更长）时双手间距不变（间距由剑决定，与体型无关）', () => {
    const a = setup(0.92);
    const ra = solveTwoHandedGrip(a.g, a.chains, a.hips, swordR)!;
    const b = setup(1.02);
    const rb = solveTwoHandedGrip(b.g, b.chains, b.hips, swordR)!;
    expect(ra.spanM).toBeCloseTo(rb.spanM, 6);
    expect(ra.offToPommelM).toBeLessThan(0.03);
    expect(rb.offToPommelM).toBeLessThan(0.03);
  });

  it('出剑伸展位也能双手握住，且肘不锁死', () => {
    const { g, hips, chains } = setup();
    const r = solveTwoHandedGrip(g, chains, hips, swordR, STRIKE_SPEC)!;
    expect(r.mainToGripM).toBeLessThan(0.03);
    expect(r.offToPommelM).toBeLessThan(0.03);
    expect(r.reached).toBe(true);
    expect(r.clamped).toBe(false);
    // 比护手位更伸展，但不到锁死
    expect(r.mainExtension).toBeGreaterThan(0.85);
    expect(r.mainExtension).toBeLessThan(0.95);
  });

  it('出剑刃向偏转在腕部活动度内（实测 26.3°）', () => {
    const { g, hips, chains } = setup();
    const r = solveTwoHandedGrip(g, chains, hips, swordR, STRIKE_SPEC)!;
    expect(r.bladeAxisErrDeg).toBeLessThan(40);
  });

  it('柄尾偏差对刃向不敏感（±90° 刃向变化下握持始终 <3cm）', () => {
    // 实测证据：刃向从斜举到前平举，offErr 恒为 13~14mm —— 握持由臂长决定，不由剑指向决定
    for (const bladeUp of [0.84, 0.35, 0.0, -0.4]) {
      const { g, hips, chains } = setup();
      const r = solveTwoHandedGrip(g, chains, hips, swordR, { ...STRIKE_SPEC, bladeUp })!;
      expect(r.offToPommelM).toBeLessThan(0.03);
    }
  });

  it('未持剑（attachTo=null）时不介入', () => {
    const { g, hips, chains } = setup();
    expect(solveTwoHandedGrip(g, chains, hips, { ...swordR, attachTo: null })).toBeNull();
  });

  it('缺少臂链时安全返回 null（导入骨骼不完整不崩）', () => {
    const g = new THREE.Group();
    bone(g, 'Hips', 0, 1, 0);
    expect(solveTwoHandedGrip(g, [], null, swordR)).toBeNull();
  });

  it('主手不被副手解算污染（单向依赖，可重复求解稳定）', () => {
    const { g, hips, chains } = setup();
    const hand = g.getObjectByName('Hand_R') as THREE.Bone;
    solveTwoHandedGrip(g, chains, hips, swordR);
    const first = hand.getWorldPosition(new THREE.Vector3()).clone();
    solveTwoHandedGrip(g, chains, hips, swordR);
    const second = hand.getWorldPosition(new THREE.Vector3());
    // 幂等：重复求解不漂移
    expect(second.distanceTo(first)).toBeLessThan(1e-6);
  });
});

describe('scaleStanceToLeg', () => {
  it('站姿随腿长线性缩放，角度项不变', () => {
    const big = scaleStanceToLeg(DEFAULT_SWORD_STANCE, 1.0);
    expect(big.backFootZ).toBeCloseTo(DEFAULT_SWORD_STANCE.backFootZ * (1.0 / 0.86), 6);
    expect(big.kneeBend).toBe(DEFAULT_SWORD_STANCE.kneeBend);
    expect(big.torsoYaw).toBe(DEFAULT_SWORD_STANCE.torsoYaw);
  });
});