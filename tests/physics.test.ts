import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { analyzeTrajectory, detectAccelSpikes, detectFootSlide, detectPenetration, smoothHipsY } from '../src/core/physics/analyze';
import { collectTrajectory } from '../src/core/physics/trajectory';
import { buildFootLockEntries, buildHipsLiftEntries, buildSmoothedHipsEntries } from '../src/core/physics/fixes';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { detectIKChains } from '../src/core/ik/chains';
import { createEmptyAnimation } from '../src/core/animation/types';
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

  it('滑动平均保持长度并削峰', () => {
    const s = series(11, (t) => ({ hipsY: Math.abs(t - 0.5) < 0.05 ? 0 : 1, footY: 0.01 }));
    const sm = smoothHipsY(s, 5);
    expect(sm.length).toBe(s.length);
    expect(Math.min(...sm)).toBeGreaterThan(0);
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
    expect(warnings).toEqual([]);
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
    const { entries, warnings } = buildFootLockEntries(g, anim, issue, def, [...def.defaultPolePoint], 10);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => ['Thigh_L', 'Shin_L', 'Foot_L'].includes(e.boneName))).toBe(true);
    expect(warnings).toEqual([]);
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
