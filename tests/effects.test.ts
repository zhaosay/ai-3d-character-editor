import { describe, expect, it } from 'vitest';
import { actionIndexAtTime, isEffectVisible, rebindEffectsToActions, sanitizeEffectEvent } from '../src/core/previs/effects';
import { useEffectsStore } from '../src/stores/effectsStore';

const event = {
  id: 'fx-1', kind: 'impact' as const, time: 1, duration: 0.25,
  position: [0, 1, 0] as [number, number, number], scale: 0.5, color: '#ffaa00',
};

describe('previs effect events', () => {
  it('validates and bounds timeline, spatial, and visual values', () => {
    expect(sanitizeEffectEvent({ ...event, time: -2, duration: 40, scale: 9, position: [200, 1, 0] })).toMatchObject({
      time: 0, duration: 10, scale: 5, position: [100, 1, 0],
    });
    expect(sanitizeEffectEvent({ ...event, kind: 'unknown' as never })).toBeNull();
    expect(sanitizeEffectEvent({ ...event, color: 'bad color' })).toMatchObject({ color: '#f5b942' });
    expect(sanitizeEffectEvent({ ...event, kind: 'slash', path: [[0, 1, 0], [1, 2, 0]] })).toMatchObject({ path: [[0, 1, 0], [1, 2, 0]] });
    expect(sanitizeEffectEvent({ ...event, kind: 'slash', path: [[0, Number.NaN, 0], [1, 2, 0]] })).toBeNull();
    const bladeSweep = [{ base: [0, 0, 0], tip: [0, 1, 0] }, { base: [1, 0, 0], tip: [1, 1, 0] }] as const;
    expect(sanitizeEffectEvent({ ...event, kind: 'slash', bladeSweep })).toMatchObject({ bladeSweep });
    expect(sanitizeEffectEvent({ ...event, kind: 'slash', bladeSweep: [{ base: [0, 0, 0], tip: [0, Number.NaN, 0] }, { base: [1, 0, 0], tip: [1, 1, 0] }] as never })).toBeNull();
  });

  it('is visible only during its event interval', () => {
    expect(isEffectVisible(event, 1)).toBe(true);
    expect(isEffectVisible(event, 1.25)).toBe(true);
    expect(isEffectVisible(event, 1.251)).toBe(false);
    expect(isEffectVisible(event, Number.NaN)).toBe(false);
  });

  it('assigns cut times to the following action and includes the final endpoint', () => {
    const actions = [{ t0: 0, t1: 2 }, { t0: 2, t1: 4 }];
    expect(actionIndexAtTime(actions, 2)).toBe(1);
    expect(actionIndexAtTime(actions, 4)).toBe(1);
    expect(actionIndexAtTime(actions, 4.01)).toBeUndefined();
  });

  it('preserves relative effect timing when the owning action is retimed', () => {
    const linked = { ...event, actionIndex: 1, time: 3 };
    const next = rebindEffectsToActions([linked], [{ t0: 0, t1: 2 }, { t0: 2, t1: 4 }], [{ t0: 0, t1: 1 }, { t0: 1, t1: 5 }]);
    expect(next[0]).toMatchObject({ actionIndex: 1, time: 3 });
    expect(rebindEffectsToActions([{ ...linked, time: 8 }], [{ t0: 0, t1: 2 }, { t0: 2, t1: 4 }], [{ t0: 0, t1: 1 }, { t0: 1, t1: 5 }])[0].time).toBe(5);
  });

  it.each(['spark', 'smoke', 'energy'] as const)('accepts the %s previs effect type', (kind) => {
    expect(sanitizeEffectEvent({ ...event, kind: kind as never })).toMatchObject({ kind });
  });

  it('places ground and air effects at semantically appropriate default heights', () => {
    useEffectsStore.getState().clear();
    useEffectsStore.getState().add('dust', 0);
    useEffectsStore.getState().add('smoke', 0);
    const effects = useEffectsStore.getState().events;
    expect(effects.find((item) => item.kind === 'dust')?.position[1]).toBeCloseTo(0.04);
    expect(effects.find((item) => item.kind === 'smoke')?.position[1]).toBeCloseTo(0.35);
    useEffectsStore.getState().clear();
  });
});
