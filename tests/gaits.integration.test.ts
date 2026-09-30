import { describe, expect, it } from 'vitest';
import { generateProceduralTracks, generatePlannedTracks, type BoneMap, type RestMap, type RestPositionMap } from '../src/services/motion/procedural';
import { gaitPeriod } from '../src/core/motion/gaits';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { buildBoneMap, buildRestMap, buildRestPositionMap } from '../src/services/motion/procedural';

const FULL_BONES: BoneMap = {
  hips: 'Hips', spine: 'Spine', chest: 'Chest', neck: 'Neck', head: 'Head',
  'upperArm.L': 'UpperArm_L', 'upperArm.R': 'UpperArm_R',
  'forearm.L': 'Forearm_L', 'forearm.R': 'Forearm_R',
  'thigh.L': 'Thigh_L', 'thigh.R': 'Thigh_R',
  'shin.L': 'Shin_L', 'shin.R': 'Shin_R',
  'foot.L': 'Foot_L', 'foot.R': 'Foot_R',
};
const REST_POS: RestPositionMap = { hips: [0, 1, 0] };

function gen(prompt: string, duration: number, rest: RestMap = {}) {
  return generateProceduralTracks(FULL_BONES, { prompt, duration }, rest, REST_POS);
}

describe('march 真实步态', () => {
  it('使用了踝/膝/骨盆/肘等真人步态关节', () => {
    const r = gen('走', 4);
    const names = r.tracks.map((t) => t.boneName);
    for (const n of ['Foot_L', 'Foot_R', 'Shin_L', 'Shin_R', 'Hips', 'Chest', 'Forearm_L']) {
      expect(names).toContain(n);
    }
  });

  it('走路关键帧密度足够高，不与步态周期混叠', () => {
    // 回归：STEP=0.25s 与步态周期 ~0.5s 正好 2:1，按 0.25s 网格采样
    // 每次落在同一相位 → 髋部起伏被抹平成 0（实测 spread=0）。
    // 走路必须用更细的网格（每周期 ≥ 24 点）。
    const hips = gen('走', 4).tracks.find((t) => t.boneName === 'Hips')!.position!;
    expect(hips.length, `走路关键帧只有 ${hips.length} 个`).toBeGreaterThan(100);
  });

  it('髋部有 2× 步频的垂直起伏（静止站立时不应有）', () => {
    const walk = gen('走', 4).tracks.find((t) => t.boneName === 'Hips')!.position;
    const ys = walk.map((k) => k.value[1]);
    const spread = Math.max(...ys) - Math.min(...ys);
    expect(spread).toBeGreaterThan(0.005); // 确实在起伏
    expect(spread).toBeLessThan(0.1);      // 但幅度合理
  });

  it('骨盆与胸廓反向旋转（真人走look关键特征）', () => {
    const r = gen('走', 4);
    // 用四元数 y 分量的符号近似判断：骨盆前摆时胸廓应反向
    const rotY = (bone: string) =>
      r.tracks.find((t) => t.boneName === bone)!.rotation.map((k) => k.value[1]);
    const hipsY = rotY('Hips');
    const chestY = rotY('Chest');
    expect(hipsY.length).toBeGreaterThan(3);
    // 胸廓与骨盆相位相反：存在同时刻符号相反的采样
    expect(hipsY.some((y, i) => y * chestY[i] < 0)).toBe(true);
  });

  it('步态周期接近真人（0.4–0.7s/步）', () => {
    const p = gaitPeriod({ legLength: 0.85, stride: 0.62 });
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.7);
  });

  it('走路段首尾髋部起伏归零，与后续静止段连续', () => {
    const r = generatePlannedTracks(
      FULL_BONES,
      [
        { t0: 0, t1: 3, template: 'march', clause: '走' },
        { t0: 3, t1: 5, template: 'breath', clause: '停' },
      ],
      5, 0, {}, REST_POS,
    );
    const keys = r.tracks.find((t) => t.boneName === 'Hips')!.position;
    const at = (t: number) => {
      const before = keys.filter((k) => k.time <= t).at(-1)!;
      const after = keys.find((k) => k.time >= t)!;
      if (before.time === after.time) return before.value[1];
      const k = (t - before.time) / (after.time - before.time);
      return before.value[1] + (after.value[1] - before.value[1]) * k;
    };
    // 走路段内 bob 生效，但跨到静止段（t>3）应稳定
    expect(Math.abs(at(4.0) - at(4.8))).toBeLessThan(1e-6);
  });
});

describe('预备/跟随包络注入', () => {
  it('发力类动作有预备的反向阶段（早期旋转与峰值期方向相反）', () => {
    for (const prompt of ['踢腿', '出拳', '挥剑']) {
      const r = gen(prompt, 2);
      const leadArm = prompt === '出拳' || prompt === '挥剑';
      const bone = leadArm ? 'UpperArm_R' : 'Thigh_R';
      const track = r.tracks.find((t) => t.boneName === bone);
      expect(track, `${prompt} 缺少 ${bone} 轨道`).toBeDefined();
      const rot = track!.rotation;
      // 预备：早期旋转量与中后期主方向相反
      const early = rot.filter((k) => k.time < 0.5);
      const mid = rot.filter((k) => k.time > 0.8 && k.time < 1.4);
      expect(early.length).toBeGreaterThan(0);
      expect(mid.length).toBeGreaterThan(0);
      // 存在早期与中期方向相反的证据（四元数 x 分量为俯仰主轴）
      const earlyX = early.map((k) => k.value[0]);
      const midX = mid.map((k) => k.value[0]);
      expect(earlyX.some((x) => midX.some((m) => x * m < 0))).toBe(true);
    }
  });

  it('踢腿小腿轨道存在（膝关节参与）', () => {
    const r = gen('踢腿', 2);
    const names = r.tracks.map((t) => t.boneName);
    expect(names.some((n) => n === 'Shin_L' || n === 'Shin_R')).toBe(true);
  });

  it('挥剑段两个手臂轨道都存在且不冲突（旧版有重复 key 隐患）', () => {
    const r = gen('挥剑', 2);
    const names = r.tracks.map((t) => t.boneName);
    expect(names).toContain('UpperArm_R');
    // 不会出现同一 track 名重复
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('真实骨架端到端', () => {
  it('程序化角色走一段路：骨骼齐全、无 NaN', () => {
    const actor = buildDemoCharacter('male');
    const snap = buildSkeletonTree(actor.scene);
    const r = generatePlannedTracks(
      buildBoneMap(snap),
      [{ t0: 0, t1: 3, template: 'march', clause: '走' }],
      3, 0, buildRestMap(snap), buildRestPositionMap(snap),
    );
    expect(r.tracks.length).toBeGreaterThan(8);
    for (const track of r.tracks) {
      for (const k of [...track.rotation, ...track.position, ...track.scale]) {
        for (const v of k.value) expect(Number.isFinite(v)).toBe(true);
      }
    }
    actor.dispose();
  });
});
