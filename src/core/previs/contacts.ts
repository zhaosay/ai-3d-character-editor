import type { PlannedAction } from './scenePlan';
import type { ContactConstraint } from './world';
import { mapActionStageIndices } from './actionMapping';

/** Keep contact references aligned with edited/reordered action stages. */
export function reconcileContactsToActions(
  previous: PlannedAction[],
  next: PlannedAction[],
  contacts: ContactConstraint[],
): ContactConstraint[] {
  const mapping = mapActionStageIndices(previous, next);
  return contacts.flatMap((contact) => {
    const oldIndex = contact.actionIndex ?? previous.findIndex((action) => action.template === contact.phase || action.clause === contact.phase);
    const oldAction = previous[oldIndex];
    if (!oldAction) return [contact];
    const nextIndex = mapping[oldIndex];
    if (nextIndex === null || nextIndex === undefined) return [];
    const nextAction = next[nextIndex];
    if (!nextAction) return [];

    // A contact for a different action type is unsafe to carry forward.
    if (nextAction.template !== oldAction.template) return [];
    if (oldAction.targetPropId !== nextAction.targetPropId) {
      if (contact.propId === 'ground' && nextAction.targetPropId) return [];
      if (contact.propId === oldAction.targetPropId) {
        if (!nextAction.targetPropId) return [];
        return [{ ...contact, actionIndex: nextIndex, phase: nextAction.template, propId: nextAction.targetPropId }];
      }
    }
    return [{ ...contact, actionIndex: nextIndex, phase: nextAction.template }];
  });
}
