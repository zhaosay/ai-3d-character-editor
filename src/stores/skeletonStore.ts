import { create } from 'zustand';
import type { SkeletonSnapshot } from '../core/skeleton/types';
import type { RigSuggestion } from '../core/skeleton/rigDetect';

interface SkeletonState {
  snapshot: SkeletonSnapshot | null;
  /** 当前骨架的自动识别诊断：映射置信度、缺失核心语义、未识别骨骼。 */
  rigSuggestion: RigSuggestion | null;
  setSnapshot: (s: SkeletonSnapshot | null) => void;
}

export const useSkeletonStore = create<SkeletonState>((set) => ({
  snapshot: null,
  rigSuggestion: null,
  setSnapshot: (snapshot) =>
    set({ snapshot, rigSuggestion: null }),
}));

export type { SkeletonState };
