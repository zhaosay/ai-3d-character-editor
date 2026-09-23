import type { AnimationData } from '../animation/types';
import type { CharacterMeta } from '../../types/global';
import type { SkeletonSnapshot } from '../skeleton/types';

// P1 冻结 project schema v1（Save/Open UI 在 P4）。
export interface ProjectV1 {
  version: '1.0';
  character: CharacterMeta | null;
  skeleton: SkeletonSnapshot | null;
  animations: AnimationData[];
  scene: { bg: string; grid: boolean; shadows: boolean };
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
  settings: { fps: 30 | 60; loop: boolean };
}

export function createEmptyProject(): ProjectV1 {
  return {
    version: '1.0',
    character: null,
    skeleton: null,
    animations: [],
    scene: { bg: '#0b0d12', grid: true, shadows: true },
    camera: { position: [2.5, 1.8, 3.2], target: [0, 1, 0], fov: 45 },
    settings: { fps: 30, loop: true },
  };
}

export function validateProject(p: ProjectV1): string[] {
  const errors: string[] = [];
  if (p.version !== '1.0') errors.push(`unsupported version ${p.version}`);
  return errors;
}
