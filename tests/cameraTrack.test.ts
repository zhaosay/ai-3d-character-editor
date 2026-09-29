import { describe, expect, it } from 'vitest';
import { sampleCameraTrack, sanitizeCameraKeyframe } from '../src/core/camera/track';
import { useCameraStore } from '../src/stores/cameraStore';

describe('camera track', () => {
  it('在两个机位之间线性采样位置、注视点和焦距', () => {
    const pose = sampleCameraTrack([
      { time: 0, position: [0, 1, 2], target: [0, 1, 0], fov: 40 },
      { time: 2, position: [2, 3, 4], target: [2, 1, 0], fov: 60 },
    ], 1)!;
    expect(pose.position).toEqual([1, 2, 3]);
    expect(pose.target).toEqual([1, 1, 0]);
    expect(pose.fov).toBe(50);
  });

  it('边界保持首尾机位，非法数据被钳制', () => {
    const keys = [{ time: 1, position: [1, 2, 3] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 45 }];
    expect(sampleCameraTrack(keys, -1)!.position).toEqual([1, 2, 3]);
    expect(sampleCameraTrack(keys, 9)!.position).toEqual([1, 2, 3]);
    expect(sanitizeCameraKeyframe({ time: 99, position: [NaN, 1, 2], target: [0, 0, 0], fov: 999 }, 4)).toMatchObject({ time: 4, fov: 100, position: [2.5, 1, 2] });
  });

  it('同一时间的机位覆盖而非重复', () => {
    useCameraStore.getState().clear();
    useCameraStore.getState().upsertKeyframe({ time: 1, position: [0, 1, 2], target: [0, 1, 0], fov: 40 }, 4);
    useCameraStore.getState().upsertKeyframe({ time: 1, position: [1, 1, 2], target: [0, 1, 0], fov: 50 }, 4);
    expect(useCameraStore.getState().keyframes).toEqual([{ time: 1, position: [1, 1, 2], target: [0, 1, 0], fov: 50 }]);
  });

  it('same-animation reload refreshes camera editing context without treating keyframe edits as a reload', () => {
    const camera = useCameraStore.getState();
    camera.activateAnimation('same-id', { enabled: true, keyframes: [
      { time: 0, position: [0, 1, 3], target: [0, 1, 0], fov: 45 },
    ] });
    const loadedRevision = useCameraStore.getState().activationRevision;
    useCameraStore.getState().upsertKeyframe({ time: 1, position: [1, 1, 3], target: [0, 1, 0], fov: 45 }, 4);
    expect(useCameraStore.getState().activationRevision).toBe(loadedRevision);

    useCameraStore.getState().activateAnimation('same-id', { enabled: true, keyframes: [
      { time: 0, position: [2, 1, 3], target: [0, 1, 0], fov: 50 },
    ] });
    expect(useCameraStore.getState().activationRevision).toBe(loadedRevision + 1);
    expect(useCameraStore.getState().keyframes[0].position).toEqual([2, 1, 3]);
  });
});
