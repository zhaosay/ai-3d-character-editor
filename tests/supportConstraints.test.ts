import { describe, expect, it } from 'vitest';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import {
  buildBoneMap, buildRestMap, buildRestPositionMap, generatePlannedTracks, generateProceduralTracks,
  type PlanSegment,
} from '../src/services/motion/procedural';
import { collectTrajectory } from '../src/core/physics/trajectory';
import { analyzeTrajectory } from '../src/core/physics/analyze';
import type { Gender } from '../src/core/character/appearance';

const NAMES = { hips: 'Hips', footL: 'Foot_L', footR: 'Foot_R' } as const;

interface Run {
  minFootY: number;
  hipsY0: number;
  hipsYN: number;
  penetration: number;
}

function run(gender: Gender, segments: PlanSegment[], duration: number, prompt?: string): Run {
  const actor = buildDemoCharacter(gender);
  try {
    const snap = buildSkeletonTree(actor.scene);
    const boneMap = buildBoneMap(snap);
    const rest = buildRestMap(snap);
    const restPos = buildRestPositionMap(snap);
    const result = prompt
      ? generateProceduralTracks(boneMap, { prompt, duration }, rest, restPos)
      : generatePlannedTracks(boneMap, segments, duration, 0, rest, restPos);
    const anim = { id: 'a', name: 'a', duration, fps: 30, tracks: result.tracks };
    const traj = collectTrajectory(actor.scene, anim, NAMES, 30);
    const issues = analyzeTrajectory(traj.samples);
    const pen = issues.filter((i) => i.kind === 'penetration');
    return {
      minFootY: Math.min(...traj.samples.map((s) => Math.min(s.feet.L?.[1] ?? 0, s.feet.R?.[1] ?? 0))),
      hipsY0: traj.samples[0].hipsY,
      hipsYN: traj.samples.at(-1)!.hipsY,
      penetration: pen.length > 0 ? Math.max(...pen.map((i) => i.value)) : 0,
    };
  } finally {
    actor.dispose();
  }
}

const seg = (template: string, clause: string, t0: number, t1: number): PlanSegment =>
  ({ t0, t1, template, clause });

describe.each<Gender>(['male', 'female'])('支撑约束回归 (%s)', (gender) => {
  // 这些断言对应 docs/motion-realism.md 里记录的真实缺陷修复
  it('lie：无支撑面时不穿地（曾达 0.425m）', () => {
    for (const clause of ['躺下', '躺到地面']) {
      const r = run(gender, [seg('lie', clause, 0, 3)], 3);
      expect(r.penetration, `${clause} 穿地 ${(r.penetration * 100).toFixed(1)}cm`).toBeLessThan(0.03);
    }
  });

  it('sit：坐地面时髋部必须下沉（曾恒为静息高度，臀下悬空 0.87m）', () => {
    const r = run(gender, [seg('sit', '坐下', 0, 3)], 3);
    // 髋部要从静息 0.98m 落到接近座面
    expect(r.hipsY0 - r.hipsYN, '髋部未下沉').toBeGreaterThan(0.5);
    expect(r.hipsYN, '髋部仍过高（角色坐在半空）').toBeLessThan(0.3);
  });

  it('orient：侧卧翻身时髋部必须下沉（曾终态悬空 0.55m）', () => {
    const r = run(gender, [seg('orient', '翻身到侧卧', 0, 3)], 3);
    expect(r.hipsY0 - r.hipsYN, '髋部未下沉').toBeGreaterThan(0.5);
  });

  it('squat：下蹲不得严重穿地', () => {
    const r = run(gender, [seg('squat', '下蹲', 0, 3)], 3);
    expect(r.penetration).toBeLessThan(0.12);
  });

  it('stand / breath / march：站立与行走不穿地', () => {
    for (const [t, c] of [['stand', '起身站直'], ['breath', '呼吸'], ['march', '走']] as const) {
      const r = run(gender, [seg(t, c, 0, 4)], 4);
      expect(r.penetration, `${t} 穿地 ${(r.penetration * 100).toFixed(1)}cm`).toBeLessThan(0.05);
    }
  });
});

describe('多语言输入不得降级（曾绕过世界动作规划）', () => {
  // decomposeWorldAction 只认中文；英文走 planClauses 落到无 contacts 路径，
  // 历史上导致 0.42m 穿模无保护。修复方式是把「有无支撑面」与子句文本解耦。
  it.each(['躺下', 'lie down', '躺下休息', 'lie down and rest', '躺到地面'])(
    '%s 都不产生穿地',
    (prompt) => {
      const r = run('male', [], 4, prompt);
      expect(r.penetration, `"${prompt}" 穿地 ${(r.penetration * 100).toFixed(1)}cm`).toBeLessThan(0.05);
    },
  );
});

describe('倒地段序列（kneel→lie→sleep）不产生穿地', () => {
  it.each<Gender>(['male', 'female'])('%s', (gender) => {
    const r = run(gender, [
      seg('kneel', '跪下', 0, 2.3),
      seg('lie', '躺下', 2.3, 5.3),
      seg('sleep', '睡觉', 5.3, 8),
    ], 8);
    expect(r.penetration, `穿地 ${(r.penetration * 100).toFixed(1)}cm`).toBeLessThan(0.05);
  });
});
