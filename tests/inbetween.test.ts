import { describe, expect, it } from 'vitest';
import { createEmptyAnimation } from '../src/core/animation/types';
import { inbetweenKeys, interpolatePairValue } from '../src/core/inbetween/inbetween';
import { runInbetweenOnAnimation } from '../src/core/inbetween/runInbetween';
import type { Keyframe } from '../src/core/animation/types';

const Q0: [number, number, number, number] = [0, 0, 0, 1];
const Q90Y: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

describe('interpolatePairValue', () => {
  it('quat slerp 中点 (45°绕Y)', () => {
    const a = { time: 0, value: Q0, interp: 'linear' } as Keyframe<unknown>;
    const b = { time: 2, value: Q90Y, interp: 'linear' } as Keyframe<unknown>;
    const v = interpolatePairValue(a, b, 1, 'linear') as number[];
    expect(v[1]).toBeCloseTo(Math.sin(Math.PI / 8), 3);
    expect(v[3]).toBeCloseTo(Math.cos(Math.PI / 8), 3);
  });

  it('标量 lerp 直线 + ease 改变曲线', () => {
    const a = { time: 0, value: 0, interp: 'linear' } as Keyframe<unknown>;
    const b = { time: 1, value: 1, interp: 'linear' } as Keyframe<unknown>;
    expect(interpolatePairValue(a, b, 0.5, 'linear')).toBeCloseTo(0.5, 5);
    expect(interpolatePairValue(a, b, 0.5, 'easeIn')).toBeCloseTo(0.25, 5);
    expect(interpolatePairValue(a, b, 0.5, 'easeOut')).toBeCloseTo(0.75, 5);
  });

  it('step 模式保持起点', () => {
    const a = { time: 0, value: 0, interp: 'linear' } as Keyframe<unknown>;
    const b = { time: 1, value: 1, interp: 'step' } as Keyframe<unknown>;
    expect(interpolatePairValue(a, b, 0.9, 'linear')).toBe(0);
  });

  it('向量逐分量 lerp', () => {
    const a = { time: 0, value: [0, 0, 0], interp: 'linear' } as Keyframe<unknown>;
    const b = { time: 2, value: [10, 20, 30], interp: 'linear' } as Keyframe<unknown>;
    const v = interpolatePairValue(a, b, 1, 'linear') as number[];
    expect(v).toEqual([5, 10, 15]);
  });
});

describe('inbetweenKeys', () => {
  it('区间均匀补帧 + 边界外不插入', () => {
    const ks = [
      { time: 0, value: 0, interp: 'linear' },
      { time: 2, value: 4, interp: 'linear' },
      { time: 4, value: 8, interp: 'linear' },
    ];
    const out = inbetweenKeys({ keys: ks, density: 4, minTime: 0, maxTime: 4, ease: 'linear' });
    // 4 keys/s × 4s = 16 → 每区间 ≈ 7 内部 key；长度约 16
    expect(out.length).toBeGreaterThan(ks.length);
    // 首尾保留
    expect(out[0].time).toBe(0);
    expect(out[out.length - 1].time).toBe(4);
    // 单调
    for (let i = 1; i < out.length; i++) expect(out[i].time).toBeGreaterThanOrEqual(out[i - 1].time);
  });

  it('区间裁切 [min,max] 外不变', () => {
    const ks = [
      { time: 0, value: 0, interp: 'linear' },
      { time: 2, value: 4, interp: 'linear' },
      { time: 4, value: 8, interp: 'linear' },
    ];
    const out = inbetweenKeys({ keys: ks, density: 10, minTime: 1, maxTime: 3, ease: 'linear' });
    // 仅 [1,3] 内插入
    for (const k of out) expect(k.time).toBeGreaterThanOrEqual(0) && expect(k.time).toBeLessThanOrEqual(4);
  });
});

describe('runInbetweenOnAnimation', () => {
  it('整段补帧返回动画 + addedKeys', () => {
    const a = createEmptyAnimation('A', 30, 2);
    a.tracks.push({ boneName: 'H', position: [], rotation: [{ time: 0, value: Q0, interp: 'linear' }, { time: 2, value: Q90Y, interp: 'linear' }], scale: [] });
    const r = runInbetweenOnAnimation({ animation: a, minTime: 0, maxTime: 2, density: 10, ease: 'linear' });
    expect(r.addedKeys).toBeGreaterThan(0);
    expect(r.animation.tracks[0].rotation.length).toBe(a.tracks[0].rotation.length + r.addedKeys);
  });
});
