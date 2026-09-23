import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSketchSpec, canvasToWorld, LANDMARK_ORDER } from '../src/core/rig/sketchToSpec';
import { buildRigged } from '../src/core/rig/skinnedRig';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { detectIKChains } from '../src/core/ik/chains';
import type { SketchPoint } from '../src/core/rig/sketchToSpec';

/** 画满画布的标准站姿（头顶 y≈40，脚 y≈500） */
function stdPose(): Record<string, SketchPoint> {
  return {
    head: { x: 200, y: 40 },
    neck: { x: 200, y: 110 },
    shoulder: { x: 150, y: 130 },
    elbow: { x: 140, y: 220 },
    wrist: { x: 145, y: 300 },
    hips: { x: 200, y: 280 },
    knee: { x: 195, y: 390 },
    ankle: { x: 195, y: 500 },
  };
}

describe('sketchToSpec', () => {
  it('8 点生成 17 骨骼标准命名', () => {
    const { bones, warnings } = buildSketchSpec(stdPose(), { headR: 0.115, thickness: 1 });
    expect(bones).toHaveLength(17);
    expect(bones.map((b) => b.name).sort()).toEqual(
      ['Chest', 'Foot_L', 'Foot_R', 'Forearm_L', 'Forearm_R', 'Hand_L', 'Hand_R', 'Head', 'Hips', 'Neck', 'Shin_L', 'Shin_R', 'Spine', 'Thigh_L', 'Thigh_R', 'UpperArm_L', 'UpperArm_R'].sort(),
    );
    expect(warnings).toEqual([]);
  });

  it('右侧自动镜像', () => {
    const { bones } = buildSketchSpec(stdPose(), { headR: 0.115, thickness: 1 });
    const byName = new Map(bones.map((b) => [b.name, b]));
    // 肩：左 x>0 则右 x<0 且绝对值相等（归一化保距）
    const hips = byName.get('Hips')!;
    const uaL = byName.get('UpperArm_L')!;
    const uaR = byName.get('UpperArm_R')!;
    const shoulderLx = hips.pos[0] + uaL.pos[0];
    const shoulderRx = hips.pos[0] + uaR.pos[0];
    expect(shoulderLx).toBeCloseTo(-shoulderRx, 5);
  });

  it('身高归一化约 1.82m，双脚落地', () => {
    const { bones } = buildSketchSpec(stdPose(), { headR: 0.115, thickness: 1 });
    const world = new Map<string, [number, number, number]>();
    for (const b of bones) {
      const p = b.parent ? world.get(b.parent)! : ([0, 0, 0] as [number, number, number]);
      world.set(b.name, [p[0] + b.pos[0], p[1] + b.pos[1], p[2] + b.pos[2]]);
    }
    expect(world.get('Foot_L')![1]).toBeCloseTo(0.03, 2);
    expect(world.get('Foot_R')![1]).toBeCloseTo(0.03, 2);
    // 头关节到脚 1.5m + 头半径 ≈ 头顶 1.82m 量级
    const span = world.get('Head')![1] - world.get('Foot_L')![1];
    expect(span).toBeGreaterThan(1.4);
    expect(span).toBeLessThan(1.65);
  });

  it('过近两点自动拉开并警告', () => {
    const pose = stdPose();
    pose.elbow = { ...pose.shoulder };
    const { warnings } = buildSketchSpec(pose, { headR: 0.115, thickness: 1 });
    expect(warnings.join()).toMatch(/上臂/);
  });

  it('缺描点/出界抛错（不静默生成残废）', () => {
    const pose = stdPose() as Record<string, SketchPoint>;
    delete pose.ankle;
    expect(() => buildSketchSpec(pose, { headR: 0.115, thickness: 1 })).toThrow(/左踝/);
    const bad = stdPose();
    bad.head = { x: 9999, y: 10 };
    expect(() => buildSketchSpec(bad, { headR: 0.115, thickness: 1 })).toThrow(/超出画布/);
  });

  it('canvas 映射：画布顶≈1.9m，底≈0m', () => {
    expect(canvasToWorld({ x: 200, y: 0 })[1]).toBeCloseTo(1.9, 5);
    expect(canvasToWorld({ x: 200, y: 520 })[1]).toBeCloseTo(0, 5);
    expect(canvasToWorld({ x: 0, y: 260 })[0]).toBeCloseTo(-0.5, 5);
    expect(LANDMARK_ORDER).toHaveLength(8);
  });
});

describe('sketch 建模端到端（骨骼+语义+IK）', () => {
  it('生成角色 17 骨全映射 + 4 IK 链', () => {
    const { bones, parts } = buildSketchSpec(stdPose(), { headR: 0.115, thickness: 1 });
    const { scene } = buildRigged(
      'SketchTest',
      bones,
      parts.map((p) => ({ geo: p.geo, bone: p.bone, mat: new THREE.MeshStandardMaterial() })),
    );
    const snap = buildSkeletonTree(scene);
    expect(snap.boneCount).toBe(17);
    expect(Object.values(snap.nodes).filter((n) => !n.semantic)).toEqual([]);
    expect(detectIKChains(snap).map((c) => c.id).sort()).toEqual(['arm.L', 'arm.R', 'leg.L', 'leg.R']);
  });
});
