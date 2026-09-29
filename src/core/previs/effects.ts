import type { Vec3Tuple } from '../../types/global';
import type { PlannedAction } from './scenePlan';
import { mapActionStageIndices, rebindActionTime } from './actionMapping';

export type PrevisEffectKind = 'slash' | 'impact' | 'dust' | 'spark' | 'smoke' | 'energy';

export interface BladeSweepSample {
  base: Vec3Tuple;
  tip: Vec3Tuple;
}

export interface PrevisEffectEvent {
  id: string;
  animationId?: string;
  kind: PrevisEffectKind;
  /** Action stage that owns this cue; optional for backwards-compatible projects. */
  actionIndex?: number;
  time: number;
  duration: number;
  position: Vec3Tuple;
  /** Sampled weapon-tip sweep for an estimated slash trail; not a collision result. */
  path?: Vec3Tuple[];
  /** Sampled hilt-to-tip spans used to approximate the blade's swept surface. */
  bladeSweep?: BladeSweepSample[];
  scale: number;
  color: string;
}

export interface EffectActionSpan { t0: number; t1: number }

/** Keep an effect at the same relative point when its owning action is retimed. */
export function rebindEffectsToActions<T extends PrevisEffectEvent>(
  events: T[], previous: EffectActionSpan[], next: EffectActionSpan[],
): T[] {
  return events.map((event) => {
    const index = event.actionIndex;
    if (index === undefined || !previous[index] || !next[index]) return event;
    const oldSpan = previous[index];
    const newSpan = next[index];
    const ratio = oldSpan.t1 > oldSpan.t0 ? (event.time - oldSpan.t0) / (oldSpan.t1 - oldSpan.t0) : 0;
    const time = newSpan.t0 + Math.min(1, Math.max(0, ratio)) * (newSpan.t1 - newSpan.t0);
    return time === event.time ? event : { ...event, time };
  });
}

/** Move action-owned effects with their stage; discard cues invalidated by action/target edits. */
export function reconcileEffectsToActions<T extends PrevisEffectEvent>(
  events: T[], previous: PlannedAction[], next: PlannedAction[],
): T[] {
  const mapping = mapActionStageIndices(previous, next);
  return events.flatMap((event) => {
    if (event.actionIndex === undefined) return [event];
    const oldAction = previous[event.actionIndex];
    if (!oldAction) return [event];
    const nextIndex = mapping[event.actionIndex];
    if (nextIndex === null || nextIndex === undefined) return [];
    const nextAction = next[nextIndex];
    if (!nextAction || nextAction.template !== oldAction.template || nextAction.targetPropId !== oldAction.targetPropId) return [];
    return [{ ...event, actionIndex: nextIndex, time: rebindActionTime(event.time, oldAction, nextAction) }];
  });
}

/** Use half-open intervals so an effect at a cut belongs to the following action. */
export function actionIndexAtTime(actions: EffectActionSpan[], time: number): number | undefined {
  if (!Number.isFinite(time)) return undefined;
  const index = actions.findIndex((action, i) => time >= action.t0 && (time < action.t1 || (i === actions.length - 1 && time <= action.t1)));
  return index >= 0 ? index : undefined;
}

export function sanitizeEffectEvent(event: PrevisEffectEvent, duration = 120): PrevisEffectEvent | null {
  if (!event.id || !['slash', 'impact', 'dust', 'spark', 'smoke', 'energy'].includes(event.kind)) return null;
  if (event.actionIndex !== undefined && (!Number.isInteger(event.actionIndex) || event.actionIndex < 0)) return null;
  if (![event.time, event.duration, event.scale, ...event.position].every(Number.isFinite)) return null;
  if (event.path && (event.path.length < 2 || event.path.length > 64
    || event.path.some((point) => !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)))) return null;
  if (event.bladeSweep && (event.bladeSweep.length < 2 || event.bladeSweep.length > 64
    || event.bladeSweep.some((sample) => !sample || ![sample.base, sample.tip].every((point) =>
      Array.isArray(point) && point.length === 3 && point.every(Number.isFinite))))) return null;
  return {
    ...event,
    time: Math.min(Math.max(event.time, 0), duration),
    duration: Math.min(Math.max(event.duration, 0.05), 10),
    scale: Math.min(Math.max(event.scale, 0.05), 5),
    position: event.position.map((value) => Math.min(Math.max(value, -100), 100)) as Vec3Tuple,
    ...(event.path ? { path: event.path.map((point) => point.map((value) => Math.min(Math.max(value, -100), 100)) as Vec3Tuple) } : {}),
    ...(event.bladeSweep ? { bladeSweep: event.bladeSweep.map((sample) => ({
      base: sample.base.map((value) => Math.min(Math.max(value, -100), 100)) as Vec3Tuple,
      tip: sample.tip.map((value) => Math.min(Math.max(value, -100), 100)) as Vec3Tuple,
    })) } : {}),
    color: /^#[\da-f]{6}$/i.test(event.color) ? event.color : '#f5b942',
  };
}

export function isEffectVisible(event: PrevisEffectEvent, time: number): boolean {
  return Number.isFinite(time) && time >= event.time && time <= event.time + event.duration;
}
