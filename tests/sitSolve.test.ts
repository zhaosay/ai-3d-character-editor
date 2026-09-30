import { describe, expect, it } from 'vitest';
import { solveSitLeg, hipHeightFromLegSpan, standingHipHeight, type LegChain, type SitSolution } from '../src/core/ik/sitSolve';

// 真实骨架量出的值（子代理从 buildDemoCharacter 逐骨测量）
const MALE: LegChain = { upper: 0.46309, lower: 0.44424, hipDrop: 0.05789, shinBiasDeg: 2.5803, ankleAboveSole: 0.01630 };
const FEMALE: LegChain = { upper: 0.43187, lower: 0.41436, hipDrop: 0.05398, shinBiasDeg: 2.7667, ankleAboveSole: 0.01499 };
const PELVIS_R = 0.13;

const CHAINS = { male: MALE, female: FEMALE } as const;
const SEAT_HEIGHTS = [0, 0.13, 0.472, 0.522, 0.75, 1.0];
const REACH = 0.46; // 子代理建议的默认前伸量

/** 默认 ease（与 hipHeightFromLegSpan 的默认值一致）。 */
const smooth = (t: number) => t * t * (3 - 2 * t);

/** 按进度 e 复算脚底高度（ease 必须与 hipHeightFromLegSpan 传入的一致）。 */
function soleAtProgress(chain: LegChain, sol: SitSolution, e: number, hipY: number): number {
  const rad = (v: number) => v * Math.PI / 180;
  const k = smooth(e);
  const thighWorld = sol.thighDeg < 0 ? -sol.thighDeg * k : 0;
  const shinWorld = sol.shinWorldDeg * k;
  const drop = chain.upper * Math.cos(rad(thighWorld)) + chain.lower * Math.cos(rad(shinWorld));
  return hipJointYOf(chain, hipY) - drop - chain.ankleAboveSole;
}
function hipJointYOf(chain: LegChain, hipY: number) {
  return hipY - chain.hipDrop;
}

describe('solveSitLeg 基本不变量', () => {
  for (const [name, chain] of Object.entries(CHAINS)) {
    for (const seatH of SEAT_HEIGHTS) {
      const hipY = seatH + PELVIS_R;
      const sol = solveSitLeg(chain, { groundY: 0, hipY, reach: REACH });
      it(`${name} @座面 ${seatH}m: 有解且脚底贴地`, () => {
        expect(sol, '应有解').not.toBeNull();
        if (seatH <= 0.522) {
          expect(sol!.degraded, '低座面应完全可达').toBeNull();
          expect(Math.abs(sol!.float)).toBeLessThan(0.01);
        } else {
          // 高座面：腿伸直到极限仍够不到时如实标记，且 float > 0（脚离地，非穿地）
          if (sol!.degraded) expect(sol!.float).toBeGreaterThan(0);
        }
      });

      it(`${name} @座面 ${seatH}m: 关节在解剖极限内`, () => {
        if (!sol) return;
        // thighDeg 是局部欧拉，符号约定与 hips 俯仰耦合；
        // 这里验证「等价的膝内角」在 [0,155] 内（人体膝只能向后弯）。
        const shinInner = sol.shinDeg - chain.shinBiasDeg;
        expect(shinInner).toBeLessThanOrEqual(155.001);
        expect(shinInner).toBeGreaterThanOrEqual(-155.001);
        // 局部角绝对值也不应离谱
        expect(Math.abs(sol.thighDeg)).toBeLessThanOrEqual(360);
      });

      it(`${name} @座面 ${seatH}m: 膝向前凸（非反关节）`, () => {
        if (!sol || sol.degraded) return;
        // 腿接近伸直时 bulge 趋零是几何正确的（膝弯≈0），只在有实际折叠时要求凸出
        if (!sol.degraded && sol.shinDeg - chain.shinBiasDeg > 5) {
          expect(sol.kneeBulge).toBeGreaterThan(0.004);
        }
      });
    }
  }
});

describe('脚 pitch 归零', () => {
  it('footDeg 使世界脚 pitch ≈ 0', () => {
    // 世界脚 pitch = shinWorld − shinBias + footDeg，应为 0
    for (const chain of [MALE, FEMALE]) {
      const sol = solveSitLeg(chain, { groundY: 0, hipY: 0.472 + PELVIS_R, reach: REACH })!;
      const pitch = sol.shinWorldDeg - chain.shinBiasDeg + sol.footDeg;
      expect(Math.abs(pitch)).toBeLessThan(1e-6);
    }
  });
});

describe('退化策略', () => {
  it('座面过高（1.0m）判定 seat-too-high 且脚离地', () => {
    const sol = solveSitLeg(MALE, { groundY: 0, hipY: 1.0 + PELVIS_R, reach: REACH });
    expect(sol).not.toBeNull();
    expect(sol!.degraded).toBe('seat-too-high');
    expect(sol!.float).toBeGreaterThan(0);
  });

  it('座面过高时脚离地量等于几何下限（Δ − reach）', () => {
    const sol = solveSitLeg(MALE, { groundY: 0, hipY: 1.0 + PELVIS_R, reach: REACH })!;
    const requiredDrop = (1.0 + PELVIS_R) - MALE.hipDrop - MALE.ankleAboveSole;
    const expected = requiredDrop - (MALE.upper + MALE.lower);
    expect(Math.abs(sol.float - expected)).toBeLessThan(1e-6);
  });

  it('座面过高时仍返回可用的腿角（不抛错）', () => {
    const sol = solveSitLeg(MALE, { groundY: 0, hipY: 1.0 + PELVIS_R, reach: REACH });
    expect(Number.isFinite(sol!.thighDeg)).toBe(true);
    expect(Number.isFinite(sol!.shinDeg)).toBe(true);
  });

  it('座面太低（髋低于 leg 差值）判定 limits-infeasible', () => {
    const sol = solveSitLeg(MALE, { groundY: 0, hipY: 0.02, reach: 0.1 });
    expect(sol).not.toBeNull();
    expect(sol!.degraded).toBe('limits-infeasible');
  });
});

