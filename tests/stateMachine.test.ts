import { describe, expect, it } from 'vitest';
import {
  ANY_STATE, createMachine, machineFadeWeight, machineIsFading, stepMachine,
  validateMachine, type StateMachineDef,
} from '../src/core/animation/stateMachine';

const DEF: StateMachineDef = {
  entry: 'idle',
  states: [
    { id: 'idle', animationId: 'a-idle' },
    { id: 'walk', animationId: 'a-walk' },
    { id: 'hit', animationId: 'a-hit', loop: false },
  ],
  transitions: [
    { from: 'idle', to: 'walk', trigger: 'isMoving', duration: 0.25 },
    // 停步是「isMoving 变 false」，故 triggerValue=false
    { from: 'walk', to: 'idle', trigger: 'isMoving', triggerValue: false, condition: 'wantIdle', duration: 0.3 },
    { from: 'idle', to: 'hit', duration: 0.1, exitTime: 0.8 },
    { from: ANY_STATE, to: 'hit', trigger: 'isHit', duration: 0.05 },
  ],
};

describe('状态机骨架', () => {
  it('从 Entry 状态开始', () => {
    const m = createMachine(DEF);
    expect(m.state).toBe('idle');
    expect(m.time).toBe(0);
    expect(machineIsFading(m)).toBe(false);
  });

  it('触发器为真时切换，并记录淡化来源', () => {
    let m = createMachine(DEF);
    const r = stepMachine(m, DEF, { params: { isMoving: true }, clipDuration: 2 }, 1 / 60);
    expect(r.changed).toBe(true);
    expect(r.runtime.state).toBe('walk');
    expect(r.runtime.fadingFrom).toBe('idle');
    expect(r.runtime.fadeDuration).toBeCloseTo(0.25, 6);
    m = r.runtime;
  });

  it('触发器为假时不切', () => {
    const m = createMachine(DEF);
    const r = stepMachine(m, DEF, { params: { isMoving: false }, clipDuration: 2 }, 1 / 60);
    expect(r.changed).toBe(false);
    expect(r.runtime.state).toBe('idle');
  });

  it('反向触发器：停步（isMoving 变 false）能切换', () => {
    const m = { ...createMachine(DEF), state: 'walk' };
    // triggerValue=false 才能匹配
    const r = stepMachine(m, DEF, { params: { isMoving: false, wantIdle: true }, clipDuration: 2 }, 0.1);
    expect(r.runtime.state).toBe('idle');
  });

  it('同时需要 trigger 与 condition 时，condition 不满足则不切', () => {
    let m = createMachine(DEF);
    // 从 walk 出发需要 isMoving=false 且 wantIdle=true
    m = { ...m, state: 'walk' };
    const noCond = stepMachine(m, DEF, { params: { isMoving: false }, clipDuration: 2 }, 0.1);
    expect(noCond.runtime.state, 'condition 不满足时不应切换').toBe('walk');
    const withCond = stepMachine(m, DEF, { params: { isMoving: false, wantIdle: true }, clipDuration: 2 }, 0.1);
    expect(withCond.runtime.state).toBe('idle');
  });

  it('Any State 能打断任意状态（受击不该等当前动作播完）', () => {
    for (const from of ['idle', 'walk']) {
      const m = { ...createMachine(DEF), state: from, time: 0.05 };
      const r = stepMachine(m, DEF, { params: { isHit: true }, clipDuration: 2 }, 1 / 60);
      expect(r.runtime.state, `${from} 应被打断到 hit`).toBe('hit');
      // 打断**不等退出时间**
      expect(r.runtime.time).toBe(0);
    }
  });

  it('退出时间：走到归一化进度后才切', () => {
    let m = createMachine(DEF);
    // idle → hit 需要 exitTime 0.8，无 trigger
    const early = stepMachine(m, DEF, { params: {}, clipDuration: 4 }, 1 / 60);
    expect(early.runtime.state).toBe('idle');
    m = { ...m, time: 3.9 }; // 0.975 > 0.8
    const late = stepMachine(m, DEF, { params: {}, clipDuration: 4 }, 1 / 60);
    expect(late.runtime.state).toBe('hit');
  });

  it('非循环动作到末尾停在末尾，不 wrap', () => {
    const m = { ...createMachine(DEF), state: 'hit', time: 0 };
    const r = stepMachine(m, DEF, { params: {}, clipDuration: 1, loop: false }, 5);
    expect(r.runtime.time).toBeCloseTo(1, 6);
  });

  it('循环动作按时长取模', () => {
    const m = { ...createMachine(DEF), state: 'walk', time: 0 };
    const r = stepMachine(m, DEF, { params: {}, clipDuration: 2, loop: true }, 2.5);
    expect(r.runtime.time).toBeCloseTo(0.5, 6);
  });

  it('speed 倍率影响推进速度', () => {
    const def: StateMachineDef = {
      entry: 's', states: [{ id: 's', animationId: 'a', speed: 2 }], transitions: [],
    };
    const r = stepMachine(createMachine(def), def, { clipDuration: 10 }, 0.5);
    expect(r.runtime.time).toBeCloseTo(1, 6);
  });

  it('淡化中再次切换：保留当前淡化进度，不重置', () => {
    let m = createMachine(DEF);
    m = stepMachine(m, DEF, { params: { isMoving: true }, clipDuration: 2 }, 1 / 60).runtime;
    m = { ...m, fadeElapsed: 0.1 };
    // 淡化中再被 isHit 打断
    const r = stepMachine(m, DEF, { params: { isHit: true }, clipDuration: 2 }, 1 / 60);
    expect(r.runtime.state).toBe('hit');
    expect(r.runtime.fadeElapsed, '淡化进度应保留而不是从头开始').toBeGreaterThan(0.1);
  });
});

