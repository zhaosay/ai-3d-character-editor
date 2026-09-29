import type { SketchDraftData } from './sketchToSpec';

export type SketchHistorySnapshot = SketchDraftData;

export function createSketchHistoryAppender(snapshot: SketchHistorySnapshot) {
  // The caller may clear a pointer ref before React evaluates its state updater.
  const captured = structuredClone(snapshot);
  return (history: SketchHistorySnapshot[]): SketchHistorySnapshot[] => [...history, structuredClone(captured)].slice(-50);
}
