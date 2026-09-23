import { describe, expect, it } from 'vitest';
import { sampleQuatTrack, sampleVec3Track, sampleAnimation } from '../src/core/animation/sampler';
import { createEmptyAnimation } from '../src/core/animation/types';

const Q0: [number, number, number, number] = [0, 0, 0, 1];
const Q90Y: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

describe('sampler', () => {
  it('空轨返回 undefined', () => {
    expect(sampleQuatTrack([], 1)).toBeUndefined();
    expect(sampleVec3Track([], 1)).toBeUndefined();
  });

  it('单关键帧恒定', () => {
    expect(sampleQuatTrack([{ time: 1, value: Q0, interp: 'linear' }], 5)).toEqual(Q0);
  });

  it('linear 中点 slerp 近似 45°', () => {
    const q = sampleQuatTrack(
      [
        { time: 0, value: Q0, interp: 'linear' },
        { time: 2, value: Q90Y, interp: 'linear' },
      ],
      1,
    )!;
    // 45°绕Y: (0, sin22.5°, 0, cos22.5°)
    expect(q[1]).toBeCloseTo(Math.sin(Math.PI / 8), 3);
    expect(q[3]).toBeCloseTo(Math.cos(Math.PI / 8), 3);
  });

  it('step 保持前一帧', () => {
    const q = sampleQuatTrack(
      [
        { time: 0, value: Q0, interp: 'step' },
        { time: 2, value: Q90Y, interp: 'linear' },
      ],
      1.9,
    )!;
    expect(q).toEqual(Q0);
  });

  it('cubic 抛 NOT_IMPLEMENTED', () => {
    expect(() =>
      sampleQuatTrack(
        [
          { time: 0, value: Q0, interp: 'cubic' },
          { time: 2, value: Q90Y, interp: 'cubic' },
        ],
        1,
      ),
    ).toThrow(/NOT_IMPLEMENTED/);
  });

  it('sampleAnimation 按骨骼聚合', () => {
    const a = createEmptyAnimation('t', 30, 4);
    a.tracks.push({ boneName: 'Hips', position: [], rotation: [{ time: 0, value: Q0, interp: 'linear' }], scale: [] });
    const pose = sampleAnimation(a, 2);
    expect(pose.get('Hips')?.quaternion).toEqual(Q0);
    expect(pose.has('Spine')).toBe(false);
  });
});