describe('machineFadeWeight', () => {
  it('无淡化时返回 null', () => {
    expect(machineFadeWeight(createMachine(DEF))).toBeNull();
  });

  it('淡化权重从 0 走到 1（smoothstep）', () => {
    let m = createMachine(DEF);
    m = stepMachine(m, DEF, { params: { isMoving: true }, clipDuration: 2 }, 1 / 60).runtime;
    expect(machineFadeWeight(m) ?? -1).toBeLessThan(0.2);
    m = { ...m, fadeElapsed: 0.125 }; // 0.125/0.25 = 0.5
    expect(machineFadeWeight(m)).toBeCloseTo(0.5, 2);
    m = { ...m, fadeElapsed: 0.25 };
    expect(machineFadeWeight(m)).toBeCloseTo(1, 6);
  });

  it('零时长淡化直接到 1（等价硬切）', () => {
    const def: StateMachineDef = {
      entry: 'a', states: [{ id: 'a', animationId: 'x' }, { id: 'b', animationId: 'y' }],
      transitions: [{ from: 'a', to: 'b', trigger: 'go', duration: 0 }],
    };
    const m = stepMachine(createMachine(def), def, { params: { go: true }, clipDuration: 1 }, 1 / 60).runtime;
    expect(machineFadeWeight(m)).toBe(1);
  });
});

describe('validateMachine', () => {
  it('合法定义无报错', () => {
    expect(validateMachine(DEF)).toEqual([]);
  });

  it('指出 entry / 过渡两端不存在的状态', () => {
    const errs = validateMachine({ ...DEF, entry: 'nope' });
    expect(errs.some((e) => e.includes('entry'))).toBe(true);
    const errs2 = validateMachine({
      entry: 'a', states: [{ id: 'a', animationId: 'x' }],
      transitions: [{ from: 'a', to: 'ghost', duration: 0.2 }],
    });
    expect(errs2.some((e) => e.includes('过渡目标不存在'))).toBe(true);
  });

  it('退出时间越界被指出', () => {
    const errs = validateMachine({
      entry: 'a', states: [{ id: 'a', animationId: 'x' }, { id: 'b', animationId: 'y' }],
      transitions: [{ from: 'a', to: 'b', duration: 0.2, exitTime: 1.5 }],
    });
    expect(errs.some((e) => e.includes('退出时间'))).toBe(true);
  });
});