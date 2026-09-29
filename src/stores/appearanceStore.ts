import { create } from 'zustand';
import { DEFAULT_APPEARANCE, clampAppearance, type Appearance } from '../core/character/appearance';

interface AppearanceState {
  appearance: Appearance;
  set: (patch: Partial<Appearance>) => void;
  replace: (a: Partial<Appearance>) => void;
  reset: () => void;
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  appearance: { ...DEFAULT_APPEARANCE },
  set: (patch) => set((s) => ({ appearance: clampAppearance({ ...s.appearance, ...patch }) })),
  replace: (a) => set({ appearance: clampAppearance(a) }),
  reset: () => set({ appearance: { ...DEFAULT_APPEARANCE } }),
}));
