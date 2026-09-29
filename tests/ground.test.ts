import { describe, expect, it } from 'vitest';
import { GroundField, groundFieldFromProps } from '../src/core/world/ground';

describe('GroundField 基准平面', () => {
  it('空场地返回地面高度与向上法线', () => {
    const g = new GroundField({ groundY: 0.2 });
    const s = g.sample(0, 0, 0.25);
    expect(s.height).toBeCloseTo(0.2, 6);
    expect(s.normal.y).toBeCloseTo(1, 6);
    expect(s.source).toBe('plane');
  });

  it('任意 xz 都返回同一高度', () => {
    const g = new GroundField({ groundY: -0.5 });
    for (const [x, z] of [[0, 0], [5, -3], [-100, 200]]) {
      expect(g.sample(x, z, 0).height).toBeCloseTo(-0.5, 6);
    }
  });
});

describe('GroundField 台阶', () => {
  const step = { id: 'step1', center: [0, 0.1, 0] as const, size: [1, 0.2, 1] as const, rotationY: 0 };

  it('盒子顶面高于平面时命中盒子', () => {
    const g = new GroundField({ groundY: 0, boxes: [step] });
    expect(g.sample(0, 0, 0.1).height).toBeCloseTo(0.2, 6);
    expect(g.sample(0, 0, 0.1).source).toBe('box');
    expect(g.sample(0, 0, 0.1).boxId).toBe('step1');
  });

  it('盒子外退回平面', () => {
    const g = new GroundField({ groundY: 0, boxes: [step] });
    const s = g.sample(5, 5, 0.05);
    expect(s.height).toBeCloseTo(0, 6);
    expect(s.source).toBe('plane');
  });

  it('walkable:false 的盒子不参与', () => {
    const g = new GroundField({ groundY: 0, boxes: [{ ...step, walkable: false }] });
    expect(g.sample(0, 0, 0.1).source).toBe('plane');
  });

  it('探测窗口外的盒子不被吸附（防止吸到远处高台）', () => {
    const tall = { id: 'tower', center: [0, 2, 0] as const, size: [1, 2, 1] as const };
    const g = new GroundField({ groundY: 0, boxes: [tall], probeUp: 0.3 });
    // 脚在 y=0.1，探测上限 0.4，盒顶 3.0 超窗 → 不应命中
    expect(g.sample(0, 0, 0.1).source).toBe('plane');
  });

  it('重叠盒子取最高顶面', () => {
    const g = new GroundField({
      groundY: 0,
      boxes: [
        { id: 'low', center: [0, 0.05, 0] as const, size: [2, 0.1, 2] as const },
        { id: 'high', center: [0, 0.15, 0] as const, size: [1, 0.3, 1] as const },
      ],
    });
    const s = g.sample(0, 0, 0.1);
    expect(s.height).toBeCloseTo(0.3, 6);
    expect(s.boxId).toBe('high');
  });

  it('yaw 旋转后的盒子按旋转后投影判定', () => {
    const g = new GroundField({
      groundY: 0,
      boxes: [{ id: 'r', center: [0, 0.1, 0] as const, size: [2, 0.2, 0.5] as const, rotationY: Math.PI / 2 }],
    });
    // 旋转 90° 后长边沿 Z：x=0.8, z=0 应在外面，x=0, z=0.8 应在
    expect(g.sample(0.8, 0, 0.1).source).toBe('plane');
    expect(g.sample(0, 0.8, 0.1).source).toBe('box');
  });

  it('边界点算在盒内（闭区间）', () => {
    const g = new GroundField({ groundY: 0, boxes: [{ id: 'b', center: [0, 0.1, 0] as const, size: [1, 0.2, 1] as const }] });
    expect(g.sample(0.5, 0.5, 0.1).source).toBe('box');
  });
});

describe('GroundField 法线与工具', () => {
  it('平面法线恒为 +Y', () => {
    const g = new GroundField({ groundY: 0 });
    const n = g.sampleNormal(1, 2, 0.1);
    expect(n.y).toBeCloseTo(1, 6);
  });

  it('isElevated 正确判断是否踩上台阶', () => {
    const g = new GroundField({ groundY: 0, boxes: [{ id: 's', center: [0, 0.1, 0] as const, size: [1, 0.2, 1] as const }] });
    expect(g.isElevated(0, 0, 0.1)).toBe(true);
    expect(g.isElevated(9, 9, 0.1)).toBe(false);
  });

  it('addBox / clearBoxes 生效', () => {
    const g = new GroundField({ groundY: 0 });
    expect(g.isElevated(0, 0, 0.1)).toBe(false);
    g.addBox({ id: 'x', center: [0, 0.1, 0], size: [1, 0.2, 1] });
    expect(g.isElevated(0, 0, 0.1)).toBe(true);
    g.clearBoxes();
    expect(g.isElevated(0, 0, 0.1)).toBe(false);
  });
});

describe('groundFieldFromProps', () => {
  const props = [
    { id: 'bed1', kind: 'bed', position: [2, 0, 0] as const, rotationY: 0, size: { width: 1.4, height: 0.5, length: 2 } },
    { id: 'sword1', kind: 'sword', position: [0, 0.2, 0] as const, rotationY: 0, size: { width: 0.05, height: 0.05, length: 0.9 } },
  ];

  it('床/桌可站立，剑等不可', () => {
    const g = groundFieldFromProps(0, props);
    expect(g.sample(2, 0, 0.3).source).toBe('box');   // 床面 0.5
    expect(g.sample(0, 0, 0.2).source).toBe('plane'); // 剑不构成地面
  });

  it('道具中心已含底面偏移，顶面 = position.y + height', () => {
    const g = groundFieldFromProps(0, props);
    expect(g.sample(2, 0, 0.4).height).toBeCloseTo(0.5, 6);
  });
});
