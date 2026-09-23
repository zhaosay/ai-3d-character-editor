import { describe, expect, it, beforeEach } from 'vitest';
import * as THREE from 'three';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { MockMotionProvider } from '../src/services/motion/MockMotionProvider';
import { sampleAnimation } from '../src/core/animation/sampler';
import { applySampledPose, captureBoneLocal, setBoneLocal } from '../src/core/animation/applyPose';
import { useAnimationStore } from '../src/stores/animationStore';
import { useCharacterStore } from '../src/stores/characterStore';
import { useHistoryStore } from '../src/stores/historyStore';
import { useSkeletonStore } from '../src/stores/skeletonStore';
import type { CharacterMeta } from '../src/types/global';

const META = { id: 'c', fileName: 't.glb', fileSize: 1, gltfInfo: { meshes: 1, materials: 1, bones: 17, hasSkin: true, hasAnimations: 0 } } as CharacterMeta;

beforeEach(() => {
  useCharacterStore.getState().clear();
  useSkeletonStore.getState().setSnapshot(null);
  useAnimationStore.setState({ animations: [], activeId: null, currentTime: 0, playing: false, loop: true });
  useHistoryStore.getState().clear();
});

const worldQuat = (g: THREE.Group, name: string) => {
  const b = g.getObjectByProperty('name', name) as THREE.Bone;
  return b.quaternion.clone();
};

describe('复现：生成→播放→打关键帧', () => {
  it('MotionPanel 完整写入序列后，采样能驱动骨骼', async () => {
    const demo = buildDemoCharacter('male');
    useCharacterStore.getState().setCharacter(META, demo.scene);
    const snap = buildSkeletonTree(demo.scene);
    useSkeletonStore.getState().setSnapshot(snap);

    // === MotionPanel.generate 原样 ===
    const mock = new MockMotionProvider();
    const result = await mock.generateMotion({ prompt: '挥手', skeleton: snap, duration: 4, fps: 30 });
    expect(result.animation.tracks.length).toBeGreaterThan(0);
    const id = useAnimationStore.getState().createAnimation(result.animation.name);
    useAnimationStore.setState((s) => {
      const anims = structuredClone(s.animations);
      const a = anims.find((x) => x.id === id);
      if (a) {
        a.duration = result.animation.duration;
        a.fps = result.animation.fps;
        a.tracks = structuredClone(result.animation.tracks);
      }
      return { animations: anims, activeId: id, currentTime: 0 };
    });

    const st = useAnimationStore.getState();
    const active = st.active();
    expect(active?.tracks.length).toBeGreaterThan(0);

    // === 播放帧：sample + apply ===
    const before = worldQuat(demo.scene, 'UpperArm_R').clone();
    const pose = sampleAnimation(active!, 1);
    expect(pose.size).toBeGreaterThan(0);
    const missing = applySampledPose(demo.scene, pose);
    expect(missing).toEqual([]);
    const after = worldQuat(demo.scene, 'UpperArm_R');
    expect(after.angleTo(before)).toBeGreaterThan(0.05);
    demo.dispose();
  });

  it('TransformPanel 打关键帧序列写入轨道', () => {
    const demo = buildDemoCharacter('male');
    useCharacterStore.getState().setCharacter(META, demo.scene);
    useAnimationStore.getState().createAnimation('T');
    // setAxis 等价：改欧拉 → setBoneLocal
    const e = new THREE.Euler(0.5, 0, 0, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(e);
    expect(setBoneLocal(demo.scene, 'UpperArm_R', { quaternion: [q.x, q.y, q.z, q.w] })).toBe(true);
    // addKey 等价：capture → upsert
    const cap = captureBoneLocal(demo.scene, 'UpperArm_R')!;
    useAnimationStore.getState().upsertRotationKey('UpperArm_R', 0.5, cap.quaternion, 'linear');
    const track = useAnimationStore.getState().active()?.tracks.find((t) => t.boneName === 'UpperArm_R');
    expect(track?.rotation.length).toBe(1);
    expect(track?.rotation[0].time).toBe(0.5);
    demo.dispose();
  });
});
