import { describe, expect, it } from 'vitest';
import { generateProceduralTracks, generatePlannedTracks, bowFromClause } from '../src/services/motion/procedural';
import { sampleAnimation } from '../src/core/animation/sampler';
import { MIN_TURN_RADIUS, maxPathCurvature } from '../src/core/motion/path';
import type { Vec3Tuple } from '../src/types/global';
import type { PlanSegment } from '../src/services/motion/procedural';

const BONES = {
  hips: 'Hips', spine: 'Spine', chest: 'Chest',
  'thigh.L': 'TL', 'thigh.R': 'TR', 'shin.L': 'SL', 'shin.R': 'SR', 'foot.L': 'FL', 'foot.R': 'FR',
  'upperArm.L': 'UL', 'upperArm.R': 'UR', 'forearm.L': 'FL2', 'forearm.R': 'FR2',
  head: 'Head',
} as never;
const REST_POSITIONS = { hips: [0, 1, 0] as Vec3Tuple } as never;

const hipsOf = (tracks: { boneName: string; position: { time: number; value: Vec3Tuple }[] }[]) =>
  tracks.find((t) => t.boneName === 'Hips')!;

/** 采样整段，取髋部世界轨迹。 */
function trackPath(tracks: Parameters<typeof hipsOf>[0], duration = 4): Vec3Tuple[] {
  const anim = { id: 'x', name: 'x', duration, fps: 30, tracks: tracks as never };
  const out: Vec3Tuple[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = (duration * i) / 60;
    const pose = sampleAnimation(anim, t);
    const p = pose.get('Hips')?.position;
    out.push(p ? [p[0], p[1], p[2]] : [0, 0, 0]);
  }
  return out;
}

describe('走路曲率：位移不再恒为 +Z 直线', () => {
  it('「绕开桌子走」会走出横向偏移（x 不再恒为 0）', () => {
    const r = generateProceduralTracks(BONES, { prompt: '绕开桌子走到窗前', duration: 4 }, {}, REST_POSITIONS);
    const path = trackPath(r.tracks);
    const xs = path.map((p) => p[0]);
    // 核心验收：直线行走时 x 恒为 0，走弧线必须有横向位移
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.05);
  });

  it('普通「走到桌前」仍是直线（不无端编造弧线）', () => {
    const r = generateProceduralTracks(BONES, { prompt: '走到桌前', duration: 4 }, {}, REST_POSITIONS);
    const path = trackPath(r.tracks);
    const xs = path.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-6);
  });

  it('前进位移仍然存在（修 bow 时一度把 walkedZ 丢掉导致原地踏步）', () => {
    const r = generateProceduralTracks(BONES, { prompt: '走到桌前', duration: 4 }, {}, REST_POSITIONS);
    const zs = trackPath(r.tracks).map((p) => p[2]);
    expect(zs.at(-1)!).toBeGreaterThan(0.6);
    expect(zs[0]).toBeCloseTo(0, 6);
  });
});

describe('走路朝向：身体跟着路径转（之前完全没有）', () => {
  it('「绕开」走法产生非零髋部偏航', () => {
    const r = generateProceduralTracks(BONES, { prompt: '绕开桌子走到窗前', duration: 4 }, {}, REST_POSITIONS);
    const hips = hipsOf(r.tracks);
    const rots = hips.rotation ?? [];
    expect(rots.length).toBeGreaterThan(0);
    // 从四元数取偏航：绕 Y 的分量
    const yawDeg = (q: readonly number[]) => {
      // XYZ 欧拉序下由四元数反解 Y 分量
      const x = q[0], y = q[1], z = q[2], w = q[3];
      return Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - x * z)))) * 180 / Math.PI;
    };
    const yaws = rots.map((k) => Math.abs(yawDeg(k.value)));
    expect(Math.max(...yaws)).toBeGreaterThan(1); // 至少偏了几度
  });

  it('直线走法不因路径产生偏航', () => {
    // 注意：march 模板本身给髋部一点横向摆动是正常的（骨盆在水平面上的
    // 交替摆动，真人走路确实有）。这里锁定的是「路径没贡献偏航」——
    // 即与改动前的读数一致，而不是绝对为 0。
    const r = generateProceduralTracks(BONES, { prompt: '走到桌前', duration: 4 }, {}, REST_POSITIONS);
    const hips = hipsOf(r.tracks);
    const yawDeg = (q: readonly number[]) => {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      return Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - x * z)))) * 180 / Math.PI;
    };
    const yaws = (hips.rotation ?? []).map((k) => Math.abs(yawDeg(k.value)));
    expect(Math.max(...yaws)).toBeLessThan(8); // 实测 6.00°，全来自骨盆摆动
  });
});

describe('显式途经点（结构化的走弧线入口）', () => {
  const seg = (over: Partial<PlanSegment>): PlanSegment => ({
    t0: 0, t1: 4, template: 'march', clause: '', ...over,
  });

  it('给 viaPoints 时路径经过这些点', () => {
    const via: Vec3Tuple[] = [[0.6, 1, 0.6], [1.2, 1, 0.2]];
    const r = generatePlannedTracks(
      BONES, [seg({ viaPoints: via })], 4, 0, {}, REST_POSITIONS,
    );
    const xs = trackPath(r.tracks).map((p) => p[0]);
    const zs = trackPath(r.tracks).map((p) => p[2]);
    // 路径必须真的经过 x≈0.6 附近（而不是直线 z 推进）
    const nearVia = via.filter((v) => xs.some((x, i) => Math.abs(x - v[0]) < 0.15 && Math.abs(zs[i] - v[2]) < 0.2));
    expect(nearVia.length).toBeGreaterThan(0);
  });

  it('bow 字段优先于 clause 推断', () => {
    const explicit = generatePlannedTracks(
      BONES, [seg({ clause: '绕开桌子', bow: 0 })], 4, 0, {}, REST_POSITIONS,
    );
    const xs = trackPath(explicit.tracks).map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-6);
  });
});

