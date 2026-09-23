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
  /** 写实预览：曝光 0.3..2 */
  exposure: number;
  /** 写实预览：环境反射强度 0..1.5 */
  envIntensity: number;
  /** 写实预览：主光/补光/轮廓光强度 */
  keyIntensity: number;
  fillIntensity: number;
  rimIntensity: number;
  hemiIntensity: number;
  toggleSkeleton: () => void;
  toggleGrid: () => void;
  toggleShadows: () => void;
  setFps: (fps: number) => void;
  setSkeletonColor: (c: string) => void;
  setGridSize: (n: number) => void;
  setGridCell: (c: string) => void;
  setGridSection: (c: string) => void;
  setShadowOpacity: (n: number) => void;
  setExposure: (n: number) => void;
  setEnvIntensity: (n: number) => void;
  setKeyIntensity: (n: number) => void;
  setFillIntensity: (n: number) => void;
  setRimIntensity: (n: number) => void;
  setHemiIntensity: (n: number) => void;
}

const isHex = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c);

const clamp = (v: number, lo: number, hi: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback;

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
  exposure: 1.0,
  envIntensity: 0.45,
  keyIntensity: 2.0,
  fillIntensity: 0.5,
  rimIntensity: 1.2,
  hemiIntensity: 0.5,
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
  setExposure: (n) => set({ exposure: clamp(n, 0.3, 2, 1.0) }),
  setEnvIntensity: (n) => set({ envIntensity: clamp(n, 0, 1.5, 0.45) }),
  setKeyIntensity: (n) => set({ keyIntensity: clamp(n, 0, 5, 2.0) }),
  setFillIntensity: (n) => set({ fillIntensity: clamp(n, 0, 3, 0.5) }),
  setRimIntensity: (n) => set({ rimIntensity: clamp(n, 0, 5, 1.2) }),
  setHemiIntensity: (n) => set({ hemiIntensity: clamp(n, 0, 2, 0.5) }),
}));
