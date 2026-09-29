import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ProviderId = 'mock' | 'http';

// A LAN browser's 127.0.0.1 is the visitor's own device, not this Mac.
// Resolve the companion API from the page host so a new LAN visitor can use
// the scheduler-launched editor without manually replacing the URL.
const defaultMotionApiBase = typeof window === 'undefined'
  ? 'http://127.0.0.1:8123'
  : `http://${window.location.hostname}:8123`;

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
      baseUrl: defaultMotionApiBase,
      setProvider: (providerId) => set({ providerId }),
      setBaseUrl: (baseUrl) => set({ baseUrl }),
    }),
    { name: 'motion-config' },
  ),
);
