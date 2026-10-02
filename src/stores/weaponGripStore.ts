import { create } from 'zustand';

interface WeaponGripState {
  /** 持剑时是否启用双手握持解算（默认开：单臂摆动不是双手剑术） */
  enabled: boolean;
  /** 连续两帧握持偏差超阈值即视为脱手（米） */
  slipThresholdM: number;
  /** 最近一次解算的柄尾偏差（米）；null 表示未解算 */
  lastOffToPommelM: number | null;
  /** 最近一次是否两边都真正够到（未被 IK 钳制） */
  lastReached: boolean | null;
  setEnabled: (v: boolean) => void;
  setLast: (offToPommelM: number, reached: boolean) => void;
  clear: () => void;
}

const DEFAULT_THRESHOLD = 0.03;

export const useWeaponGripStore = create<WeaponGripState>((set) => ({
  enabled: true,
  slipThresholdM: DEFAULT_THRESHOLD,
  lastOffToPommelM: null,
  lastReached: null,
  setEnabled: (v) => set({ enabled: v }),
  setLast: (offToPommelM, reached) => set({ lastOffToPommelM: offToPommelM, lastReached: reached }),
  clear: () => set({ lastOffToPommelM: null, lastReached: null }),
}));