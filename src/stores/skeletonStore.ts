import { create } from 'zustand';
import type { SkeletonSnapshot } from '../core/skeleton/types';

interface SkeletonState {
  snapshot: SkeletonSnapshot | null;
  setSnapshot: (s: SkeletonSnapshot | null) => void;
}

export const useSkeletonStore = create<SkeletonState>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));
