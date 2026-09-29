import { describe, expect, it } from 'vitest';
import type { PrevisEffectEvent } from '../src/core/previs/effects';
import { awaitWithPlanningRevision, createPlanningRevision, formatEffectsContext, formatSceneIssuesContext } from '../src/services/agent/sceneContext';

describe('AI scene context', () => {
  it('includes stable effect IDs and slash paths so repair requests can target the existing trail', () => {
    const context = formatEffectsContext([
      { id: 'fx-impact', kind: 'impact', time: 1, duration: 0.2, position: [1, 2, 3], scale: 1, color: '#ffffff' },
      { id: 'fx-slash', kind: 'slash', actionIndex: 2, time: 2, duration: 0.3, position: [0, 1, 0], path: [[0, 1, 0], [1, 2, 0]], bladeSweep: [{ base: [0, 1, 0], tip: [0, 2, 0] }, { base: [1, 1, 0], tip: [1, 2, 0] }], scale: 1, color: '#ffffff' },
    ]);
    expect(context.indexOf('fx-slash')).toBeLessThan(context.indexOf('fx-impact'));
    expect(context).toContain('actionIndex=2');
    expect(context).toContain('worldPath=[[0,1,0],[1,2,0]]');
    expect(context).toContain('worldBladeSweep=');
  });

  it('bounds context growth while prioritizing editable slash paths', () => {
    const events: PrevisEffectEvent[] = Array.from({ length: 40 }, (_, index) => ({
      id: `fx-${index}`, kind: 'impact' as const, time: index, duration: 0.2,
      position: [0, 1, 0] as [number, number, number], scale: 1, color: '#ffffff',
    }));
    events[39] = { ...events[39], kind: 'slash', bladeSweep: [{ base: [0, 0, 0], tip: [0, 1, 0] }, { base: [1, 0, 0], tip: [1, 1, 0] }] };
    const context = formatEffectsContext(events);
    expect(context).toContain('fx-39');
    expect(context).toContain('另有 8 个特效事件未展开');
  });

  it('includes exact ScenePlan field paths and obstacle IDs in repair context', () => {
    const context = formatSceneIssuesContext([
      { level: 'warning', path: 'effects.0.path', message: '挥砍路径与场景道具 table-main 相交' },
    ]);
    expect(context).toContain('WARNING effects.0.path');
    expect(context).toContain('table-main');
  });

  it('discards delayed AI results when the serialized editor planning context changes', async () => {
    const original = createPlanningRevision({ animationId: 'a1', props: [{ id: 'table-a' }], lockedFields: [] });
    expect(createPlanningRevision({ animationId: 'a1', props: [{ id: 'table-a' }], lockedFields: [] })).toBe(original);
    expect(createPlanningRevision({ animationId: 'a1', props: [{ id: 'table-b' }], lockedFields: [] })).not.toBe(original);

    let revision = original;
    let resolveRequest!: (value: string) => void;
    const request = new Promise<string>((resolve) => { resolveRequest = resolve; });
    const guarded = awaitWithPlanningRevision(request, original, () => revision);
    revision = createPlanningRevision({ animationId: 'a2', props: [{ id: 'table-a' }], lockedFields: [] });
    resolveRequest('stale model actions');
    await expect(guarded).resolves.toBeNull();
  });
});
