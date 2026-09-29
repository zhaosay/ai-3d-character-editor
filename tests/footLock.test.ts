import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_FOOT_LOCK, createFootLockStates, lockedTarget, totalSlip, updateFootState,
  type FootState,
} from '../src/core/ik/footLock';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('足部锁定状态机', () => {
  it('离地时不锁定，correction 归零', () => {
    let s: FootState = { side: 'L', planted: false, anchor: null, correction: 0, abandoned: 0 };
    s = updateFootState(s, v(0, 0.2, 0), DEFAULT_FOOT_LOCK); // 明显悬空
    expect(s.planted).toBe(false);
    expect(s.anchor).toBeNull();
    expect(s.correction).toBe(0);
  });

  it('触地时记录落点', () => {
    let s: FootState = { side: 'L', planted: false, anchor: null, correction: 0, abandoned: 0 };
    s = updateFootState(s, v(0.1, 0.01, 0.2), DEFAULT_FOOT_LOCK);
    expect(s.planted).toBe(true);
    expect(s.anchor).toEqual([0.1, 0, 0.2]);
  });

  it('支撑相内保持落点，correction 反映漂移距离', () => {
    let s: FootState = { side: 'L', planted: false, anchor: null, correction: 0, abandoned: 0 };
    s = updateFootState(s, v(0, 0.01, 0), DEFAULT_FOOT_LOCK);
    // 身体前进，脚被带着往前漂了 0.1m
    s = updateFootState(s, v(0.1, 0.01, 0), DEFAULT_FOOT_LOCK);
    expect(s.correction).toBeCloseTo(0.1, 5);
    expect(s.anchor).toEqual([0, 0, 0]);
  });

  it('离地后释放锁定，重新触地记录新落点', () => {
    let s: FootState = { side: 'L', planted: false, anchor: null, correction: 0, abandoned: 0 };
    s = updateFootState(s, v(0, 0.01, 0), DEFAULT_FOOT_LOCK);
    s = updateFootState(s, v(0.05, 0.25, 0), DEFAULT_FOOT_LOCK); // 抬起
    expect(s.planted).toBe(false);
    s = updateFootState(s, v(0.4, 0.01, 0), DEFAULT_FOOT_LOCK);   // 落到新点
    expect(s.anchor).toEqual([0.4, 0, 0]);
  });

  it('漂移超过 maxCorrection 时放弃并重记落点，避免腿被拉变形', () => {
    let s: FootState = { side: 'L', planted: false, anchor: null, correction: 0, abandoned: 0 };
    s = updateFootState(s, v(0, 0.01, 0), DEFAULT_FOOT_LOCK);
    s = updateFootState(s, v(5, 0.01, 0), DEFAULT_FOOT_LOCK); // 漂 5m
    expect(s.abandoned).toBe(1);
    expect(s.anchor).toEqual([5, 0, 0]);
    expect(s.correction).toBe(0);
  });

  it('时间跳变（速度异常）重置落点', () => {
    let s: FootState = { side: 'L', planted: false, anchor: null, correction: 0, abandoned: 0 };
    s = updateFootState(s, v(0, 0.01, 0), DEFAULT_FOOT_LOCK);
    s = updateFootState(s, v(0.1, 0.01, 0), DEFAULT_FOOT_LOCK, 99); // 99 m/s
    expect(s.anchor).toEqual([0.1, 0, 0]);
    expect(s.correction).toBe(0);
  });

  it('滞回区间（liftThreshold 与 contactTolerance 之间）保持原状态', () => {
    let s: FootState = { side: 'L', planted: false, anchor: null, correction: 0, abandoned: 0 };
    s = updateFootState(s, v(0, 0.01, 0), DEFAULT_FOOT_LOCK);
    // y=0.05 落在 [contactTolerance=0.045, liftThreshold=0.06] 的滞回带内
    s = updateFootState(s, v(0.02, 0.05, 0), DEFAULT_FOOT_LOCK);
    expect(s.planted).toBe(true);
    expect(s.anchor).toEqual([0, 0, 0]);
  });

  it('anchor 意外为 null 时自愈，不抛错', () => {
    const broken: FootState = { side: 'L', planted: true, anchor: null, correction: 0, abandoned: 0 };
    const s = updateFootState(broken, v(0.3, 0.01, 0), DEFAULT_FOOT_LOCK);
    expect(s.anchor).not.toBeNull();
  });
});

describe('lockedTarget', () => {
  const cfg = DEFAULT_FOOT_LOCK;
  it('未锁定时返回 null（不干预）', () => {
    const s: FootState = { side: 'L', planted: false, anchor: null, correction: 0, abandoned: 0 };
    expect(lockedTarget(s, cfg)).toBeNull();
  });

  it('漂移小于容差时不干预（避免抖动）', () => {
    const s: FootState = { side: 'L', planted: true, anchor: [0, 0, 0], correction: 0.01, abandoned: 0 };
    expect(lockedTarget(s, cfg)).toBeNull();
  });

  it('漂移超过容差时返回落点并贴地', () => {
    const s: FootState = { side: 'L', planted: true, anchor: [0.2, 0, 0.3], correction: 0.1, abandoned: 0 };
    expect(lockedTarget(s, cfg)).toEqual([0.2, 0, 0.3]);
  });
});

describe('打滑统计', () => {
  it('累加各脚 correction', () => {
    const states = createFootLockStates();
    states.set('L', { side: 'L', planted: true, anchor: [0, 0, 0], correction: 0.1, abandoned: 0 });
    states.set('R', { side: 'R', planted: true, anchor: [0, 0, 0], correction: 0.05, abandoned: 0 });
    expect(totalSlip(states.values())).toBeCloseTo(0.15, 6);
  });

  it('初始状态全为未锁定', () => {
    const states = createFootLockStates();
    expect(states.size).toBe(2);
    for (const s of states.values()) {
      expect(s.planted).toBe(false);
      expect(s.anchor).toBeNull();
    }
  });
});

describe('一轮行走的锁定行为（模拟）', () => {
  it('支撑脚被拉回落点，摆动脚自由', () => {
    const cfg = DEFAULT_FOOT_LOCK;
    let left: FootState = { side: 'L', planted: false, anchor: null, correction: 0, abandoned: 0 };
    let right: FootState = { side: 'R', planted: false, anchor: null, correction: 0, abandoned: 0 };

    // t=0: 双脚着地，身体在 z=0
    left = updateFootState(left, v(0, 0.0, 0), cfg);
    right = updateFootState(right, v(0, 0.0, 0), cfg);

    // 身体前进到 z=0.1：左脚仍支撑（应被锁住），右脚抬起
    left = updateFootState(left, v(0, 0.0, 0.1), cfg);
    right = updateFootState(right, v(0, 0.15, 0.1), cfg);
    expect(left.planted).toBe(true);
    expect(left.correction).toBeCloseTo(0.1, 5);
    expect(lockedTarget(left, cfg)).toEqual([0, 0, 0]);
    expect(right.planted).toBe(false);
    expect(lockedTarget(right, cfg)).toBeNull();

    // 身体到 z=0.25：右脚落地（z=0.35 附近），左脚抬起
    right = updateFootState(right, v(0, 0.0, 0.35), cfg);
    left = updateFootState(left, v(0, 0.18, 0.25), cfg);
    expect(right.planted).toBe(true);
    expect(left.planted).toBe(false);
  });
});
