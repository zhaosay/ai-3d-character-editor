import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSketchSpec, canvasToWorld, clientToSketchPoint, findSketchPointHit, LANDMARK_ORDER, restoreSketchDraft, STANDARD_SKETCH_POSE, validateSketchLandmarks } from '../src/core/rig/sketchToSpec';
import { buildRigged } from '../src/core/rig/skinnedRig';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { detectIKChains } from '../src/core/ik/chains';
import { buildSketchCharacter } from '../src/services/sketch/buildSketchCharacter';
import { useThemeStore } from '../src/stores/themeStore';
import type { SketchPoint } from '../src/core/rig/sketchToSpec';

/** 画满画布的标准站姿（头顶 y≈40，脚 y≈500） */
function stdPose(): Record<string, SketchPoint> {
  return structuredClone(STANDARD_SKETCH_POSE);
}

describe('sketchToSpec', () => {
  it('resizes pointer coordinates correctly and keeps landmark hit targets usable on narrow canvases', () => {
    const rect = { left: 10, top: 20, width: 200, height: 260 };
    expect(clientToSketchPoint(110, 150, rect)).toEqual({ x: 200, y: 260 });
    expect(clientToSketchPoint(0, 0, { ...rect, width: 0 })).toBeNull();
    const points = [{ x: 200, y: 260 }, null];
    expect(findSketchPointHit(points, { x: 230, y: 260 }, rect)).toBe(0);
    expect(findSketchPointHit(points, { x: 250, y: 260 }, rect)).toBeNull();
  });

  it('lets a saved out-of-bounds landmark be grabbed from its visible canvas edge', () => {
    const rect = { width: 200, height: 260 };
    expect(findSketchPointHit([{ x: -1200, y: 260 }, null], { x: 0, y: 260 }, rect)).toBe(0);
    expect(findSketchPointHit([{ x: 200, y: 1600 }, null], { x: 200, y: 520 }, rect)).toBe(0);
  });

  it('restores saved sketch landmarks and shape controls as an editable draft', () => {
    const source = {
      landmarks: stdPose(),
      options: { headR: 0.13, thickness: 1.2 },
    };
    const draft = restoreSketchDraft(source);
    expect(draft.points).toEqual(LANDMARK_ORDER.map((key) => source.landmarks[key]));
    expect(draft.options).toEqual(source.options);

    const partial = restoreSketchDraft({
      landmarks: { head: { x: Number.NaN, y: 40 }, neck: { x: 200, y: 110 } },
      options: { headR: 0.2, thickness: 0.4 },
    });
    expect(partial.points[0]).toBeNull();
    expect(partial.points[1]).toEqual({ x: 200, y: 110 });
    expect(partial.options).toEqual({ headR: 0.15, thickness: 0.7 });

    const invalidOptions = restoreSketchDraft({ landmarks: stdPose(), options: { headR: Number.NaN, thickness: Number.POSITIVE_INFINITY } });
    expect(invalidOptions.options).toEqual({ headR: 0.115, thickness: 1 });
  });

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

  it('错误关节顺序会在建模前报错，不再静默拉伸成畸形角色', () => {
    const pose = stdPose();
    pose.elbow = { ...pose.shoulder };
    expect(validateSketchLandmarks(pose).join()).toMatch(/左肩、左肘、左腕/);
    expect(() => buildSketchSpec(pose, { headR: 0.115, thickness: 1 })).toThrow(/左肩、左肘、左腕/);
  });

  it('关节点过近时给出可操作错误，避免生成被自动拉长的怪异肢体', () => {
    const pose = stdPose();
    pose.wrist = { x: pose.elbow.x + 1, y: pose.elbow.y + 1 };
    expect(validateSketchLandmarks(pose).join()).toMatch(/左肘和左腕距离太近/);
    expect(() => buildSketchSpec(pose, { headR: 0.115, thickness: 1 })).toThrow(/左肘和左腕距离太近/);
  });

  it('会在生成前拒绝被造型器自动拉长的短上臂，而不是通过校验后悄悄改形', () => {
    const pose = stdPose();
    pose.elbow = { x: pose.shoulder.x, y: pose.shoulder.y + 30 };
    expect(validateSketchLandmarks(pose).join()).toMatch(/左肩和左肘距离太近/);
    expect(() => buildSketchSpec(pose, { headR: 0.115, thickness: 1 })).toThrow(/左肩和左肘距离太近/);
  });

  it('会在生成前拒绝过短的颈肩距离', () => {
    const pose = stdPose();
    pose.shoulder = { x: pose.neck.x - 13, y: pose.neck.y };
    expect(validateSketchLandmarks(pose).join()).toMatch(/颈部和左肩距离太近/);
    expect(() => buildSketchSpec(pose, { headR: 0.115, thickness: 1 })).toThrow(/颈部和左肩距离太近/);
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

  it('新建手绘人物默认使用自然暖调肤色，不继承空白主题的蓝灰色', () => {
    const before = useThemeStore.getState();
    expect(before.skin).toBe('#d0a080');
    expect(before.cloth).toBe('#607979');
    const actor = buildSketchCharacter(stdPose(), { headR: 0.115, thickness: 1 });
    try {
      const skinMeshes: THREE.SkinnedMesh[] = [];
      actor.scene.traverse((object) => {
        const mesh = object as THREE.SkinnedMesh;
        if (mesh.isSkinnedMesh && mesh.userData['themePart'] === 'skin') skinMeshes.push(mesh);
      });
      expect(skinMeshes.length).toBeGreaterThan(0);
      expect((skinMeshes[0].material as THREE.MeshStandardMaterial).color.getHexString()).toBe('d0a080');
    } finally {
      actor.dispose();
    }
  });
});
