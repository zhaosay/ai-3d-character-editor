import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ProviderId = 'mock' | 'http';

interface MotionConfig {
  providerId: ProviderId;
  baseUrl: string;
  setProvider: (p: ProviderId) => void;
  setBaseUrl: (u: string) => void;
}

export const useMotionStore = create<MotionConfig>()(
  persist(
    (set) => ({
      providerId: 'mock',
      baseUrl: 'http://127.0.0.1:8123',
      setProvider: (providerId) => set({ providerId }),
      setBaseUrl: (baseUrl) => set({ baseUrl }),
    }),
    { name: 'motion-config' },
  ),
);
