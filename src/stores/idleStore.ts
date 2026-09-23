import { create } from 'zustand';

interface IdleState {
  /** 自动眨眼（实时 morph 层，不进关键帧） */
  blinkEnabled: boolean;
  setBlinkEnabled: (v: boolean) => void;
}

export const useIdleStore = create<IdleState>((set) => ({
  blinkEnabled: false,
  setBlinkEnabled: (blinkEnabled) => set({ blinkEnabled }),
}));
