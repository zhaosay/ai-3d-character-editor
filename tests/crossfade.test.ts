import { describe, expect, it } from 'vitest';
import { blendFaceWeights, blendPoses, exitTimeProgress, fadeWeight } from '../src/core/animation/crossfade';
import type { SampledPose } from '../src/core/animation/sampler';

const pose = (entries: Array<[string, { quaternion?: number[]; position?: number[]; scale?: number[] }]>): SampledPose => {
  const m: SampledPose = new Map();
  for (const [name, v] of entries) m.set(name, v as never);
  return m;
};

describe('blendPoses', () => {
  it('w=0 完全等于 a，w=1 完全等于 b', () => {
    // 绕 Z 轴 90° = (0, 0, sin45, cos45)
    const a = pose([['Hips', { quaternion: [0, 0, 0, 1] }]]);
    const b = pose([['Hips', { quaternion: [0, 0, 0.70711, 0.70711] }]]);
    expect(blendPoses(a, b, 0).get('Hips')!.quaternion).toEqual([0, 0, 0, 1]);
    const out = blendPoses(a, b, 1).get('Hips')!.quaternion!;
    expect(out[2]).toBeCloseTo(0.70711, 4);
    expect(out[3]).toBeCloseTo(0.70711, 4);
  });

  it('中途是真正的球面插值（不是线性四元数分量）', () => {
    const a = pose([['Hips', { quaternion: [0, 0, 0, 1] }]]);
    const b = pose([['Hips', { quaternion: [0, 1, 0, 0] }]]); // 绕 Y 转 180°
    const mid = blendPoses(a, b, 0.5).get('Hips')!.quaternion!;
    // 90° 应得 (0, sin45, 0, cos45)，且模长为 1
    expect(Math.abs(mid[1] - Math.SQRT1_2)).toBeLessThan(1e-3);
    expect(Math.abs(mid[3] - Math.SQRT1_2)).toBeLessThan(1e-3);
    expect(Math.hypot(...mid)).toBeCloseTo(1, 6);
  });

  it('位置线性插值', () => {
    const a = pose([['Hips', { position: [0, 0, 0] }]]);
    const b = pose([['Hips', { position: [2, 4, 6] }]]);
    expect(blendPoses(a, b, 0.5).get('Hips')!.position).toEqual([1, 2, 3]);
  });

  /**
   * 关键回归：两个 clip 骨骼集合不同时，缺失侧必须用**静息**兜底。
   * 否则「先 A 后 B」会让只属于 A 的骨沿用 A 的旧值，淡化时突然弹回。
   */
  it('骨骼集合不一致时用静息兜底（不会残留来源的旧值）', () => {
    const a = pose([['Head', { quaternion: [0, 0.7, 0, 0.7] }]]);   // 只有头
    const b = pose([['Hips', { quaternion: [0, 0, 0, 1] }]]);        // 只有骨盆
    const rest = new Map([
      ['Head', { quaternion: [0, 0, 0, 1] as [number, number, number, number] }],
      ['Hips', { quaternion: [0, 0, 0, 1] as [number, number, number, number] }],
    ]);
    const blended = blendPoses(a, b, 0.5, rest);
    // 两根骨都在结果里
    expect(blended.has('Head')).toBe(true);
    expect(blended.has('Hips')).toBe(true);
    // w=0.5 时头应从 0.7 转向静息（0）的一半，而不是保持 0.7
    expect(blended.get('Head')!.quaternion![1]).toBeLessThan(0.7);
    // w=0 时头应回到静息（因为 a 里没有头… 不，a 里有，这里验证 a 侧）
    const at0 = blendPoses(a, b, 0, rest);
    expect(at0.get('Head')!.quaternion![1]).toBeCloseTo(0.7, 3);
  });

  it('不给 rest 时：只在自己那侧有的通道照常写入，对侧缺失则不写', () => {
    const a = pose([['Head', { quaternion: [0, 0.5, 0, 0.866] }]]);
    const b = pose([['Hips', { quaternion: [0, 0, 0, 1] }]]);
    const blended = blendPoses(a, b, 0.5);
    // 每根骨在自己那侧有值 → 保留该值（没有兜底就无从混合）
    expect(blended.has('Head')).toBe(true);
    expect(blended.has('Hips')).toBe(true);
    // a 里没有 position → 不该凭空造一个
    expect(blended.get('Head')!.position).toBeUndefined();
  });

  it('w 超出 0..1 被钳制', () => {
    const a = pose([['Hips', { position: [0, 0, 0] }]]);
    const b = pose([['Hips', { position: [10, 0, 0] }]]);
    expect(blendPoses(a, b, -1).get('Hips')!.position![0]).toBe(0);
    expect(blendPoses(a, b, 5).get('Hips')!.position![0]).toBe(10);
  });

  it('空姿态不崩', () => {
    expect(blendPoses(new Map(), new Map(), 0.5).size).toBe(0);
  });
});

describe('blendFaceWeights', () => {
  it('线性插值且缺失侧视为 0', () => {
    const a = new Map([['0/3#smile', 1]]);
    const b = new Map([['0/3#blink', 0.6]]);
    const out = blendFaceWeights(a, b, 0.5);
    expect(out.get('0/3#smile')).toBeCloseTo(0.5, 6);
    expect(out.get('0/3#blink')).toBeCloseTo(0.3, 6);
  });

  it('0 值必须写入（否则上一个动画的表情会残留在脸上）', () => {
    const a = new Map([['k', 1]]);
    const b = new Map([['k', 0]]);
    // 混合到一半：0.5
    expect(blendFaceWeights(a, b, 0.5).get('k')).toBeCloseTo(0.5, 6);
    // 完全到 b：必须是 0（能覆盖掉来源动画的权重）
    expect(blendFaceWeights(a, b, 1).get('k')).toBe(0);
    // 完全在 a：1
    expect(blendFaceWeights(a, b, 0).get('k')).toBe(1);
  });
});

describe('fadeWeight', () => {
  it('smoothstep：两端与中点', () => {
    expect(fadeWeight(0, 0.3)).toBeCloseTo(0, 6);
    expect(fadeWeight(0.3, 0.3)).toBeCloseTo(1, 6);
    expect(fadeWeight(0.15, 0.3)).toBeCloseTo(0.5, 2);
  });

  it('时长为 0 直接到 1（硬切）', () => {
    expect(fadeWeight(0, 0)).toBe(1);
  });

  it('超出时长被钳制', () => {
    expect(fadeWeight(-1, 0.3)).toBe(0);
    expect(fadeWeight(99, 0.3)).toBe(1);
  });
});

describe('exitTimeProgress', () => {
  it('按归一化进度判断（不依赖 clip 绝对时长）', () => {
    expect(exitTimeProgress(0, 4, 0.5)).toBe(false);
    expect(exitTimeProgress(1.9, 4, 0.5)).toBe(false);
    expect(exitTimeProgress(2.0, 4, 0.5)).toBe(true);
    // 不同时长但同一比例 → 同样结果
    expect(exitTimeProgress(1.0, 2, 0.5)).toBe(true);
  });

  it('duration 非正时不算到达', () => {
    expect(exitTimeProgress(1, 0, 0)).toBe(false);
  });
});