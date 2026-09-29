import { create } from 'zustand';
import { DEFAULT_FOOT_LOCK, type FootLockConfig } from '../core/ik/footLock';

/**
 * 足部锁定开关。默认关闭：它会覆盖程序化步态的足部旋转，
 * 对手工 K 过的动画不合适（会把手摆的脚钉住），需用户显式开启。
 */
interface FootLockState {
  enabled: boolean;
  config: FootLockConfig;
  /** 诊断：本帧两只脚的累计打滑（米） */
  slipMeters: number;
  setEnabled: (v: boolean) => void;
  setConfig: (patch: Partial<FootLockConfig>) => void;
  setSlip: (m: number) => void;
}

export const useFootLockStore = create<FootLockState>((set) => ({
  enabled: false,
  config: { ...DEFAULT_FOOT_LOCK },
  slipMeters: 0,
  setEnabled: (enabled) => set({ enabled }),
  setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
  setSlip: (slipMeters) => set({ slipMeters }),
}));
