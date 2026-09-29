import { create } from 'zustand';

interface ThemeState {
  skin: string;
  cloth: string;
  nativeSkin: string;
  nativeCloth: string;
  setSkin: (hex: string) => void;
  setCloth: (hex: string) => void;
  /** 角色切换时以其原生色初始化 */
  init: (nativeSkin: string, nativeCloth: string) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  skin: '#d0a080',
  cloth: '#607979',
  nativeSkin: '#d0a080',
  nativeCloth: '#607979',
  setSkin: (skin) => set({ skin }),
  setCloth: (cloth) => set({ cloth }),
  init: (nativeSkin, nativeCloth) => set({ skin: nativeSkin, cloth: nativeCloth, nativeSkin, nativeCloth }),
}));
