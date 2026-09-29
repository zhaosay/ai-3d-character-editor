import { describe, expect, it } from 'vitest';
import { optimizePlan, validatePlan } from '../src/core/previs/plan';

describe('editable previs plan', () => {
  it('智能优化从描述重识别动作并维持连续时间', () => {
    const plan = optimizePlan([
      { t0: 0, t1: 2, template: 'sway', clause: '走到桌前' },
      { t0: 2, t1: 4, template: 'sway', clause: '拿起手机' },
    ], 4);
    expect(plan.map((segment) => segment.template)).toEqual(['march', 'reach']);
    expect(plan[0].t0).toBe(0);
    expect(plan[1].t1).toBe(4);
  });

  it('拦截空描述、时间重叠和未知动作格式', () => {
    const issues = validatePlan([
      { t0: 0, t1: 2, template: 'unknown', clause: '' },
      { t0: 1, t1: 3, template: 'march', clause: '走' },
    ], 4);
    expect(issues.filter((issue) => issue.level === 'error')).toHaveLength(3);
  });
});
