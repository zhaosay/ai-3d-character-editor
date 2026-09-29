import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { toThreeClip } from '../src/core/animation/toThreeClip';
import { createEmptyAnimation } from '../src/core/animation/types';

const Q0: [number, number, number, number] = [0, 0, 0, 1];
const Q1: [number, number, number, number] = [0, 1, 0, 0];

describe('toThreeClip', () => {
  it('rotation keys 转为 QuaternionKeyframeTrack', () => {
    const a = createEmptyAnimation('Take 1', 30, 4);
    a.tracks.push({
      boneName: 'Hips',
      position: [],
      rotation: [
        { time: 0, value: Q0, interp: 'linear' },
        { time: 2, value: Q1, interp: 'linear' },
      ],
      scale: [],
    });
    const { clip, warnings } = toThreeClip(a);
    expect(warnings).toEqual([]);
    expect(clip.name).toBe('Take 1');
    expect(clip.tracks.length).toBe(1);
    const t = clip.tracks[0] as THREE.QuaternionKeyframeTrack;
    expect(t.name).toBe('Hips.quaternion');
    expect(Array.from(t.times)).toEqual([0, 2]);
    expect(Array.from(t.values)).toEqual([...Q0, ...Q1]);
  });

  it('全 step 轨道用离散插值', () => {
    const a = createEmptyAnimation('S', 30, 2);
    a.tracks.push({
      boneName: 'Head',
      position: [],
      rotation: [
        { time: 0, value: Q0, interp: 'step' },
        { time: 1, value: Q1, interp: 'step' },
      ],
      scale: [],
    });
    const { clip } = toThreeClip(a);
    expect(clip.tracks[0].getInterpolation()).toBe(THREE.InterpolateDiscrete);
  });

  it('cubic 轨道被跳过并警告', () => {
    const a = createEmptyAnimation('C', 30, 2);
    a.tracks.push({
      boneName: 'Hips',
      position: [],
      rotation: [{ time: 0, value: Q0, interp: 'cubic' }],
      scale: [],
    });
    const { clip, warnings } = toThreeClip(a);
    expect(clip.tracks.length).toBe(0);
    expect(warnings.length).toBe(1);
  });

  it('clip 经 AnimationMixer 可驱动同名骨骼（导出可播的等价验证）', () => {
    const a = createEmptyAnimation('Play', 30, 2);
    a.tracks.push({
      boneName: 'Arm',
      position: [],
      rotation: [
        { time: 0, value: Q0, interp: 'linear' },
        { time: 2, value: Q1, interp: 'linear' },
      ],
      scale: [],
    });
    const { clip } = toThreeClip(a);
    const root = new THREE.Group();
    const bone = new THREE.Bone();
    bone.name = 'Arm';
    root.add(bone);
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    mixer.update(0);
    expect(bone.quaternion.w).toBeCloseTo(1, 4);
    mixer.update(1); // 中点：绕Y 90°（默认循环，t=2 会绕回起点，故测中点）
    expect(bone.quaternion.w).toBeCloseTo(Math.SQRT1_2, 2);
    expect(bone.quaternion.y).toBeCloseTo(Math.SQRT1_2, 2);
    action.stop();
    mixer.uncacheClip(clip);
  });

  it('表情关键帧转成可播放的 morph influence 轨道', () => {
    const root = new THREE.Group();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const target = geometry.attributes['position'].clone();
    geometry.morphAttributes.position = [target];
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.name = 'Face';
    mesh.updateMorphTargets();
    mesh.morphTargetDictionary = { smile: 0 };
    root.add(mesh);
    const animation = createEmptyAnimation('Smile', 30, 1);
    animation.faceTracks = [{ meshPath: '0', targetName: 'smile', keys: [
      { time: 0, value: 0, interp: 'linear' }, { time: 1, value: 1, interp: 'linear' },
    ] }];
    const { clip, warnings } = toThreeClip(animation, root);
    expect(warnings).toEqual([]);
    expect(clip.tracks.map((track) => track.name)).toEqual(['Face.morphTargetInfluences[smile]']);
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    mixer.update(0.5);
    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0.5);
    action.stop();
    mixer.uncacheClip(clip);
  });
});
