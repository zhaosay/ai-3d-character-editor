import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { analyzeTrajectory, detectAccelSpikes, detectBalance, detectFootSlide, detectJointLimits, detectPenetration, smoothHipsY } from '../src/core/physics/analyze';
import { collectTrajectory } from '../src/core/physics/trajectory';
import { buildBalanceCorrectionEntries, buildFootLockEntries, buildHipsLiftEntries, buildJointLimitEntries, buildSmoothedHipsEntries } from '../src/core/physics/fixes';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { detectIKChains } from '../src/core/ik/chains';
import { createEmptyAnimation } from '../src/core/animation/types';
import { sampleAnimation } from '../src/core/animation/sampler';
import { indexBonesByName } from '../src/core/animation/applyPose';
import type { TrajSample } from '../src/core/physics/types';

function samp(time: number, hipsY: number, footY: number, footX = 0): TrajSample {
  return {
    time,
    hipsY,
    hipsLocal: [0, hipsY, 0],
    feet: { L: [footX, footY, 0], R: null },
  };
}

function series(n: number, fn: (t: number) => { hipsY: number; footY: number; footX?: number }): TrajSample[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i * 1) / (n - 1);
    const v = fn(t);
    return samp(t, v.hipsY, v.footY, v.footX ?? 0);
  });
}

describe('physics analyze (pure)', () => {
  it('穿透段检出深度', () => {
    const s = series(11, (t) => ({ hipsY: 1, footY: t > 0.3 && t < 0.6 ? -0.05 : 0.01 }));
    const issues = detectPenetration(s);
    expect(issues.length).toBe(1);
    expect(issues[0].foot).toBe('L');
    expect(issues[0].value).toBeCloseTo(0.05, 3);
  });

  it('贴地高速移动判脚滑，空中移动不判', () => {
    const slide = series(21, (t) => ({ hipsY: 1, footY: 0.01, footX: t * 1.0 }));
    expect(detectFootSlide(slide).length).toBe(1);
    expect(detectFootSlide(slide)[0].value).toBeCloseTo(1.0, 1);
    const air = series(21, (t) => ({ hipsY: 1, footY: 0.5, footX: t * 1.0 }));
    expect(detectFootSlide(air)).toEqual([]);
  });

  it('髋部高度折点判加速度突变，平滑运动不判', () => {
    const kink = series(31, (t) => ({ hipsY: t < 0.5 ? 1 - t : 0.5 + (t - 0.5), footY: 0.01 }));
    expect(detectAccelSpikes(kink).length).toBeGreaterThan(0);
    const smooth = series(31, (t) => ({ hipsY: 1 + 0.05 * Math.sin(t * Math.PI * 2), footY: 0.01 }));
    expect(detectAccelSpikes(smooth)).toEqual([]);
  });

  it('双脚支撑时重心投影稳定不报错，持续越界会定位为失衡', () => {
    const stable = series(11, () => ({ hipsY: 1, footY: 0.01, footX: -0.1 })).map((sample) => ({
      ...sample,
      feet: { L: [-0.1, 0.01, 0] as [number, number, number], R: [0.1, 0.01, 0] as [number, number, number] },
      centerOfMass: [0, 1, 0] as [number, number, number],
    }));
    expect(detectBalance(stable)).toEqual([]);

    const unstable = stable.map((sample) => ({ ...sample, centerOfMass: [0.5, 1, 0] as [number, number, number] }));
    expect(detectBalance(unstable)).toMatchObject([{ kind: 'balance', t0: 0, t1: 1 }]);
    expect(detectBalance(unstable.map((sample) => ({ ...sample, massCoverage: 0.3 })))).toEqual([]);
  });

  it('按脚掌朝向和足印宽度判断单脚支撑，避免把侧向越界误判为稳定', () => {
    const samples = series(11, () => ({ hipsY: 1, footY: 0.01 })).map((sample) => ({
      ...sample,
      feet: { L: [0, 0.01, 0] as [number, number, number], R: null },
      footForward: { L: [1, 0] as [number, number] },
      centerOfMass: [0.1, 1, 0] as [number, number, number],
    }));

    expect(detectBalance(samples)).toEqual([]);
    const sideOutOfFootprint = samples.map((sample) => ({
      ...sample,
      centerOfMass: [0, 1, 0.12] as [number, number, number],
    }));
    expect(detectBalance(sideOutOfFootprint)).toMatchObject([
      { kind: 'balance', t0: 0, t1: 1 },
    ]);
  });

  it('滑动平均保持长度并削峰', () => {
    const s = series(11, (t) => ({ hipsY: Math.abs(t - 0.5) < 0.05 ? 0 : 1, footY: 0.01 }));
    const sm = smoothHipsY(s, 5);
    expect(sm.length).toBe(s.length);
    expect(Math.min(...sm)).toBeGreaterThan(0);
  });

  it('持续超过单关节阈值时报告骨骼和超限时间段', () => {
    const samples = series(11, () => ({ hipsY: 1, footY: 0.01 })).map((sample, index) => ({
      ...sample,
      jointAngles: { Forearm_L: index >= 3 && index <= 7 ? 171 : 20 },
    }));
    expect(detectJointLimits(samples, [{ boneName: 'Forearm_L', maxDegrees: 155 }])).toMatchObject([
      { kind: 'jointLimit', boneName: 'Forearm_L', limit: 155, t0: 0.3, t1: 0.7, value: 171 },
    ]);
  });
});