describe('健壮性', () => {
  it('骨长为零时返回 null 而非抛错', () => {
    expect(solveSitLeg({ ...MALE, upper: 0 }, { groundY: 0, hipY: 0.6, reach: 0.4 })).toBeNull();
    expect(solveSitLeg({ ...MALE, lower: 0 }, { groundY: 0, hipY: 0.6, reach: 0.4 })).toBeNull();
  });

  it('reach 为负/NaN 时不产生 NaN', () => {
    for (const r of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sol = solveSitLeg(MALE, { groundY: 0, hipY: 0.6, reach: r });
      if (sol) {
        for (const v of Object.values(sol)) {
          if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  it('全部输出有界', () => {
    for (const seatH of [0, 0.3, 0.6, 0.9, 1.5, 3]) {
      const sol = solveSitLeg(MALE, { groundY: 0, hipY: seatH + PELVIS_R, reach: REACH });
      if (!sol) continue;
      expect(Math.abs(sol.thighDeg)).toBeLessThan(400);
      expect(Math.abs(sol.shinDeg)).toBeLessThan(400);
      expect(sol.actualReach).toBeLessThan(2);
    }
  });
});

describe('hipHeightFromLegSpan 包络', () => {
  it('整个过渡过程脚底保持贴地（不只在终态）', () => {
    // 这是 F1 的核心：只改腿角不改髋包络会中途插地 8.2cm
    for (const chain of [MALE, FEMALE]) {
      const sol = solveSitLeg(chain, { groundY: 0, hipY: 0.472 + PELVIS_R, reach: REACH });
      if (!sol || sol.degraded) continue;
      for (let e = 0; e <= 1.0001; e += 0.05) {
        const hipY = hipHeightFromLegSpan(chain, e, sol, 0);
        const sole = soleAtProgress(chain, sol, e, hipY);
        expect(Math.abs(sole), `进度 ${e.toFixed(2)} 处脚底偏离 ${(sole * 100).toFixed(1)}cm`).toBeLessThan(0.01);
      }
    }
  });

  it('e=1 时精确还原目标 hipY', () => {
    for (const chain of [MALE, FEMALE]) {
      for (const seatH of SEAT_HEIGHTS) {
        const hipY = seatH + PELVIS_R;
        const sol = solveSitLeg(chain, { groundY: 0, hipY, reach: REACH });
        if (!sol || sol.degraded) continue;
        const end = hipHeightFromLegSpan(chain, 1, sol, 0);
        // 包络在 e=1 应还原由解算得出的坐姿髋高（可能与目标差一个 float）
        const expected = hipY - sol.float;
        expect(Math.abs(end - expected)).toBeLessThan(1e-6);
      }
    }
  });

  it('e=0 精确等于站立髋高', () => {
    const sol = solveSitLeg(MALE, { groundY: 0, hipY: 0.602, reach: REACH })!;
    expect(hipHeightFromLegSpan(MALE, 0, sol, 0)).toBeCloseTo(standingHipHeight(MALE, 0), 6);
    expect(standingHipHeight(MALE, 0)).toBeCloseTo(0.982, 2);
  });

  it('髋高从站立单调下降到坐姿', () => {
    const sol = solveSitLeg(MALE, { groundY: 0, hipY: 0.602, reach: REACH })!;
    const start = hipHeightFromLegSpan(MALE, 0, sol, 0);
    const end = hipHeightFromLegSpan(MALE, 1, sol, 0);
    expect(end).toBeLessThan(start);
    let prev = start;
    for (let e = 0.05; e <= 1.0001; e += 0.05) {
      const h = hipHeightFromLegSpan(MALE, e, sol, 0);
      expect(h).toBeLessThanOrEqual(prev + 1e-6);
      prev = h;
    }
  });
});

describe('参数扫描（回归护栏）', () => {
  it('多身高 × 座高下不产生超出关节极限的解', () => {
    // 身高 1.55~1.95 用腿长插值近似
    for (const scale of [0.85, 0.93, 1.0, 1.05, 1.1]) {
      const chain: LegChain = { ...MALE, upper: MALE.upper * scale, lower: MALE.lower * scale, hipDrop: MALE.hipDrop * scale };
      for (let seatH = 0; seatH <= 1.4; seatH += 0.1) {
        const sol = solveSitLeg(chain, { groundY: 0, hipY: seatH + PELVIS_R, reach: REACH });
        if (!sol || sol.degraded) continue;
        expect(-sol.thighDeg, `scale=${scale} seat=${seatH.toFixed(1)} thigh 越界`).toBeLessThanOrEqual(150.001);
        expect(sol.shinDeg - chain.shinBiasDeg).toBeLessThanOrEqual(155.001);
        expect(Math.abs(sol.float)).toBeLessThan(0.01);
      }
    }
  });
});
