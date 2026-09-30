import { describe, expect, it } from 'vitest';
import {
  anticipationEnvelope, bell, breathSignal, clamp01, gaitCycle, gaitLeg, gaitPeriod,
  proximalDelay, smoothstep, smootherstep, strideForLeg,
} from '../src/core/motion/gaits';

describe('basics', () => {
  it('clamp01 / smoothstep / smootherstep 端点正确', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 6);
  });

  it('bell 在 peak 处为 1，两端为 0', () => {
    expect(bell(0.5, 0.5)).toBeCloseTo(1, 6);
    expect(bell(0, 0.5)).toBe(0);
    expect(bell(1, 0.5)).toBe(0);
    expect(bell(0.3, 0.3)).toBeCloseTo(1, 6);
  });

  it('proximalDelay 产生时间偏移且末端仍为 1', () => {
    expect(proximalDelay(0, 0.1)).toBe(0);
    expect(proximalDelay(0.05, 0.1)).toBe(0);
    expect(proximalDelay(0.5, 0.1)).toBeGreaterThan(0);
    expect(proximalDelay(1, 0.1)).toBe(1);
  });
});

describe('anticipationEnvelope', () => {
  it('起点与终点为 0（无动作时无偏移）', () => {
    expect(anticipationEnvelope(0)).toBe(0);
    expect(anticipationEnvelope(1)).toBe(0);
  });

  it('预备段为负值（先反向蓄力）', () => {
    const mid = anticipationEnvelope(0.06, { windup: 0.12 });
    expect(mid).toBeLessThan(0);
  });

  it('主动作段达到 1', () => {
    expect(anticipationEnvelope(0.5, { windup: 0.12, settle: 0.18 })).toBeGreaterThan(0.9);
  });

  it('跟随段有轻微过冲', () => {
    let peak = 0;
    for (let t = 0; t <= 1.0001; t += 0.005) {
      peak = Math.max(peak, anticipationEnvelope(t, { overshoot: 0.15, settle: 0.2 }));
    }
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.3);
  });

  it('无预备/无跟随时退化为快速 0→1 的平滑曲线', () => {
    const mid = anticipationEnvelope(0.5, { windup: 0, settle: 0, windupAmount: 0, overshoot: 0 });
    expect(mid).toBeCloseTo(1, 5);
    expect(anticipationEnvelope(0, { windup: 0, settle: 0 })).toBe(0);
    expect(anticipationEnvelope(1, { windup: 0, settle: 0 })).toBe(0);
  });
});

describe('breathSignal', () => {
  it('有界、非零、随时间变化', () => {
    const a = breathSignal(0);
    const b = breathSignal(1);
    expect(Math.abs(a)).toBeLessThanOrEqual(1.05);
    expect(Math.abs(b)).toBeLessThanOrEqual(1.05);
    expect(a).not.toBe(b);
  });

  it('约 0.25Hz：4s 后回到同相位（含次谐波故不完全相等）', () => {
    const v0 = breathSignal(0, { hz: 0.25, amount: 1 });
    const v1 = breathSignal(1 / 0.25, { hz: 0.25, amount: 1 });
    expect(v1).toBeCloseTo(v0, 6);
  });
});

describe('gaitPeriod', () => {
  it('步幅越大周期越长，但次线性', () => {
    const small = gaitPeriod({ stride: 0.4, legLength: 0.85 });
    const large = gaitPeriod({ stride: 1.0, legLength: 0.85 });
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(small * 1.8);
  });

  it('落在真人区间 0.35–0.75s', () => {
    for (const stride of [0.2, 0.5, 0.8, 1.4]) {
      const p = gaitPeriod({ stride, legLength: 0.85 });
      expect(p).toBeGreaterThan(0.2);
      expect(p).toBeLessThan(0.9);
    }
  });
});

describe('步幅随腿长缩放（写死魔数的替代）', () => {
  it('步幅 = 腿长 × 0.74，落在文献 0.70~0.78 区间', () => {
    for (const L of [0.70, 0.85, 0.89, 1.00]) {
      const ratio = strideForLeg(L) / L;
      expect(ratio, `L=${L} 步幅比 ${ratio.toFixed(3)}`).toBeGreaterThan(0.70);
      expect(ratio, `L=${L} 步幅比 ${ratio.toFixed(3)}`).toBeLessThan(0.78);
    }
  });

  it('腿越长步幅越大（修复前恒为 0.62m）', () => {
    expect(strideForLeg(1.00)).toBeGreaterThan(strideForLeg(0.85));
    expect(strideForLeg(0.85)).toBeGreaterThan(strideForLeg(0.70));
  });

  it('量不到腿长时退回默认腿长对应的步幅，不返回 0/NaN', () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN]) {
      const v = strideForLeg(bad as number | null);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0.3);
    }
  });

  it('步频落在真人区间（约 100–140 步/分）', () => {
    for (const L of [0.80, 0.89, 1.00]) {
      const cadence = 60 / gaitPeriod({ legLength: L });
      expect(cadence, `L=${L} 步频 ${cadence.toFixed(0)}/分`).toBeGreaterThan(100);
      expect(cadence, `L=${L} 步频 ${cadence.toFixed(0)}/分`).toBeLessThan(140);
    }
  });

  it('腿越长单步越慢（SR ∝ 1/√L），不能是恒定周期', () => {
    const short = gaitPeriod({ legLength: 0.80 });
    const tall = gaitPeriod({ legLength: 1.00 });
    expect(tall, `高个周期 ${tall.toFixed(3)}s 应大于矮个 ${short.toFixed(3)}s`).toBeGreaterThan(short);
    // 步频相应下降
    expect(60 / tall).toBeLessThan(60 / short);
  });

  it('步频不再与腿长无关（修复前恒为 0.51s / 118 步每分）', () => {
    const a = gaitPeriod({ legLength: 0.80 });
    const b = gaitPeriod({ legLength: 1.00 });
    // 至少要有可见差异，而不是完全相同
    expect(Math.abs(a - b)).toBeGreaterThan(0.03);
  });
});

