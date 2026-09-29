import { create } from 'zustand';
import { sanitizeEffectEvent, type BladeSweepSample, type PrevisEffectEvent, type PrevisEffectKind } from '../core/previs/effects';

interface EffectsState {
  events: PrevisEffectEvent[];
  add: (kind: PrevisEffectKind, time: number, animationId?: string, position?: PrevisEffectEvent['position'], actionIndex?: number, path?: PrevisEffectEvent['path'], bladeSweep?: BladeSweepSample[]) => string;
  update: (id: string, patch: Partial<Omit<PrevisEffectEvent, 'id'>>) => void;
  remove: (id: string) => void;
  replace: (events: PrevisEffectEvent[]) => void;
  clear: () => void;
}

const defaults: Record<PrevisEffectKind, Pick<PrevisEffectEvent, 'duration' | 'scale' | 'color'>> = {
  slash: { duration: 0.35, scale: 0.8, color: '#7dd3fc' },
  impact: { duration: 0.24, scale: 0.45, color: '#fbbf24' },
  dust: { duration: 0.8, scale: 0.7, color: '#c4b5a5' },
  spark: { duration: 0.3, scale: 0.55, color: '#ffd166' },
  smoke: { duration: 1.4, scale: 0.8, color: '#9aa4b2' },
  energy: { duration: 0.6, scale: 0.9, color: '#4de1c1' },
};

const defaultPositions: Record<PrevisEffectKind, PrevisEffectEvent['position']> = {
  slash: [0, 1, 0], impact: [0, 1, 0], dust: [0, 0.04, 0],
  spark: [0, 1, 0], smoke: [0, 0.35, 0], energy: [0, 1, 0],
};

export const useEffectsStore = create<EffectsState>((set) => ({
  events: [],
  add: (kind, time, animationId, position, actionIndex, path, bladeSweep) => {
    const id = `fx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({ events: [...state.events, {
      id, kind, time, animationId, actionIndex, position: position ?? defaultPositions[kind], path, bladeSweep, ...defaults[kind],
    }] }));
    return id;
  },
  update: (id, patch) => set((state) => ({ events: state.events.map((event) => event.id === id
    ? sanitizeEffectEvent({ ...event, ...patch }) ?? event : event) })),
  remove: (id) => set((state) => ({ events: state.events.filter((event) => event.id !== id) })),
  replace: (events) => set({ events: events.map((event) => sanitizeEffectEvent(event)).filter((event): event is PrevisEffectEvent => event !== null) }),
  clear: () => set({ events: [] }),
}));
