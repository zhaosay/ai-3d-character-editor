import { create } from 'zustand';
import type { SketchDraftData } from '../core/rig/sketchToSpec';

interface SketchState {
  draft: SketchDraftData | null;
  restoreVersion: number;
  updateDraft: (draft: SketchDraftData) => void;
  restoreDraft: (draft: SketchDraftData | null) => void;
}

export const useSketchStore = create<SketchState>((set) => ({
  draft: null,
  restoreVersion: 0,
  updateDraft: (draft) => set({ draft: structuredClone(draft) }),
  restoreDraft: (draft) => set((state) => ({
    draft: draft ? structuredClone(draft) : null,
    restoreVersion: state.restoreVersion + 1,
  })),
}));
