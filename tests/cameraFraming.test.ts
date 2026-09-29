import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { inspectCameraSubjectFraming } from '../src/core/previs/cameraFraming';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import type { AnimationData } from '../src/core/animation/types';

describe('camera subject framing', () => {
  it('warns when the animated body proxy leaves frame and restores the editor pose', () => {
    const demo = buildDemoCharacter('male');
    const hips = demo.scene.getObjectByName('Hips') as THREE.Bone;
    hips.position.y += 0.2;
    demo.scene.updateWorldMatrix(true, true);
    const before = hips.position.clone();
    const animation: AnimationData = { id: 'framing', name: 'framing', duration: 2, fps: 30, tracks: [
      { boneName: 'Hips', position: [
        { time: 0, value: [0, 1.02, 0] }, { time: 2, value: [8, 1.02, 0] },
      ], rotation: [], scale: [] },
    ] };
    const cameraTrack = [
      { time: 0, position: [0, 1, 4] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 45 },
      { time: 2, position: [0, 1, 4] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 45 },
    ];

    const warnings = inspectCameraSubjectFraming(demo.scene, animation, cameraTrack);

    expect(warnings.some((warning) => /超出画面右侧/.test(warning))).toBe(true);
    expect(hips.position.distanceTo(before)).toBeLessThan(1e-8);
    expect(inspectCameraSubjectFraming(demo.scene,
      { ...animation, tracks: [{ ...animation.tracks[0], position: [{ time: 0, value: [0, 1.02, 0] }, { time: 2, value: [0, 1.02, 0] }] }] },
      cameraTrack)).toEqual([]);
    demo.dispose();
  });
});
