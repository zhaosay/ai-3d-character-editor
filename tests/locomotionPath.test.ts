import { describe, expect, it } from 'vitest';
import {
  arcLengthForProgress,
  arcLengths,
  bowedRoute,
  headingAtArcLength,
  maxPathCurvature,
  MIN_TURN_RADIUS,
  pathLength,
  samplePathAtArcLength,
} from '../src/core/motion/path';
import type { Vec3Tuple } from '../src/types/global';

const STRAIGHT: Vec3Tuple[] = [[0, 0, 0], [0, 0, 4]];
/** 直角弯：先沿 +Z 走 2m，再沿 +X 走 2m */
const CORNER: Vec3Tuple[] = [[0, 0, 0], [0, 0, 2], [2, 0, 2]];

describe('弧长表', () => {
  it('等于逐段累加的三维距离', () => {
    expect(arcLengths(STRAIGHT)).toEqual([0, 4]);
    expect(pathLength(STRAIGHT)).toBe(4);
  });

  it('斜线段按真实三维长度（含高差）', () => {
    const pts: Vec3Tuple[] = [[0, 0, 0], [3, 4, 0]];
    expect(pathLength(pts)).toBeCloseTo(5, 6);
  });

  it('退化输入不崩：单点 / 重复点', () => {
    expect(pathLength([[1, 2, 3]])).toBe(0);
    expect(pathLength([[0, 0, 0], [0, 0, 0]])).toBe(0);
    expect(() => samplePathAtArcLength([], 1)).not.toThrow();
    expect(() => samplePathAtArcLength([[1, 2, 3]], 1)).not.toThrow();
  });
});

