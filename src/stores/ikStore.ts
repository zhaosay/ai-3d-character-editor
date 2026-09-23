import { create } from 'zustand';
import type { IKChainDef, IKChainId, IKSolveInfo } from '../core/ik/types';
import type { Vec3Tuple } from '../types/global';

export interface ChainState {
  def: IKChainDef;
  enabled: boolean;
  target: Vec3Tuple;
  polePoint: Vec3Tuple;
  /** 外部修改计数（手柄靠它区分内/外写入，避免回环） */
  rev: number;
  lastSolve: IKSolveInfo | null;
}

interface IKState {
  chains: Record<IKChainId, ChainState | undefined>;
  initChains: (defs: IKChainDef[]) => void;
  clear: () => void;
  toggleChain: (id: IKChainId) => void;
  setTarget: (id: IKChainId, v: Vec3Tuple) => void;
  setPolePoint: (id: IKChainId, v: Vec3Tuple) => void;
  resetChain: (id: IKChainId) => void;
  setLastSolve: (id: IKChainId, info: IKSolveInfo) => void;
  enabledCount: () => number;
}

export const useIKStore = create<IKState>((set, get) => ({
  chains: { 'arm.L': undefined, 'arm.R': undefined, 'leg.L': undefined, 'leg.R': undefined },

  initChains: (defs) =>
    set(() => {
      const chains: Record<IKChainId, ChainState | undefined> = {
        'arm.L': undefined,
        'arm.R': undefined,
        'leg.L': undefined,
        'leg.R': undefined,
      };
      for (const def of defs) {
        chains[def.id] = {
          def,
          enabled: false,
          target: [...def.defaultTarget] as Vec3Tuple,
          polePoint: [...def.defaultPolePoint] as Vec3Tuple,
          rev: 0,
          lastSolve: null,
        };
      }
      return { chains };
    }),

  clear: () =>
    set({
      chains: { 'arm.L': undefined, 'arm.R': undefined, 'leg.L': undefined, 'leg.R': undefined },
    }),

  toggleChain: (id) =>
    set((s) => {
      const c = s.chains[id];
      if (!c) return s;
      return { chains: { ...s.chains, [id]: { ...c, enabled: !c.enabled } } };
    }),

  setTarget: (id, v) =>
    set((s) => {
      const c = s.chains[id];
      if (!c) return s;
      return { chains: { ...s.chains, [id]: { ...c, target: [...v] as Vec3Tuple, rev: c.rev + 1 } } };
    }),

  setPolePoint: (id, v) =>
    set((s) => {
      const c = s.chains[id];
      if (!c) return s;
      return { chains: { ...s.chains, [id]: { ...c, polePoint: [...v] as Vec3Tuple, rev: c.rev + 1 } } };
    }),

  resetChain: (id) =>
    set((s) => {
      const c = s.chains[id];
      if (!c) return s;
      return {
        chains: {
          ...s.chains,
          [id]: {
            ...c,
            target: [...c.def.defaultTarget] as Vec3Tuple,
            polePoint: [...c.def.defaultPolePoint] as Vec3Tuple,
            rev: c.rev + 1,
          },
        },
      };
    }),

  setLastSolve: (id, info) =>
    set((s) => {
      const c = s.chains[id];
      if (!c) return s;
      const prev = c.lastSolve;
      if (prev && prev.reached === info.reached && Math.abs(prev.hingeDeg - info.hingeDeg) < 0.5) return s;
      return { chains: { ...s.chains, [id]: { ...c, lastSolve: info } } };
    }),

  enabledCount: () => Object.values(get().chains).filter((c) => c?.enabled).length,
}));