function rig() {
  const g = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  hips.position.set(0, 1, 0);
  g.add(hips);
  const mk = (parent: THREE.Object3D, name: string, x: number, y: number, z = 0) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    return b;
  };
  // 微屈站立：腿总长 0.89，髋→脚静息 0.888（留 IK 余量）；脚底 y≈0.04
  const th = mk(hips, 'Thigh_L', 0.1, -0.08, 0);
  const sh = mk(th, 'Shin_L', 0, -0.44, 0.1);
  mk(sh, 'Foot_L', 0, -0.44, 0.02);
  g.updateWorldMatrix(true, true);
  return g;
}

describe('trajectory + fixes (live scene)', () => {
  it('无效采样帧率、动画时长或超量采样会明确失败而不启动采样', () => {
    const g = rig();
    const anim = createEmptyAnimation('采样保护', 30, 1);
    const names = { hips: 'Hips', footL: 'Foot_L', footR: null };
    expect(collectTrajectory(g, anim, names, 0)).toMatchObject({ samples: [], warnings: [expect.stringMatching(/1–240 FPS/)] });
    expect(collectTrajectory(g, { ...anim, duration: Number.NaN }, names)).toMatchObject({ samples: [], warnings: [expect.stringMatching(/动画时长无效/)] });
    expect(collectTrajectory(g, { ...anim, duration: 1000 }, names, 120)).toMatchObject({ samples: [], warnings: [expect.stringMatching(/超过上限 100000/)] });
  });

  it('从静息局部旋转计算关节偏转角，并在 live scene 采样后恢复姿势', () => {
    const g = rig();
    const upperArm = new THREE.Bone();
    upperArm.name = 'UpperArm_L';
    g.add(upperArm);
    const animated = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(170));
    const anim = createEmptyAnimation('关节范围', 30, 1);
    anim.tracks.push({
      boneName: upperArm.name, position: [], scale: [],
      rotation: [
        { time: 0, value: [0, 0, 0, 1], interp: 'linear' },
        { time: 0.5, value: animated.toArray() as [number, number, number, number], interp: 'linear' },
        { time: 1, value: [0, 0, 0, 1], interp: 'linear' },
      ],
    });
    const before = upperArm.quaternion.toArray();
    const { samples } = collectTrajectory(g, anim, {
      hips: 'Hips', footL: 'Foot_L', footR: null,
      jointLimits: [{ semantic: 'upperArm.L', boneName: upperArm.name, restQuaternion: [0, 0, 0, 1], maxDegrees: 165 }],
    }, 10);
    expect(samples.find((sample) => sample.time === 0.5)?.jointAngles?.UpperArm_L).toBeCloseTo(170, 1);
    expect(upperArm.quaternion.toArray()).toEqual(before);
  });

  it('关节范围修复只改问题骨骼和时间段，并把偏转限制到阈值内', () => {
    const anim = createEmptyAnimation('关节夹限', 30, 1);
    const extreme = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(170));
    anim.tracks.push({
      boneName: 'Forearm_L', position: [], scale: [],
      rotation: [
        { time: 0, value: [0, 0, 0, 1], interp: 'linear' },
        { time: 0.5, value: extreme.toArray() as [number, number, number, number], interp: 'linear' },
        { time: 1, value: [0, 0, 0, 1], interp: 'linear' },
      ],
    });
    const issue = { kind: 'jointLimit' as const, boneName: 'Forearm_L', t0: 0.4, t1: 0.6, value: 170, limit: 150, message: 'test' };
    const entries = buildJointLimitEntries(anim, issue, {
      semantic: 'forearm.L', boneName: 'Forearm_L', restQuaternion: [0, 0, 0, 1], maxDegrees: 150,
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.boneName === 'Forearm_L' && entry.time >= 0.4 && entry.time <= 0.6)).toBe(true);
    const track = anim.tracks[0];
    track.rotation = [...track.rotation.filter((key) => !entries.some((entry) => Math.abs(entry.time - key.time) < 1e-4)), ...entries]
      .sort((a, b) => a.time - b.time);
    const repaired = sampleAnimation(anim, 0.5).get('Forearm_L')!.quaternion!;
    const angle = new THREE.Quaternion(...repaired).angleTo(new THREE.Quaternion());
    expect(THREE.MathUtils.radToDeg(angle)).toBeCloseTo(150, 0);
  });

  it('按可用躯干与腿部骨骼位置计算加权重心', () => {
    const g = rig();
    const anim = createEmptyAnimation('重心采样', 30, 1);
    const { samples } = collectTrajectory(g, anim, {
      hips: 'Hips', footL: 'Foot_L', footR: null,
      massBones: { hips: 'Hips', 'thigh.L': 'Thigh_L' },
    }, 2);
    expect(samples[0].centerOfMass?.[0]).toBeCloseTo(0.1 * 0.1 / 0.24);
    expect(samples[0].centerOfMass?.[1]).toBeCloseTo((1 * 0.14 + 0.92 * 0.1) / 0.24);
    expect(samples[0].massCoverage).toBeCloseTo(0.24 / 1.05);
  });

  it('缺少重心语义骨骼时停用失衡估算并说明原因', () => {
    const result = collectTrajectory(rig(), createEmptyAnimation('no mass map', 30, 1), {
      hips: 'Hips', footL: 'Foot_L', footR: null,
    }, 2);
    expect(result.samples[0].centerOfMass).toBeUndefined();
    expect(result.samples[0].massCoverage).toBe(0);
    expect(result.warnings).toContain('未映射可用于重心估算的人体骨骼，失衡分析不可用');
  });

  it('轨迹采样会恢复用户当前的骨骼缩放', () => {
    const g = rig();
    const hips = indexBonesByName(g).get('Hips')!;
    hips.scale.set(1.1, 0.9, 1.05);
    const before = hips.scale.toArray();
    const anim = createEmptyAnimation('缩放采样', 30, 1);
    anim.tracks.push({
      boneName: 'Hips', position: [], rotation: [],
      scale: [
        { time: 0, value: [1, 1, 1], interp: 'linear' },
        { time: 1, value: [1.5, 1.5, 1.5], interp: 'linear' },
      ],
    });
    collectTrajectory(g, anim, { hips: 'Hips', footL: 'Foot_L', footR: null }, 10);
    expect(hips.scale.toArray()).toEqual(before);
  });

  it('下压动画检出穿透，抬升修复消除穿透', () => {
    const g = rig();
    const anim = createEmptyAnimation('T', 30, 1);
    anim.tracks.push({
      boneName: 'Hips',
      position: [
        { time: 0, value: [0, 1, 0], interp: 'linear' },
        { time: 0.5, value: [0, 0.85, 0], interp: 'linear' },
        { time: 1, value: [0, 1, 0], interp: 'linear' },
      ],
      rotation: [],
      scale: [],
    });
    const names = { hips: 'Hips', footL: 'Foot_L', footR: null };
    const { samples, warnings } = collectTrajectory(g, anim, names, 30);
    expect(samples.length).toBeGreaterThan(10);
    const issues = analyzeTrajectory(samples);
    const pens = issues.filter((i) => i.kind === 'penetration');
    expect(pens.length).toBeGreaterThan(0);

    const entries = buildHipsLiftEntries(samples, issues, 'Hips');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.value[1] > 0.85)).toBe(true);
    expect(warnings).toContain('未映射可用于重心估算的人体骨骼，失衡分析不可用');
  });

  it('脚锁 entries 钉住接触段（整链 rotation）', () => {
    const g = rig();
    const anim = createEmptyAnimation('T', 30, 1);
    anim.tracks.push({
      boneName: 'Hips',
      position: [
        { time: 0, value: [0, 1, 0], interp: 'linear' },
        { time: 1, value: [0.1, 1, 0], interp: 'linear' },
      ],
      rotation: [],
      scale: [],
    });
    const snap = buildSkeletonTree(g);
    const def = detectIKChains(snap).find((d) => d.id === 'leg.L')!;
    expect(def).toBeDefined();
    const issue = {
      kind: 'footSlide' as const,
      foot: 'L' as const,
      t0: 0.2,
      t1: 0.8,
      value: 0.2,
      message: 'test',
    };
    const initialPose = [...indexBonesByName(g)].map(([name, b]) => ({
      name,
      position: b.position.toArray(),
      quaternion: b.quaternion.toArray(),
      scale: b.scale.toArray(),
    }));
    const { entries, warnings } = buildFootLockEntries(g, anim, issue, def, [...def.defaultPolePoint], 10);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => ['Thigh_L', 'Shin_L', 'Foot_L'].includes(e.boneName))).toBe(true);
    expect(warnings).toEqual([]);
    const afterBones = indexBonesByName(g);
    for (const pose of initialPose) {
      expect(afterBones.get(pose.name)!.position.toArray()).toEqual(pose.position);
      expect(afterBones.get(pose.name)!.quaternion.toArray()).toEqual(pose.quaternion);
      expect(afterBones.get(pose.name)!.scale.toArray()).toEqual(pose.scale);
    }
  });

  it('重心配平移动髋部并烘焙支撑腿 IK，同时恢复实时姿势', () => {
    const g = rig();
    const anim = createEmptyAnimation('balance repair', 30, 1);
    const snapshot = buildSkeletonTree(g);
    const chain = detectIKChains(snapshot).find((def) => def.id === 'leg.L')!;
    const before = [...indexBonesByName(g)].map(([name, bone]) => [name, bone.position.toArray(), bone.quaternion.toArray()]);
    const samples: TrajSample[] = [0.2, 0.5, 0.8].map((time) => ({
      time, hipsY: 1, hipsLocal: [0, 1, 0], feet: { L: [0.1, 0.04, 0.12], R: null },
      centerOfMass: [0.5, 1, 0.12], massCoverage: 1,
    }));
    const issue = { kind: 'balance' as const, t0: 0.2, t1: 0.8, value: 0.4, message: 'balance' };
    const result = buildBalanceCorrectionEntries(g, anim, samples, issue, 'Hips', {
      L: { def: chain, polePoint: [...chain.defaultPolePoint] },
    }, 10);

    expect(result.pos).toHaveLength(3);
    expect(result.pos.every((entry) => entry.value[0] < 0)).toBe(true);
    expect(result.rot.length).toBeGreaterThan(0);
    expect([...indexBonesByName(g)].map(([name, bone]) => [name, bone.position.toArray(), bone.quaternion.toArray()])).toEqual(before);
  });

  it('低质量骨覆盖率或缺少支撑腿 IK 时拒绝重心自动修复', () => {
    const g = rig();
    const sample: TrajSample = { time: 0.5, hipsY: 1, hipsLocal: [0, 1, 0], feet: { L: [0.1, 0.04, 0.1], R: null }, centerOfMass: [0.5, 1, 0.1], massCoverage: 0.3 };
    const issue = { kind: 'balance' as const, t0: 0.5, t1: 0.5, value: 0.4, message: 'balance' };
    const lowCoverage = buildBalanceCorrectionEntries(g, createEmptyAnimation('low map', 30, 1), [sample], issue, 'Hips', {});
    expect(lowCoverage.pos).toEqual([]);
    expect(lowCoverage.warnings[0]).toMatch(/覆盖率不足/);

    const noChain = buildBalanceCorrectionEntries(g, createEmptyAnimation('no chain', 30, 1), [{ ...sample, massCoverage: 1 }], issue, 'Hips', {});
    expect(noChain.pos).toEqual([]);
    expect(noChain.warnings[0]).toMatch(/腿 IK 链缺失/);
  });

  it('配平写入并重采样后会降低合成全身姿势的失衡距离', () => {
    const scene = new THREE.Group();
    const add = (parent: THREE.Object3D, name: string, x: number, y: number, z = 0) => {
      const next = new THREE.Bone(); next.name = name; next.position.set(x, y, z); parent.add(next); return next;
    };
    const hips = add(scene, 'Hips', 0, 1);
    const spine = add(hips, 'Spine', 0, 0.2);
    const chest = add(spine, 'Chest', 0, 0.2);
    const neck = add(chest, 'Neck', 0, 0.1);
    add(neck, 'Head', 0, 0.12);
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? -1 : 1;
      const shoulder = add(chest, `Shoulder_${side}`, sign * 0.18, 0.05);
      const upper = add(shoulder, `UpperArm_${side}`, sign * 0.18, -0.02);
      const forearm = add(upper, `Forearm_${side}`, sign * 0.25, -0.25);
      add(forearm, `Hand_${side}`, sign * 0.22, -0.2);
      const thigh = add(hips, `Thigh_${side}`, sign * 0.1, -0.1);
      const shin = add(thigh, `Shin_${side}`, 0, -0.43, 0.2);
      add(shin, `Foot_${side}`, 0, -0.43, -0.2);
    }
    scene.updateWorldMatrix(true, true);
    const snapshot = buildSkeletonTree(scene);
    const bySem = new Map(Object.values(snapshot.nodes).map((node) => [node.semantic, node.name]));
    const names = {
      hips: bySem.get('hips')!, footL: bySem.get('foot.L')!, footR: bySem.get('foot.R')!,
      massBones: Object.fromEntries([...bySem].filter(([semantic, name]) => semantic && name)),
    };
    const anim = createEmptyAnimation('lean and recover', 30, 1);
    anim.tracks.push({ boneName: 'Spine', position: [
      { time: 0, value: [0, 0.2, 0], interp: 'linear' },
      { time: 1, value: [0.8, 0.2, 0], interp: 'linear' },
    ], rotation: [], scale: [] });
    const beforeSamples = collectTrajectory(scene, anim, names, 30).samples;
    const originalIssue = analyzeTrajectory(beforeSamples).find((issue) => issue.kind === 'balance');
    expect(originalIssue).toBeDefined();
    const chains = Object.fromEntries(detectIKChains(snapshot).map((chain) => [chain.id === 'leg.L' ? 'L' : chain.id === 'leg.R' ? 'R' : chain.id, {
      def: chain, polePoint: chain.defaultPolePoint,
    }]));
    const correction = buildBalanceCorrectionEntries(scene, anim, beforeSamples, originalIssue!, names.hips, chains, 30);
    expect(correction.pos.length).toBeGreaterThan(0);
    anim.tracks.push({ boneName: names.hips, position: correction.pos, rotation: [], scale: [] });
    for (const chain of detectIKChains(snapshot).filter((candidate) => candidate.type === 'leg')) {
      anim.tracks.push({ boneName: chain.rootBone, position: [], rotation: correction.rot.filter((entry) => entry.boneName === chain.rootBone), scale: [] });
      anim.tracks.push({ boneName: chain.midBone, position: [], rotation: correction.rot.filter((entry) => entry.boneName === chain.midBone), scale: [] });
      anim.tracks.push({ boneName: chain.endBone, position: [], rotation: correction.rot.filter((entry) => entry.boneName === chain.endBone), scale: [] });
    }
    const afterSamples = collectTrajectory(scene, anim, names, 30).samples;
    const remaining = analyzeTrajectory(afterSamples).filter((issue) => issue.kind === 'balance'
      && issue.t0 <= originalIssue!.t1 + 0.1 && issue.t1 >= originalIssue!.t0 - 0.1);
    expect(Math.max(...remaining.map((issue) => issue.value), 0)).toBeLessThan(originalIssue!.value);
  });

  it('平滑 entries 只覆盖突变邻域', () => {
    const g = rig();
    const anim = createEmptyAnimation('T', 30, 1);
    anim.tracks.push({
      boneName: 'Hips',
      position: [
        { time: 0, value: [0, 1, 0], interp: 'linear' },
        { time: 0.5, value: [0, 0.5, 0], interp: 'linear' },
        { time: 1, value: [0, 1, 0], interp: 'linear' },
      ],
      rotation: [],
      scale: [],
    });
    const names = { hips: 'Hips', footL: 'Foot_L', footR: null };
    const { samples } = collectTrajectory(g, anim, names, 30);
    const issues = analyzeTrajectory(samples);
    expect(issues.some((i) => i.kind === 'accelSpike')).toBe(true);
    const entries = buildSmoothedHipsEntries(samples, issues, 'Hips', 0.25);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.time >= 0.25 - 1e-6 && e.time <= 0.75 + 1e-6)).toBe(true);
  });
});
