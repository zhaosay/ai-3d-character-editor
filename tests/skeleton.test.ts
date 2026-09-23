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
});
