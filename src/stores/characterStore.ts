import { create } from 'zustand';
import * as THREE from 'three';
import type { CharacterMeta } from '../types/global';

interface CharacterState {
  meta: CharacterMeta | null;
  objectUrl: string | null;
  sceneObject: THREE.Group | null;
  error: string | null;
  setCharacter: (meta: CharacterMeta, obj: THREE.Group) => void;
  setError: (e: string | null) => void;
  clear: () => void;
}

export const useCharacterStore = create<CharacterState>((set) => ({
  meta: null,
  objectUrl: null,
  sceneObject: null,
  error: null,
  setCharacter: (meta, obj) => set({ meta, sceneObject: obj, error: null }),
  setError: (error) => set({ error }),
  clear: () => set({ meta: null, sceneObject: null, error: null }),
}));
