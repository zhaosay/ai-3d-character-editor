import { create } from 'zustand';

interface ViewportState {
  showSkeleton: boolean;
  showGrid: boolean;
  shadows: boolean;
  fps: number;
  /** 骨骼线 tint（#ffffff = 原色） */
  skeletonColor: string;
  gridSize: number;
  gridCell: string;
  gridSection: string;
  /** 地面阴影强度 0..0.8 */
  shadowOpacity: number;
  toggleSkeleton: () => void;
  toggleGrid: () => void;
  toggleShadows: () => void;
  setFps: (fps: number) => void;
  setSkeletonColor: (c: string) => void;
  setGridSize: (n: number) => void;
  setGridCell: (c: string) => void;
  setGridSection: (c: string) => void;
  setShadowOpacity: (n: number) => void;
}

const isHex = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c);

export const useViewportStore = create<ViewportState>((set) => ({
  showSkeleton: true,
  showGrid: true,
  shadows: true,
  fps: 0,
  skeletonColor: '#ffffff',
  gridSize: 30,
  gridCell: '#d9dfe7',
  gridSection: '#a9b4c2',
  shadowOpacity: 0.35,
  toggleSkeleton: () => set((s) => ({ showSkeleton: !s.showSkeleton })),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleShadows: () => set((s) => ({ shadows: !s.shadows })),
  setFps: (fps) => set({ fps }),
  setSkeletonColor: (c) => {
    if (isHex(c)) set({ skeletonColor: c });
  },
  setGridSize: (n) => {
    if ([10, 20, 30, 50].includes(n)) set({ gridSize: n });
  },
  setGridCell: (c) => {
    if (isHex(c)) set({ gridCell: c });
  },
  setGridSection: (c) => {
    if (isHex(c)) set({ gridSection: c });
  },
  setShadowOpacity: (n) => {
    if (Number.isFinite(n)) set({ shadowOpacity: Math.min(Math.max(n, 0), 0.8) });
  },
}));