describe('按弧长采样', () => {
  it('直线：位置与弧长成正比（匀速）', () => {
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const s = samplePathAtArcLength(STRAIGHT, 4 * frac);
      expect(s.position.z).toBeCloseTo(4 * frac, 6);
      expect(s.arcLength).toBeCloseTo(4 * frac, 6);
    }
  });

  it('直线朝向恒为 0（面朝 +Z），切线为 +Z', () => {
    const s = samplePathAtArcLength(STRAIGHT, 2);
    expect(s.heading).toBeCloseTo(0, 6);
    expect(s.tangent.z).toBeCloseTo(1, 6);
    expect(s.tangent.x).toBeCloseTo(0, 6);
  });

  it('弯前朝向 +Z、弯后朝向 +X（这就是之前完全缺失的「身体跟着转」）', () => {
    expect(headingAtArcLength(CORNER, 1)).toBeCloseTo(0, 6);
    expect(headingAtArcLength(CORNER, 3)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('朝向与切线一致：atan2(tangent.x, tangent.z)', () => {
    const s = samplePathAtArcLength(CORNER, 3);
    expect(Math.atan2(s.tangent.x, s.tangent.z)).toBeCloseTo(s.heading, 9);
  });

  it('朝向只看水平分量：有高差不改变前进方向', () => {
    const uphill: Vec3Tuple[] = [[0, 0, 0], [0, 1.5, 3]];
    const s = samplePathAtArcLength(uphill, 1);
    expect(s.tangent.y).toBe(0);
    expect(s.heading).toBeCloseTo(0, 6);
  });

  it('超出范围被钳制（不外推）', () => {
    expect(samplePathAtArcLength(STRAIGHT, 99).position.z).toBeCloseTo(4, 6);
    expect(samplePathAtArcLength(STRAIGHT, -5).position.z).toBeCloseTo(0, 6);
  });

  it('折线各段不等长时按弧长等速（不产生速度脉动）', () => {
    // 段长 1m 与 9m：等分 progress 必须落在按弧长换算的位置
    const uneven: Vec3Tuple[] = [[0, 0, 0], [0, 0, 1], [0, 0, 10]];
    for (const p of [0.1, 0.3, 0.5, 0.9]) {
      const s = arcLengthForProgress(uneven, p);
      const got = samplePathAtArcLength(uneven, s);
      // 走过的弧长必须严格等于 p × 总长
      expect(got.arcLength).toBeCloseTo(p * 10, 6);
    }
  });
});

describe('bowedRoute：把直线掰成弧线', () => {
  it('bow=0 退化为原直线（两点）', () => {
    const r = bowedRoute([0, 0, 0], [0, 0, 4], 0);
    expect(r).toHaveLength(2);
    expect(r[1]).toEqual([0, 0, 4]);
  });

  it('生成三点，中点在弦的法向偏移 bow×弦长', () => {
    const from: Vec3Tuple = [0, 0, 0];
    const to: Vec3Tuple = [0, 0, 4];
    const bow = 0.15;
    const r = bowedRoute(from, to, bow);
    expect(r).toHaveLength(3);
    const chordMidZ = 2;
    // 弦沿 +Z，法向 = (-1,0,0)（(x,z) → (-z,0,x)）
    expect(r[1][2]).toBeCloseTo(chordMidZ, 6);
    expect(Math.abs(r[1][0])).toBeCloseTo(bow * 4, 6);
  });

  it('优先弯曲侧可指定，且两端点不变', () => {
    const a: Vec3Tuple = [0, 0, 0];
    const b: Vec3Tuple = [0, 0, 4];
    const l = bowedRoute(a, b, 0.12, 1);
    const rr = bowedRoute(a, b, 0.12, -1);
    expect(l[0]).toEqual(a);
    expect(l[2]).toEqual(b);
    expect(rr[0]).toEqual(a);
    expect(Math.sign(l[1][0])).toBe(-Math.sign(rr[1][0]));
  });

  it('退化弦（零长）不崩', () => {
    expect(bowedRoute([1, 2, 3], [1, 2, 3], 0.2)).toEqual([[1, 2, 3], [1, 2, 3]]);
  });

  it('弧线路径全程都有非零朝向变化（核心验收点）', () => {
    const curve = bowedRoute([0, 0, 0], [0, 0, 4], 0.25);
    const L = pathLength(curve);
    const headings = Array.from({ length: 21 }, (_, i) => headingAtArcLength(curve, (L * i) / 20));
    // 进弯先偏（heading 为负），过弯中最接近 0，出弯回正
    expect(Math.min(...headings)).toBeLessThan(-0.1);
    expect(Math.max(...headings)).toBeGreaterThan(0.1);
  });

  it('朝向沿路径连续变化，拐点处不突变（否则就是「机器人拐直角」）', () => {
    // 回归：折线切线分段常量，航点处朝向会跳变。
    const curve = bowedRoute([0, 0, 0], [0, 0, 4], 0.25);
    const L = pathLength(curve);
    const steps = 400;
    let maxJump = 0;
    let prev = headingAtArcLength(curve, 0);
    for (let i = 1; i <= steps; i++) {
      const h = headingAtArcLength(curve, (L * i) / steps);
      maxJump = Math.max(maxJump, Math.abs(h - prev));
      prev = h;
    }
    // 200 步扫过 4.5m，每步约 2cm；平滑后单步偏转应远小于 10°
    expect(maxJump).toBeLessThan((10 * Math.PI) / 180);
  });

  it('smoothRadius=0 时退回分段常量（保留旧的突变行为供对照）', () => {
    const corner: Vec3Tuple[] = [[0, 0, 0], [0, 0, 2], [2, 0, 2]];
    const smoothed = samplePathAtArcLength(corner, 1.99, 0.45).heading;
    const raw = samplePathAtArcLength(corner, 1.99, 0).heading;
    expect(smoothed).toBeGreaterThan(raw + 0.05); // 平滑后已提前偏出弯
  });
});

describe('曲率与可行走性', () => {
  it('直线与两点路径曲率为 0', () => {
    expect(maxPathCurvature(STRAIGHT)).toBe(0);
    expect(maxPathCurvature([[0, 0, 0], [0, 0, 2], [0, 0, 4]])).toBe(0); // 三点共线
  });

  it('直角弯曲率 ≈ 1（半径 1m，可走）', () => {
    const k = maxPathCurvature(CORNER);
    expect(k).toBeGreaterThan(0.5);
    expect(k).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('尖角小半径被判为不可走（半径 < 真人步行极限 0.5m）', () => {
    // 0.2m 边长的直角弯 → 外接圆半径约 0.14m，远小于 0.5m
    const tight: Vec3Tuple[] = [[0, 0, 0], [0, 0, 0.2], [0.2, 0, 0.2]];
    const radius = 1 / maxPathCurvature(tight);
    expect(radius).toBeLessThan(MIN_TURN_RADIUS);
  });

  it('缓弧是可以走的（半径远大于 0.5m）', () => {
    const gentle = bowedRoute([0, 0, 0], [0, 0, 4], 0.05); // 弓高 0.2m/弦长 4m
    expect(1 / maxPathCurvature(gentle)).toBeGreaterThan(MIN_TURN_RADIUS);
  });

  it('退化输入返回 0 不崩', () => {
    expect(maxPathCurvature([])).toBe(0);
    expect(maxPathCurvature([[0, 0, 0]])).toBe(0);
    expect(maxPathCurvature([[0, 0, 0], [0, 0, 0], [0, 0, 0]])).toBe(0);
  });
});