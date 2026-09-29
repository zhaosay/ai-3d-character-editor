import type { PlannedAction } from './scenePlan';

/** Map old action indexes to their corresponding stages after edits or reordering. */
export function mapActionStageIndices(previous: PlannedAction[], next: PlannedAction[]): Array<number | null> {
  const mapping: Array<number | null> = Array(previous.length).fill(null);
  const used = new Set<number>();
  const assign = (matches: (oldAction: PlannedAction, newAction: PlannedAction) => boolean) => {
    previous.forEach((oldAction, oldIndex) => {
      if (mapping[oldIndex] !== null) return;
      const candidates = next.flatMap((newAction, newIndex) =>
        !used.has(newIndex) && matches(oldAction, newAction) ? [newIndex] : []);
      const nextIndex = candidates.includes(oldIndex) ? oldIndex : candidates[0];
      if (nextIndex === undefined) return;
      mapping[oldIndex] = nextIndex;
      used.add(nextIndex);
    });
  };

  assign((a, b) => a.template === b.template && a.clause === b.clause && a.targetPropId === b.targetPropId);
  assign((a, b) => a.template === b.template && a.targetPropId === b.targetPropId);
  assign((a, b) => a.template === b.template);
  previous.forEach((_, oldIndex) => {
    if (mapping[oldIndex] !== null || oldIndex >= next.length || used.has(oldIndex)) return;
    mapping[oldIndex] = oldIndex;
    used.add(oldIndex);
  });
  return mapping;
}

export function rebindActionTime(time: number, oldAction: PlannedAction, newAction: PlannedAction): number {
  const span = oldAction.t1 - oldAction.t0;
  const ratio = span > 0 ? Math.min(1, Math.max(0, (time - oldAction.t0) / span)) : 0;
  return newAction.t0 + ratio * (newAction.t1 - newAction.t0);
}
