import { create } from 'zustand';

export type InbetweenId = 'math' | 'ai';

interface InbetweenConfig {
  providerId: InbetweenId;
  setProvider: (p: InbetweenId) => void;
}

export const useInbetweenStore = create<InbetweenConfig>((set) => ({
  providerId: 'math',
  setProvider: (providerId) => set({ providerId }),
}));
