import { describe, expect, it } from 'vitest';
import { createEmptyAnimation, validateAnimation } from '../src/core/animation/types';
import { createEmptyProject, validateProject } from '../src/core/project/schema';

describe('animation schema', () => {
  it('空动画默认合法', () => {
    const a = createEmptyAnimation();
    expect(a.tracks).toEqual([]);
    expect(validateAnimation(a)).toEqual([]);
  });

  it('越界key被检出', () => {
    const a = createEmptyAnimation('t', 30, 2);
    a.tracks.push({
      boneName: 'Hips',
      position: [{ time: 5, value: [0, 0, 0], interp: 'linear' }],
      rotation: [],
      scale: [],
    });
    expect(validateAnimation(a).length).toBeGreaterThan(0);
  });

  it('非法fps被检出', () => {
    const a = createEmptyAnimation('t', 77, 2);
    expect(validateAnimation(a).length).toBeGreaterThan(0);
  });
});

describe('project schema', () => {
  it('空项目合法', () => {
    const p = createEmptyProject();
    expect(p.version).toBe('1.0');
    expect(p.animations).toEqual([]);
    expect(validateProject(p)).toEqual([]);
  });

  it('版本号错误被检出', () => {
    const p = createEmptyProject();
    (p as unknown as { version: string }).version = '9.9';
    expect(validateProject(p as never).length).toBeGreaterThan(0);
  });
});
