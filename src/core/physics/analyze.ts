import type { PhysicsIssue, TrajSample } from './types';

/** 连续满足 pred 的采样分组为 [t0,t1] 段。 */
function segments(samples: TrajSample[], pred: (s: TrajSample) => boolean): TrajSample[][] {
  const out: TrajSample[][] = [];
  let cur: TrajSample[] = [];
  for (const s of samples) {
    if (pred(s)) cur.push(s);
    else {
      if (cur.length > 0) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const footY = (s: TrajSample, foot: 'L' | 'R') => s.feet[foot]?.[1] ?? Infinity;

/** 脚底穿透：y < -tol 的连续段。 */
export function detectPenetration(samples: TrajSample[], tol = 0.02): PhysicsIssue[] {
  const issues: PhysicsIssue[] = [];
  for (const foot of ['L', 'R'] as const) {
    for (const seg of segments(samples, (s) => footY(s, foot) < -tol)) {
      const depth = Math.min(...seg.map((s) => footY(s, foot)));
      issues.push({
        kind: 'penetration',
        foot,
        t0: seg[0].time,
        t1: seg[seg.length - 1].time,
        value: -depth,
        message: `${foot === 'L' ? '左' : '右'}脚穿透地面 ${(-depth).toFixed(3)}m（${seg[0].time.toFixed(2)}–${seg[seg.length - 1].time.toFixed(2)}s）`,
      });
    }
  }
  return issues;
}

/** 脚滑：贴地（y < contactY）且水平速度持续超限的段。 */
export function detectFootSlide(
  samples: TrajSample[],
  contactY = 0.05,
  speedTol = 0.35,
  minDur = 0.15,
): PhysicsIssue[] {
  const issues: PhysicsIssue[] = [];
  for (const foot of ['L', 'R'] as const) {
    const contact = segments(samples, (s) => footY(s, foot) < contactY);
    for (const seg of contact) {
      if (seg.length < 2) continue;
      let dist = 0;
      let fast = 0;
      for (let i = 1; i < seg.length; i++) {
        const a = seg[i - 1].feet[foot]!;
        const b = seg[i].feet[foot]!;
        const dx = b[0] - a[0];
        const dz = b[2] - a[2];
        const dt = Math.max(seg[i].time - seg[i - 1].time, 1e-6);
        dist += Math.hypot(dx, dz);
        if (Math.hypot(dx, dz) / dt > speedTol) fast += dt;
      }
      const dur = seg[seg.length - 1].time - seg[0].time;
      if (fast >= minDur && dist > 0.03) {
        issues.push({
          kind: 'footSlide',
          foot,
          t0: seg[0].time,
          t1: seg[seg.length - 1].time,
          value: dist,
          message: `${foot === 'L' ? '左' : '右'}脚滑动 ${dist.toFixed(3)}m（贴地 ${dur.toFixed(2)}s 内水平移动）`,
        });
      }
    }
  }
  return issues;
}

/** 加速度突变：髋部高度二阶差分超限（落地过硬/抽帧）。 */
export function detectAccelSpikes(samples: TrajSample[], accelTol = 30): PhysicsIssue[] {
  const issues: PhysicsIssue[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const dt = Math.max(samples[i + 1].time - samples[i - 1].time, 1e-6) / 2;
    const a =
      (samples[i + 1].hipsY - 2 * samples[i].hipsY + samples[i - 1].hipsY) / (dt * dt);
    if (Math.abs(a) > accelTol) {
      issues.push({
        kind: 'accelSpike',
        t0: samples[i].time,
        t1: samples[i].time,
        value: Math.abs(a),
        message: `重心加速度突变 ${Math.abs(a).toFixed(1)}m/s² @${samples[i].time.toFixed(2)}s（落地过硬或抽帧）`,
      });
    }
  }
  return issues;
}

/** 髋部高度滑动平均（奇数窗口），用于落地缓冲修复。 */
export function smoothHipsY(samples: TrajSample[], window = 5): number[] {
  const half = Math.floor(window / 2);
  return samples.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < samples.length) {
        sum += samples[j].hipsY;
        n++;
      }
    }
    return sum / Math.max(n, 1);
  });
}

export function analyzeTrajectory(samples: TrajSample[]): PhysicsIssue[] {
  if (samples.length < 3) return [];
  return [
    ...detectPenetration(samples),
    ...detectFootSlide(samples),
    ...detectAccelSpikes(samples),
  ].sort((a, b) => a.t0 - b.t0);
}
