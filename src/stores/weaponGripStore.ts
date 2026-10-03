import { create } from 'zustand';

interface WeaponGripState {
  /** 持剑时是否启用双手握持解算（默认开：单臂摆动不是双手剑术） */
  enabled: boolean;
  /**
   * 柄尾偏差超过此值即视为「脱手」，用于 UI 报警。
   * 注意：目前**只做存储与比较，未接报警 UI** —— 别假设它已经在生效。
   */
  slipThresholdM: number;
  /**
   * 最近一次解算的柄尾偏差（米）/ 是否两边都真正够到（未被 IK 钳制）。
   * 由 `applyHeldGrip.solveHeldSwordGrip` 写入；生产路径走 `SwordGripRuntime`
   * 时**不会**更新这两个值（见该文件说明）。
   */
  lastOffToPommelM: number | null;
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