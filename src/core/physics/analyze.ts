import type { HumanoidSemantic } from '../skeleton/types';
import type { PhysicsIssue, TrajSample } from './types';

/** Conservative warning thresholds around a rig's local rest orientation, not a full anatomy solver. */
export const JOINT_LIMIT_DEGREES: Partial<Record<HumanoidSemantic, number>> = {
  hips: 115, spine: 50, chest: 50, neck: 65, head: 65,
  'shoulder.L': 100, 'shoulder.R': 100,
  'upperArm.L': 165, 'upperArm.R': 165,
  'forearm.L': 155, 'forearm.R': 155,
  'hand.L': 95, 'hand.R': 95,
  'thigh.L': 150, 'thigh.R': 150,
  'shin.L': 155, 'shin.R': 155,
  'foot.L': 65, 'foot.R': 65,
};

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

/** Flags a rough balance risk when the projected body mass leaves the active foot support area. */
const FOOT_HALF_WIDTH = 0.055;
const FOOT_HALF_LENGTH = 0.13;

type GroundPoint = { x: number; z: number };

function cross2d(origin: GroundPoint, a: GroundPoint, b: GroundPoint): number {
  return (a.x - origin.x) * (b.z - origin.z) - (a.z - origin.z) * (b.x - origin.x);
}

function convexHull(points: GroundPoint[]): GroundPoint[] {
  const ordered = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (ordered.length <= 2) return ordered;
  const lower: GroundPoint[] = [];
  for (const point of ordered) {
    while (lower.length >= 2 && cross2d(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: GroundPoint[] = [];
  for (const point of [...ordered].reverse()) {
    while (upper.length >= 2 && cross2d(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop(); upper.pop();
  return [...lower, ...upper];
}

function pointToSupportFootprintDistance(point: GroundPoint, hull: GroundPoint[]): number {
  if (hull.length < 3) return Infinity;
  let inside = true;
  let distance = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if (cross2d(a, b, point) < -1e-8) inside = false;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const amount = lengthSq > 1e-10
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq))
      : 0;
    distance = Math.min(distance, Math.hypot(point.x - (a.x + dx * amount), point.z - (a.z + dz * amount)));
  }
  return inside ? 0 : distance;
}

function supportFootprint(sample: TrajSample): GroundPoint[] {
  const corners: GroundPoint[] = [];
  for (const side of ['L', 'R'] as const) {
    const foot = sample.feet[side];
    if (!foot || foot[1] >= 0.06) continue;
    const [forwardX, forwardZ] = sample.footForward?.[side] ?? [0, 1];
    const rightX = forwardZ;
    const rightZ = -forwardX;
    for (const sideSign of [-1, 1]) {
      for (const forwardSign of [-1, 1]) {
        corners.push({
          x: foot[0] + rightX * FOOT_HALF_WIDTH * sideSign + forwardX * FOOT_HALF_LENGTH * forwardSign,
          z: foot[2] + rightZ * FOOT_HALF_WIDTH * sideSign + forwardZ * FOOT_HALF_LENGTH * forwardSign,
        });
      }
    }
  }
  return convexHull(corners);
}

/** Uses the convex hull of active foot-sized support patches; it remains a static projection estimate. */
export function detectBalance(samples: TrajSample[], margin = 0.025, minDur = 0.1): PhysicsIssue[] {
  const outside = samples.map((sample) => {
    if (!sample.centerOfMass) return null;
    if (sample.massCoverage !== undefined && sample.massCoverage < 0.55) return null;
    const footprint = supportFootprint(sample);
    if (footprint.length < 3) return null;
    const [cx, , cz] = sample.centerOfMass;
    const distance = pointToSupportFootprintDistance({ x: cx, z: cz }, footprint);
    return distance > margin ? distance : null;
  });
  const out: PhysicsIssue[] = [];
  let start = -1;
  for (let i = 0; i <= samples.length; i++) {
    if (i < samples.length && outside[i] !== null) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const end = i - 1;
      const duration = samples[end].time - samples[start].time;
      if (duration >= minDur) {
        const distance = Math.max(...outside.slice(start, end + 1).filter((value): value is number => value !== null));
        out.push({
          kind: 'balance', t0: samples[start].time, t1: samples[end].time, value: distance,
          message: `重心投影偏离脚底支撑足印约 ${distance.toFixed(3)}m（${samples[start].time.toFixed(2)}–${samples[end].time.toFixed(2)}s）`,
        });
      }
      start = -1;
    }
  }
  return out;
}

/** Flags sustained local rotations far beyond conservative per-joint preview limits. */
export function detectJointLimits(
  samples: TrajSample[],
  limits: Array<{ boneName: string; maxDegrees: number }>,
): PhysicsIssue[] {
  return limits.flatMap(({ boneName, maxDegrees }) => segments(
    samples,
    (sample) => (sample.jointAngles?.[boneName] ?? 0) > maxDegrees,
  ).map((segment) => {
    const angle = Math.max(...segment.map((sample) => sample.jointAngles?.[boneName] ?? 0));
    return {
      kind: 'jointLimit' as const,
      boneName,
      limit: maxDegrees,
      t0: segment[0].time,
      t1: segment[segment.length - 1].time,
      value: angle,
      message: `${boneName} 相对静息姿势偏转 ${angle.toFixed(0)}°，超过预演检查阈值 ${maxDegrees}°（${segment[0].time.toFixed(2)}–${segment[segment.length - 1].time.toFixed(2)}s）`,
    };
  }));
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

export function analyzeTrajectory(
  samples: TrajSample[],
  jointLimits: Array<{ boneName: string; maxDegrees: number }> = [],
): PhysicsIssue[] {
  if (samples.length < 3) return [];
  return [
    ...detectPenetration(samples),
    ...detectFootSlide(samples),
    ...detectAccelSpikes(samples),
    ...detectBalance(samples),
    ...detectJointLimits(samples, jointLimits),
  ].sort((a, b) => a.t0 - b.t0);
}