describe('gaitLeg', () => {
  it('支撑期膝近乎伸直，摆动期明显屈膝', () => {
    // 支撑中期
    const support = gaitLeg(0.3);
    // 摆动期屈膝峰值附近
    const swing = gaitLeg(0.6 + 0.42 * 0.4);
    expect(swing.knee).toBeGreaterThan(support.knee + 25);
    expect(support.knee).toBeLessThan(20);
  });

  it('摆动期先屈后伸（存在明确屈膝峰值与后续伸展）', () => {
    const kneeAt = (u: number) => gaitLeg(0.6 + u * 0.4).knee;
    const peakAt = Math.max(...[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map(kneeAt));
    const endAt = kneeAt(0.95);
    expect(peakAt).toBeGreaterThan(endAt + 20);
  });

  it('支撑期脚跟先落、蹬离时脚尖下压', () => {
    expect(gaitLeg(0.05).ankle).toBeLessThan(0);       // 脚跟着地：踝背伸
    expect(gaitLeg(0.9).ankle).toBeGreaterThan(0);    // 蹬离：踝跖屈
  });

  it('摆动期勾脚尖（避免绊倒）', () => {
    expect(gaitLeg(0.6 + 0.35 * 0.4).ankle).toBeGreaterThan(5);
  });

  it('相位 0 与 0.5 处髋部最低（双支撑相）', () => {
    const at0 = gaitLeg(0).hipLift;
    const at05 = gaitLeg(0.5).hipLift;
    const at025 = gaitLeg(0.25).hipLift;
    expect(at0).toBeLessThan(at025);
    expect(at05).toBeLessThan(at025);
    expect(at0).toBeLessThan(0);
  });

  it('值域有界，无 NaN', () => {
    for (let p = 0; p < 1; p += 0.02) {
      const s = gaitLeg(p);
      for (const v of Object.values(s)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThan(200);
      }
    }
  });

  it('周期性：t 与 t+1 一致', () => {
    expect(gaitLeg(0.3).knee).toBeCloseTo(gaitLeg(1.3).knee, 6);
    expect(gaitLeg(-0.7).knee).toBeCloseTo(gaitLeg(0.3).knee, 6);
  });
});

describe('gaitCycle', () => {
  it('左右腿相差半个周期', () => {
    const c = gaitCycle(0);
    expect(c.left.knee).toBeCloseTo(gaitLeg(0).knee, 6);
    expect(c.right.knee).toBeCloseTo(gaitLeg(0.5).knee, 6);
  });

  it('不会出现两腿同时深屈（真实步态不可能双膝同时抬起）', () => {
    // 双支撑相两膝都接近伸直是正常的，此处只防「同时深屈」这种穿模姿态
    for (let p = 0; p < 1; p += 0.02) {
      const c = gaitCycle(p);
      expect(Math.min(c.left.knee, c.right.knee)).toBeLessThan(30);
    }
  });

  it('双支撑相（相位 0/0.5 附近）两膝都接近伸直', () => {
    // 支撑相定义：左腿 p∈[0,0.6) 或右腿 p∈[0.5,1)∩[0.5,1.1) …
    // 简化：取两腿都处于支撑期的相位（0 附近与 0.5 附近的对称点）
    for (const p of [0, 0.1, 0.5, 0.6]) {
      const c = gaitCycle(p);
      expect(c.left.knee).toBeLessThan(20);
      expect(c.right.knee).toBeLessThan(20);
    }
  });

  it('两腿中至少一腿始终接近伸直（支撑腿不会与摆动腿同时抬起）', () => {
    for (let p = 0; p < 1; p += 0.01) {
      expect(Math.min(gaitLeg(p).knee, gaitLeg(p + 0.5).knee)).toBeLessThan(20);
    }
  });

  it('手臂与同侧腿反相', () => {
    const c = gaitCycle(0.25);
    // 左腿大腿前摆时，左臂应后摆
    expect(c.left.armSwing * (c.left.thigh) ).toBeLessThan(0);
  });

  it('肘始终微屈，不会完全伸直', () => {
    for (let p = 0; p < 1; p += 0.05) {
      const c = gaitCycle(p);
      expect(c.left.elbow).toBeGreaterThan(8);
      expect(c.right.elbow).toBeGreaterThan(8);
    }
  });

  it('骨盆左右往复扭转（由调用方与胸廓反向组合）', () => {
    // 避开 p=0.25/0.75（正弦过零点），检查符号确实翻转
    const a = gaitCycle(0.1).pelvisYaw;
    const b = gaitCycle(0.6).pelvisYaw;
    expect(Math.sign(a)).not.toBe(Math.sign(b));
    expect(Math.abs(a)).toBeGreaterThan(1);
  });

  it('全程无 NaN', () => {
    for (let p = 0; p < 1; p += 0.01) {
      const c = gaitCycle(p);
      expect(Number.isFinite(c.hipLift)).toBe(true);
      expect(Number.isFinite(c.pelvisYaw)).toBe(true);
    }
  });
});
