import { describe, expect, it, beforeEach } from 'vitest';
import * as THREE from 'three';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { detectIKChains } from '../src/core/ik/chains';
import type { IKChainDef, IKChainId } from '../src/core/ik/types';
import {
  applyAutoposeLive,
  clampAutoPoseParams,
  resolveTorsoBones,
} from '../src/core/autoposing/autopose';
import { useAnimationStore } from '../src/stores/animationStore';
import { useHistoryStore } from '../src/stores/historyStore';

function bone(parent: THREE.Object3D, name: string, pos: [number, number, number]): THREE.Bone {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(...pos);
  parent.add(b);
  return b;
}

function humanoid() {
  const g = new THREE.Group();
  const hips = bone(g, 'Hips', [0, 1, 0]);
  const spine = bone(hips, 'Spine', [0, 0.2, 0]);
  bone(spine, 'Chest', [0, 0.25, 0]);
  for (const s of ['L', 'R'] as const) {
    const th = bone(hips, `Thigh_${s}`, [s === 'L' ? 0.1 : -0.1, -0.1, 0]);
    const sh = bone(th, `Shin_${s}`, [0, -0.4, 0]);
    bone(sh, `Foot_${s}`, [0, -0.4, 0.05]);
  }
  g.updateWorldMatrix(true, true);
  return g;
}

function chainsOf(g: THREE.Group) {
  const snap = buildSkeletonTree(g);
  const defs = detectIKChains(snap);
  const chains = {} as Record<IKChainId, { def: IKChainDef; polePoint: [number, number, number] } | undefined>;
  for (const d of defs) chains[d.id] = { def: d, polePoint: [...d.defaultPolePoint] as [number, number, number] };
  return { snap, chains };
}

const worldY = (g: THREE.Group, name: string) => {
  const b = g.getObjectByProperty('name', name) as THREE.Bone;
  const v = new THREE.Vector3();
  b.getWorldPosition(v);
  return v.y;
};

describe('autopose core', () => {
  it('参数钳制到安全范围', () => {
    const c = clampAutoPoseParams({ hipsDrop: -99, leanXDeg: 99, leanZDeg: -99, pinFeet: true, pinHands: false });
    expect(c.hipsDrop).toBe(-0.5);
    expect(c.leanXDeg).toBe(30);
    expect(c.leanZDeg).toBe(-20);
  });

  it('解析躯干骨骼', () => {
    const g = humanoid();
    const t = resolveTorsoBones(buildSkeletonTree(g));
    expect(t.hips).toBe('Hips');
    expect(t.spine).toBe('Spine');
    expect(t.chest).toBe('Chest');
  });

  it('下压髋部 + 双脚钉住（可达，无警告）', () => {
    const g = humanoid();
    const { snap, chains } = chainsOf(g);
    const footBefore = worldY(g, 'Foot_L');
    const r = applyAutoposeLive(g, snap, chains, {
      hipsDrop: -0.2, leanXDeg: 0, leanZDeg: 0, pinFeet: true, pinHands: false,
    });
    expect(worldY(g, 'Hips')).toBeCloseTo(0.8, 4);
    expect(worldY(g, 'Foot_L')).toBeCloseTo(footBefore, 3);
    expect(worldY(g, 'Foot_R')).toBeCloseTo(footBefore, 3);
    expect(r.warnings).toEqual([]);
    expect(r.adjusted).toContain('Hips');
    expect(r.adjusted).toContain('Thigh_L');
  });

  it('前倾旋转脊柱', () => {
    const g = humanoid();
    const { snap, chains } = chainsOf(g);
    const before = (g.getObjectByProperty('name', 'Spine') as THREE.Bone).quaternion.clone();
    const r = applyAutoposeLive(g, snap, chains, {
      hipsDrop: 0, leanXDeg: 15, leanZDeg: 0, pinFeet: false, pinHands: false,
    });
    const after = (g.getObjectByProperty('name', 'Spine') as THREE.Bone).quaternion;
    expect(after.angleTo(before)).toBeGreaterThan(0.2);
    expect(r.adjusted).toContain('Spine');
    expect(r.adjusted).toContain('Chest');
  });

  it('超限输入钳制并警告', () => {
    const g = humanoid();
    const { snap, chains } = chainsOf(g);
    const r = applyAutoposeLive(g, snap, chains, {
      hipsDrop: -99, leanXDeg: 0, leanZDeg: 0, pinFeet: false, pinHands: false,
    });
    expect(r.warnings.join()).toMatch(/钳制/);
    expect(worldY(g, 'Hips')).toBeCloseTo(0.5, 4);
  });

  it('无 hips 快照明确不可用', () => {
    const g = new THREE.Group();
    bone(g, 'Prop', [0, 1, 0]);
    g.updateWorldMatrix(true, true);
    const snap = buildSkeletonTree(g);
    const r = applyAutoposeLive(g, snap, {} as never, {
      hipsDrop: -0.1, leanXDeg: 0, leanZDeg: 0, pinFeet: true, pinHands: false,
    });
    expect(r.adjusted).toEqual([]);
    expect(r.warnings.join()).toMatch(/hips/);
  });
});

describe('bakePoseKeys', () => {
  beforeEach(() => {
    useAnimationStore.setState({ animations: [], activeId: null, currentTime: 0, playing: false, loop: true });
    useHistoryStore.getState().clear();
  });

  it('rotation + position 单次 push，可一次撤销', () => {
    useAnimationStore.getState().createAnimation('T');
    const pastBefore = useHistoryStore.getState().past.length;
    useAnimationStore.getState().bakePoseKeys(
      [{ boneName: 'Hips', time: 1, value: [0, 0, 0, 1] }],
      [{ boneName: 'Hips', time: 1, value: [0, 0.8, 0] }],
    );
    expect(useHistoryStore.getState().past.length).toBe(pastBefore + 1);
    const track = useAnimationStore.getState().active()?.tracks.find((t) => t.boneName === 'Hips');
    expect(track?.rotation.length).toBe(1);
    expect(track?.position.length).toBe(1);
    useAnimationStore.getState().undo();
    expect(useAnimationStore.getState().active()?.tracks.length ?? 0).toBe(0);
  });
});
