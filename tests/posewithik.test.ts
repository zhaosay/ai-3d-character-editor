import { describe, expect, it, beforeEach } from 'vitest';
import * as THREE from 'three';
import { applyPoseWithIK, solvePinsLive } from '../src/core/ik/applyPoseWithIK';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { detectIKChains } from '../src/core/ik/chains';
import { executeAction, clearIdempotencyCache } from '../src/services/agent/toolRegistry';
import { useAnimationStore } from '../src/stores/animationStore';
import { useCharacterStore } from '../src/stores/characterStore';
import { useHistoryStore } from '../src/stores/historyStore';
import { useIKStore } from '../src/stores/ikStore';
import { useSelectionStore } from '../src/stores/selectionStore';
import { useSkeletonStore } from '../src/stores/skeletonStore';
import type { CharacterMeta } from '../src/types/global';

function bone(parent: THREE.Object3D, name: string, x: number, y: number, z = 0): THREE.Bone {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(x, y, z);
  parent.add(b);
  return b;
}

/** 微屈站立，腿有 IK 余量 */
function rig() {
  const g = new THREE.Group();
  const hips = bone(g, 'Hips', 0, 1, 0);
  const th = bone(hips, 'Thigh_L', 0.1, -0.1, 0);
  const sh = bone(th, 'Shin_L', 0, -0.42, 0.15);
  bone(sh, 'Foot_L', 0, -0.4, 0.03);
  g.updateWorldMatrix(true, true);
  return g;
}

const worldOf = (g: THREE.Group, name: string) => {
  const v = new THREE.Vector3();
  (g.getObjectByProperty('name', name) as THREE.Bone).getWorldPosition(v);
  return v;
};

describe('applyPoseWithIK', () => {
  it('FK 下压髋部时钉住脚（无闪回）', () => {
    const g = rig();
    const snap = buildSkeletonTree(g);
    const def = detectIKChains(snap).find((d) => d.id === 'leg.L')!;
    const footBefore = worldOf(g, 'Foot_L').clone();
    const pose = new Map([['Hips', { position: [0, 0.9, 0] as [number, number, number] }]]);
    const solved = applyPoseWithIK(g, pose, [
      { def, target: [footBefore.x, footBefore.y, footBefore.z], polePoint: [...def.defaultPolePoint] },
    ]);
    expect(solved[0].reached).toBe(true);
    expect(worldOf(g, 'Foot_L').distanceTo(footBefore)).toBeLessThan(1e-3);
    expect(worldOf(g, 'Hips').y).toBeCloseTo(0.9, 4);
  });

  it('空 pose 只求解 IK', () => {
    const g = rig();
    const snap = buildSkeletonTree(g);
    const def = detectIKChains(snap).find((d) => d.id === 'leg.L')!;
    const target: [number, number, number] = [0.3, 0.3, 0.2];
    const [s] = solvePinsLive(g, [{ def, target, polePoint: [...def.defaultPolePoint] }]);
    expect(s.reached).toBe(true);
    expect(worldOf(g, 'Foot_L').distanceTo(new THREE.Vector3(...target))).toBeLessThan(1e-3);
  });
});

const META = { id: 'c', fileName: 't.glb', fileSize: 1, gltfInfo: { meshes: 1, materials: 1, bones: 4, hasSkin: true, hasAnimations: 0 } } as CharacterMeta;

beforeEach(() => {
  useCharacterStore.getState().clear();
  useSkeletonStore.getState().setSnapshot(null);
  useSelectionStore.getState().select(null);
  useAnimationStore.setState({ animations: [], activeId: null, currentTime: 0, playing: false, loop: true });
  useHistoryStore.getState().clear();
  useIKStore.getState().clear();
  clearIdempotencyCache();
});

describe('apply_ik 同步求解（Agent 闪烁根治）', () => {
  it('targetDelta 后骨骼立即到位，后续 keyframe 抓到新姿势', async () => {
    const g = rig();
    useCharacterStore.getState().setCharacter(META, g);
    const snap = buildSkeletonTree(g);
    useSkeletonStore.getState().setSnapshot(snap);
    useIKStore.getState().initChains(detectIKChains(snap));

    const y0 = worldOf(g, 'Foot_L').y;
    const r = await executeAction({ tool: 'apply_ik', args: { chain: 'leg.L', enable: true, targetDelta: [0, 0.15, 0] }, idempotencyKey: 'ik-sync-1' });
    expect(r.ok).toBe(true);
    expect((r.data as { reached?: boolean }).reached).toBe(true);
    // 未经过任何帧循环，末端已移动（同步求解）
    expect(worldOf(g, 'Foot_L').y).toBeCloseTo(y0 + 0.15, 2);

    await executeAction({ tool: 'create_animation', args: { name: 'T' }, idempotencyKey: 'ik-sync-2' });
    const k = await executeAction({ tool: 'create_keyframe', args: { bone: 'Thigh_L', time: 0 }, idempotencyKey: 'ik-sync-3' });
    expect(k.ok).toBe(true);
    const track = useAnimationStore.getState().active()?.tracks.find((t) => t.boneName === 'Thigh_L');
    const q = track?.rotation[0].value as [number, number, number, number];
    // 非静息四元数：证明抓到的是求解后姿势，而非 stale
    expect(Math.hypot(q[0], q[1], q[2], 1 - q[3])).toBeGreaterThan(1e-3);
  });

  it('超限目标同步钳制并上报 clamped', async () => {
    const g = rig();
    useCharacterStore.getState().setCharacter(META, g);
    const snap = buildSkeletonTree(g);
    useSkeletonStore.getState().setSnapshot(snap);
    useIKStore.getState().initChains(detectIKChains(snap));
    const r = await executeAction({ tool: 'apply_ik', args: { chain: 'leg.L', enable: true, target: [0, 5, 0] }, idempotencyKey: 'ik-clamp-1' });
    expect(r.ok).toBe(true);
    expect((r.data as { clamped?: boolean }).clamped).toBe(true);
  });
});
