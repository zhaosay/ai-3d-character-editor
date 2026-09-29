import { describe, expect, it, vi } from 'vitest';
import type { CharacterMeta } from '../src/types/global';
import { deactivateCharacter, activateCharacter, reconcileProjectCharacter } from '../src/components/character/activateCharacter';
import * as THREE from 'three';
import { useCharacterStore } from '../src/stores/characterStore';
import { useSkeletonStore } from '../src/stores/skeletonStore';
import { useSelectionStore } from '../src/stores/selectionStore';
import { useIKStore } from '../src/stores/ikStore';
import { useHistoryStore } from '../src/stores/historyStore';
import { useAnimationStore } from '../src/stores/animationStore';
import { createEmptyAnimation } from '../src/core/animation/types';

const character = (overrides: Partial<CharacterMeta> = {}): CharacterMeta => ({
  id: 'character-a',
  fileName: 'a.glb',
  fileSize: 1200,
  gltfInfo: { meshes: 2, materials: 1, bones: 17, hasSkin: true, hasAnimations: 0 },
  ...overrides,
});

describe('reconcile project character', () => {
  it('keeps the loaded character only when its file identity matches the project', () => {
    const clear = vi.fn();
    const rebuildSketch = vi.fn();

    const result = reconcileProjectCharacter(character(), character(), { clear, rebuildSketch });

    expect(result).toBe('match');
    expect(clear).not.toHaveBeenCalled();
    expect(rebuildSketch).not.toHaveBeenCalled();
  });

  it('clears a different loaded GLB before exposing the opened project animation', () => {
    const clear = vi.fn();
    const rebuildSketch = vi.fn();

    const result = reconcileProjectCharacter(character({ fileName: 'b.glb' }), character(), { clear, rebuildSketch });

    expect(result).toBe('mismatch');
    expect(clear).toHaveBeenCalledOnce();
    expect(rebuildSketch).not.toHaveBeenCalled();
  });

  it('clears the loaded character when the project has no character reference', () => {
    const clear = vi.fn();
    const rebuildSketch = vi.fn();

    const result = reconcileProjectCharacter(null, character(), { clear, rebuildSketch });

    expect(result).toBe('missing');
    expect(clear).toHaveBeenCalledOnce();
    expect(rebuildSketch).not.toHaveBeenCalled();
  });

  it('rebuilds a saved sketch character and returns without clearing it', () => {
    const sketch = character({ sketchSource: {
      landmarks: {
        head: { x: 200, y: 40 }, neck: { x: 200, y: 110 }, shoulder: { x: 150, y: 130 },
        elbow: { x: 140, y: 220 }, wrist: { x: 145, y: 300 }, hips: { x: 200, y: 280 },
        knee: { x: 195, y: 390 }, ankle: { x: 195, y: 500 },
      },
      options: { headR: 0.115, thickness: 1 },
    } });
    const clear = vi.fn();
    const rebuildSketch = vi.fn();

    const result = reconcileProjectCharacter(sketch, character(), { clear, rebuildSketch });

    expect(result).toBe('sketch-restored');
    expect(rebuildSketch).toHaveBeenCalledWith(sketch);
    expect(clear).not.toHaveBeenCalled();
  });

  it('releases the old role and resets role-bound editor state without discarding project animations', () => {
    const dispose = vi.fn();
    const animation = createEmptyAnimation('project action');
    useAnimationStore.setState({ animations: [animation], activeId: animation.id, playing: true, currentTime: 2 });
    useSelectionStore.getState().select('old-bone');
    useHistoryStore.setState({ past: [[animation]], future: [[animation]], pastContext: [], futureContext: [] });
    useIKStore.getState().initChains([]);
    activateCharacter(character(), new THREE.Group(), dispose);

    deactivateCharacter();

    expect(dispose).toHaveBeenCalledOnce();
    expect(useCharacterStore.getState().meta).toBeNull();
    expect(useCharacterStore.getState().sceneObject).toBeNull();
    expect(useSkeletonStore.getState().snapshot).toBeNull();
    expect(useSelectionStore.getState().selectedBoneId).toBeNull();
    expect(useIKStore.getState().enabledCount()).toBe(0);
    expect(useHistoryStore.getState().past).toEqual([]);
    expect(useHistoryStore.getState().future).toEqual([]);
    expect(useAnimationStore.getState()).toMatchObject({
      animations: [animation], playing: false, currentTime: 0,
    });
  });
});