describe('bowFromClause：只在明确表达绕行意图时才加弧', () => {
  it('绕开类 → 明显绕行', () => {
    expect(bowFromClause('绕开桌子')).toBeGreaterThan(0.15);
    expect(bowFromClause('绕过障碍')).toBeGreaterThan(0.15);
  });

  it('弧线/转弯类 → 轻微弧', () => {
    expect(bowFromClause('走弧线过去')).toBeGreaterThan(0.05);
    expect(bowFromClause('拐个弯')).toBeGreaterThan(0.05);
  });

  it('普通走位 → 0（不编造动作）', () => {
    expect(bowFromClause('走到桌前')).toBe(0);
    expect(bowFromClause('向前走')).toBe(0);
    expect(bowFromClause('')).toBe(0);
  });
});

describe('躯干/视线先行于脚步', () => {
  const yawDeg = (q: readonly number[]) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    return Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - x * z)))) * 180 / Math.PI;
  };
  const build = (viaPoints?: Vec3Tuple[]) => generatePlannedTracks(
    BONES,
    [{ t0: 0, t1: 4, template: 'march', clause: '', ...(viaPoints ? { viaPoints } : {}) } as PlanSegment],
    4, 0, {}, REST_POSITIONS,
  );

  it('胸部朝向与髋部朝向不同（躯干不是跟着根节点整体转）', () => {
    const r = build([[0.7, 1, 1.2], [1.4, 1, 0.4]]);
    const anim = { id: 'x', name: 'x', duration: 4, fps: 30, tracks: r.tracks };
    let maxDiff = 0;
    for (let i = 0; i <= 80; i++) {
      const pose = sampleAnimation(anim, (4 * i) / 80);
      const h = yawDeg(pose.get('Hips')!.quaternion!);
      const c = yawDeg(pose.get('Chest')!.quaternion!);
      maxDiff = Math.max(maxDiff, Math.abs(c - h));
    }
    expect(maxDiff).toBeGreaterThan(3);
  });

  it('直线走法下躯干与髋部基本一致（不无端拧身）', () => {
    const r = build();
    const anim = { id: 'x', name: 'x', duration: 4, fps: 30, tracks: r.tracks };
    for (const t of [0.5, 1, 1.5, 2]) {
      const pose = sampleAnimation(anim, t);
      const h = yawDeg(pose.get('Hips')!.quaternion!);
      const c = yawDeg(pose.get('Chest')!.quaternion!);
      expect(Math.abs(c - h)).toBeLessThan(20); // 基线 12°（骨盆与胸廓反向扭转，真人走路本就有）
    }
  });
});

describe('弯道减速：步频随曲率下降', () => {
  /** 数大腿角过零次数 ≈ 步态周期数。 */
  const gaitCycles = (tracks: Parameters<typeof hipsOf>[0], bone = 'TL') => {
    const anim = { id: 'x', name: 'x', duration: 4, fps: 120, tracks: tracks as never };
    let crossings = 0;
    let prev = 0;
    for (let i = 0; i <= 480; i++) {
      const pose = sampleAnimation(anim, (4 * i) / 480);
      const q = pose.get(bone)?.quaternion;
      if (!q) return -1;
      // 用 X 分量的符号变化近似过零
      const v = q[0];
      if (i > 0 && Math.sign(v) !== Math.sign(prev)) crossings++;
      prev = v;
    }
    return crossings;
  };

  it('尖锐路径上的步态周期数少于直线（弯道减速真的作用到步频）', () => {
    const straight = generateProceduralTracks(BONES, { prompt: '向前走', duration: 4 }, {}, REST_POSITIONS);
    const curved = generatePlannedTracks(
      BONES,
      [{ t0: 0, t1: 4, template: 'march', clause: '', viaPoints: [[0.15, 1, 0.15], [0.3, 1, 0.3], [0.45, 1, 0.15]] } as PlanSegment],
      4, 0, {}, REST_POSITIONS,
    );
    const a = gaitCycles(straight.tracks);
    const b = gaitCycles(curved.tracks);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeLessThan(a);
  });
});

describe('生成的弧线在真人可走范围内', () => {
  it('绕行用的弧度不会产生小于 0.5m 的转弯半径', () => {
    // 用与模板相同的 bow 值构弧，检查曲率
    for (const clause of ['绕开桌子', '走弧线过去']) {
      const bow = bowFromClause(clause);
      const pts: Vec3Tuple[] = [[0, 0, 0], [bow * 3, 0, 1.5], [0, 0, 3]];
      expect(maxPathCurvature(pts), `${clause} bow=${bow}`).toBeLessThanOrEqual(1 / MIN_TURN_RADIUS);
    }
  });

  it('弧线路径总长略大于直线（不应短于弦长）', () => {
    const r = generateProceduralTracks(BONES, { prompt: '绕开桌子走到窗前', duration: 4 }, {}, REST_POSITIONS);
    const p = trackPath(r.tracks);
    let len = 0;
    for (let i = 1; i < p.length; i++) {
      len += Math.hypot(p[i][0] - p[i - 1][0], p[i][2] - p[i - 1][2]);
    }
    const chord = Math.hypot(p.at(-1)![0] - p[0][0], p.at(-1)![2] - p[0][2]);
    expect(len).toBeGreaterThanOrEqual(chord * 0.999);
    expect(len).toBeGreaterThan(chord); // 弧线确实比直线长
  });
});