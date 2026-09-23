import { create } from 'zustand';
import type { AnimationData } from '../core/animation/types';

const LIMIT = 50;

function clone(anims: AnimationData[]): AnimationData[] {
  return structuredClone(anims);
}

interface HistoryState {
  past: AnimationData[][];
  future: AnimationData[][];
  push: (snapshot: AnimationData[]) => void;
  undo: (current: AnimationData[]) => AnimationData[] | null;
  redo: (current: AnimationData[]) => AnimationData[] | null;
  clear: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  push: (snapshot) =>
    set((s) => ({ past: [...s.past.slice(-LIMIT + 1), clone(snapshot)], future: [] })),
  undo: (current) => {
    const { past, future } = get();
    if (past.length === 0) return null;
    const prev = past[past.length - 1];
    set({ past: past.slice(0, -1), future: [clone(current), ...future].slice(0, LIMIT) });
    return clone(prev);
  },
  redo: (current) => {
    const { past, future } = get();
    if (future.length === 0) return null;
    const [next, ...rest] = future;
    set({ past: [...past, clone(current)].slice(-LIMIT), future: rest });
    return clone(next);
  },
  clear: () => set({ past: [], future: [] }),
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
}));
