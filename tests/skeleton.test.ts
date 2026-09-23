import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { guessSemantic } from '../src/core/skeleton/humanoidMap';

function makeChain(): THREE.Group {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  hips.position.set(0, 1, 0);
  const spine = new THREE.Bone();
  spine.name = 'Spine';
  spine.position.set(0, 0.2, 0);
  const head = new THREE.Bone();
  head.name = 'Head';
  head.position.set(0, 0.5, 0);
  root.add(hips);
  hips.add(spine);
  spine.add(head);
  return root;
}

describe('buildSkeletonTree', () => {
  it('解析父子层级与roots', () => {
    const snap = buildSkeletonTree(makeChain());
    expect(snap.boneCount).toBe(3);
    expect(snap.roots.length).toBe(1);
    const hips = Object.values(snap.nodes).find((n) => n.name === 'Hips')!;
    const spine = Object.values(snap.nodes).find((n) => n.name === 'Spine')!;
    const head = Object.values(snap.nodes).find((n) => n.name === 'Head')!;
    expect(spine.parent).toBe(hips.id);
    expect(head.parent).toBe(spine.id);
    expect(hips.children).toContain(spine.id);
    expect(head.isEndSite).toBe(true);
    expect(hips.isEndSite).toBe(false);
    expect(head.depth).toBe(2);
  });

  it('restLocal 为加载时快照（不受后续修改影响）', () => {
    const root = makeChain();
    const snap = buildSkeletonTree(root);
    const spine = Object.values(snap.nodes).find((n) => n.name === 'Spine')!;
    expect(spine.restLocal.position).toEqual([0, 0.2, 0]);
  });

  it('无骨骼场景返回空快照', () => {
    const snap = buildSkeletonTree(new THREE.Group());
    expect(snap.boneCount).toBe(0);
    expect(snap.roots).toEqual([]);
  });
});

describe('humanoidMap', () => {
  it('常识命名可映射', () => {
    expect(guessSemantic('Hips')).toBe('hips');
    expect(guessSemantic('LeftHand')).toBe('hand.L');
    expect(guessSemantic('RightFoot')).toBe('foot.R');
    expect(guessSemantic('mixamorigLeftArm')).toBe('upperArm.L');
    expect(guessSemantic('mixamorig:Hips')).toBe('hips');
  });

  it('未知命名返回null', () => {
    expect(guessSemantic('SomeProp_Bone_01')).toBeNull();
  });

  it('CesiumMan 命名精确映射（含左右）', () => {
    expect(guessSemantic('Skeleton_torso_joint_1')).toBe('hips');
    expect(guessSemantic('Skeleton_torso_joint_2')).toBe('spine');
    expect(guessSemantic('torso_joint_3')).toBe('chest');
    expect(guessSemantic('Skeleton_neck_joint_1')).toBe('neck');
    expect(guessSemantic('Skeleton_neck_joint_2')).toBe('head');
    expect(guessSemantic('leg_joint_L_1')).toBe('thigh.L');
    expect(guessSemantic('leg_joint_R_1')).toBe('thigh.R');
    expect(guessSemantic('leg_joint_L_2')).toBe('shin.L');
    expect(guessSemantic('leg_joint_R_2')).toBe('shin.R');
    expect(guessSemantic('leg_joint_L_3')).toBe('foot.L');
    expect(guessSemantic('leg_joint_R_3')).toBe('foot.R');
    expect(guessSemantic('leg_joint_R_5')).toBeNull(); // 脚趾： intentionally unmapped
    expect(guessSemantic('Skeleton_arm_joint_R')).toBe('upperArm.R');
    expect(guessSemantic('Skeleton_arm_joint_L__4_')).toBe('upperArm.L');
    expect(guessSemantic('Skeleton_arm_joint_R__2_')).toBe('forearm.R');
    expect(guessSemantic('Skeleton_arm_joint_L__3_')).toBe('forearm.L');
    expect(guessSemantic('Skeleton_arm_joint_R__3_')).toBe('hand.R');
    expect(guessSemantic('Skeleton_arm_joint_L__2_')).toBe('hand.L');
  });

  it('CesiumMan 规则不误伤既有命名', () => {
    expect(guessSemantic('mixamorigLeftArm')).toBe('upperArm.L');
    expect(guessSemantic('mixamorig:RightLeg')).toBe('shin.R');
    expect(guessSemantic('Hips')).toBe('hips');
  });
});
