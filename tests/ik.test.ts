import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { solveTwoBone, defaultPoleDir } from '../src/core/ik/twoBoneIK';
import { detectIKChains } from '../src/core/ik/chains';
import { applyIKChain } from '../src/core/ik/applyIK';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { guessSemantic } from '../src/core/skeleton/humanoidMap';
import type { Vec3Tuple } from '../src/types/global';

function dist(a: Vec3Tuple, b: Vec3Tuple): number {
  return new THREE.Vector3(...a).distanceTo(new THREE.Vector3(...b));
}

describe('solveTwoBone', () => {
  const root: Vec3Tuple = [0, 0, 0];
  const mid: Vec3Tuple = [0, -1, 0];
  const end: Vec3Tuple = [0, -2, 0];

  it('可达目标：末端到位、臂长保持', () => {
    const r = solveTwoBone(root, mid, end, [1, -1, 0], [0, 0, 1]);
    expect(r.reached).toBe(true);
    expect(dist(r.end, [1, -1, 0])).toBeLessThan(1e-6);
    expect(dist(root, r.mid)).toBeCloseTo(1, 5);
    expect(dist(r.mid, r.end)).toBeCloseTo(1, 5);
  });

  it('极向量侧：中间关节落在 pole 半平面', () => {
    const r = solveTwoBone(root, mid, end, [0, -1.5, 0], [0, 0, 1]);
    expect(r.mid[2]).toBeGreaterThan(0.1);
  });

  it('不可达目标被钳制到最大伸展（防完全伸直翻转）', () => {
    const r = solveTwoBone(root, mid, end, [0, -10, 0], [0, 0, 1]);
    expect(r.reached).toBe(false);
    expect(r.dist).toBeCloseTo(2 * 0.999, 5);
    expect(r.hingeDeg).toBeGreaterThan(170);
    expect(r.hingeDeg).toBeLessThan(180);
  });

  it('过近目标被钳制（防折叠）', () => {
    const r = solveTwoBone(root, mid, end, [0, -0.00001, 0], [0, 0, 1]);
    expect(r.reached).toBe(false);
    expect(r.dist).toBeGreaterThan(0);
  });

  it('零长度骨骼抛错', () => {
    expect(() => solveTwoBone(root, root, end, [0, -1, 0], [0, 0, 1])).toThrow();
  });
});

describe('defaultPoleDir', () => {
  it('微弯静息姿势推导出弯曲方向', () => {
    const p = defaultPoleDir([0, 0, 0], [0.05, -1, 0], [0, -2, 0], [0, 0, 1]);
    expect(p[0]).toBeGreaterThan(0.9);
  });

  it('完全伸直回退到启发式', () => {
    expect(defaultPoleDir([0, 0, 0], [0, -1, 0], [0, -2, 0], [0, 0, 1])).toEqual([0, 0, 1]);
  });
});

describe('humanoidMap 左右腿', () => {
  it('Shin_L/R 正确区分', () => {
    expect(guessSemantic('Shin_L')).toBe('shin.L');
    expect(guessSemantic('Shin_R')).toBe('shin.R');
    expect(guessSemantic('mixamorig:LeftLeg')).toBe('shin.L');
    expect(guessSemantic('mixamorig:RightLeg')).toBe('shin.R');
  });
});

function limb(parent: THREE.Object3D, name: string, pos: [number, number, number]): THREE.Bone {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(...pos);
  parent.add(b);
  return b;
}

describe('detectIKChains', () => {
  it('合成人形检测出 4 条链', () => {
    const g = new THREE.Group();
    const hips = limb(g, 'Hips', [0, 1, 0]);
    for (const s of ['L', 'R'] as const) {
      const ua = limb(hips, `UpperArm_${s}`, [s === 'L' ? 0.2 : -0.2, 0.4, 0]);
      const fa = limb(ua, `Forearm_${s}`, [0, -0.3, 0]);
      limb(fa, `Hand_${s}`, [0, -0.25, 0]);
      const th = limb(hips, `Thigh_${s}`, [s === 'L' ? 0.1 : -0.1, -0.1, 0]);
      const sh = limb(th, `Shin_${s}`, [0, -0.4, 0]);
      limb(sh, `Foot_${s}`, [0, -0.4, 0.05]);
    }
    const snap = buildSkeletonTree(g);
    const chains = detectIKChains(snap);
    expect(chains.map((c) => c.id).sort()).toEqual(['arm.L', 'arm.R', 'leg.L', 'leg.R']);
    expect(chains.every((c) => c.upperLen > 0 && c.lowerLen > 0)).toBe(true);
  });

  it('缺骨骼时跳过对应链', () => {
    const g = new THREE.Group();
    limb(g, 'Hips', [0, 1, 0]);
    const snap = buildSkeletonTree(g);
    expect(detectIKChains(snap)).toEqual([]);
  });
});

describe('applyIKChain', () => {
  it('live 骨骼：末端到位、长度保持、无翻转', () => {
    const g = new THREE.Group();
    const ua = limb(g, 'UA', [0, 0, 0]);
    const fa = limb(ua, 'FA', [0, -1, 0]);
    limb(fa, 'H', [0, -1, 0]);
    g.updateWorldMatrix(true, true);
    const bones = new Map<string, THREE.Bone>();
    g.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
    });
    const r = applyIKChain(
      bones,
      {
        id: 'arm.L',
        label: 't',
        type: 'arm',
        rootBone: 'UA',
        midBone: 'FA',
        endBone: 'H',
        upperLen: 1,
        lowerLen: 1,
        defaultTarget: [0, -2, 0],
        defaultPolePoint: [0, -1, 0.3],
      },
      [1, -1, 0],
      [0, -1, 0.5],
    )!;
    expect(r.reached).toBe(true);
    expect(dist(r.endPos, [1, -1, 0])).toBeLessThan(1e-4);
    // 实现后世界位置复核
    const rp = new THREE.Vector3();
    const mp = new THREE.Vector3();
    const ep = new THREE.Vector3();
    bones.get('UA')!.getWorldPosition(rp);
    bones.get('FA')!.getWorldPosition(mp);
    bones.get('H')!.getWorldPosition(ep);
    expect(rp.distanceTo(mp)).toBeCloseTo(1, 4);
    expect(mp.distanceTo(ep)).toBeCloseTo(1, 4);
  });
});
