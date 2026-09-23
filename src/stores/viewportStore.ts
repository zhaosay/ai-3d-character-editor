import { create } from 'zustand';

interface ViewportState {
  showSkeleton: boolean;
  showGrid: boolean;
  shadows: boolean;
  fps: number;
  toggleSkeleton: () => void;
  toggleGrid: () => void;
  toggleShadows: () => void;
  setFps: (fps: number) => void;
}

export const useViewportStore = create<ViewportState>((set) => ({
  showSkeleton: true,
  showGrid: true,
  shadows: true,
  fps: 0,
  toggleSkeleton: () => set((s) => ({ showSkeleton: !s.showSkeleton })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleShadows: () => set((s) => ({ shadows: !s.shadows })),
  setFps: (fps) => set({ fps }),
}));
