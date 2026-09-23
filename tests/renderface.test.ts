import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { useViewportStore } from '../src/stores/viewportStore';
import { buildPreviewEnv } from '../src/core/render/previewEnv';
import { hasMorphTargets, listMorphTargets, resetMorphs, setMorphInfluence, findBlinkTargets, blinkWeight, BLINK_PERIOD } from '../src/core/face/morphs';

describe('render store 钳制', () => {
  it('曝光/灯光越界钳制，非法值回退', () => {
    const s = useViewportStore.getState();
    s.setExposure(99);
    expect(useViewportStore.getState().exposure).toBe(2);
    s.setExposure(Number.NaN);
    expect(useViewportStore.getState().exposure).toBe(1.0);
    s.setKeyIntensity(-5);
    expect(useViewportStore.getState().keyIntensity).toBe(0);
    s.setEnvIntensity(9);
    expect(useViewportStore.getState().envIntensity).toBe(1.5);
    s.setExposure(1.0);
  });
});

describe('buildPreviewEnv', () => {
  it('内置摄影棚：深色房 + 4 发光板', () => {
    const scene = buildPreviewEnv();
    expect(scene.background).toBeDefined();
    const panels = scene.children.filter((o) => (o as THREE.Mesh).isMesh);
    expect(panels).toHaveLength(4);
    for (const p of panels) {
      const mat = (p as THREE.Mesh).material as THREE.MeshBasicMaterial;
      expect(mat.color.r + mat.color.g + mat.color.b).toBeGreaterThan(0.5);
    }
  });
});

function morphMesh(): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mkTarget = (dy: number) => {
    const t = geo.attributes['position'].clone() as THREE.BufferAttribute;
    for (let i = 0; i < t.count; i++) t.setY(i, t.getY(i) + dy);
    return t;
  };
  geo.morphAttributes.position = [mkTarget(0.5), mkTarget(-0.3)];
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  mesh.name = 'Face';
  mesh.updateMorphTargets();
  mesh.morphTargetDictionary = { blink_L: 0, smile: 1 };
  g.add(mesh);
  return g;
}

describe('face morphs', () => {
  it('无 morph 的场景返回空并隐藏', () => {
    const g = new THREE.Group();
    expect(hasMorphTargets(g)).toBe(false);
    expect(listMorphTargets(g)).toEqual([]);
    expect(resetMorphs(g)).toBe(0);
  });

  it('列出/设置/钳制/重置', () => {
    const g = morphMesh();
    expect(hasMorphTargets(g)).toBe(true);
    const list = listMorphTargets(g);
    expect(list.map((m) => m.name).sort()).toEqual(['blink_L', 'smile']);
    const meshUuid = list[0].meshUuid;
    expect(setMorphInfluence(g, meshUuid, 0, 0.7)).toBeCloseTo(0.7, 5);
    expect(setMorphInfluence(g, meshUuid, 0, 9)).toBe(1);
    expect(setMorphInfluence(g, meshUuid, 0, -2)).toBe(0);
    expect(() => setMorphInfluence(g, meshUuid, 99, 0.5)).toThrow(/越界/);
    expect(() => setMorphInfluence(g, 'nope', 0, 0.5)).toThrow(/无 morph/);
    expect(resetMorphs(g)).toBe(2);
    expect(listMorphTargets(g).every((m) => m.value === 0)).toBe(true);
  });
});

describe('blink', () => {
  it('目标匹配 ARKit 命名', () => {
    const targets = [
      { meshUuid: 'a', meshName: 'Head', index: 0, name: 'eyeBlinkLeft', value: 0 },
      { meshUuid: 'a', meshName: 'Head', index: 1, name: 'eyeBlinkRight', value: 0 },
      { meshUuid: 'a', meshName: 'Head', index: 2, name: 'mouthSmile', value: 0 },
    ];
    const found = findBlinkTargets(targets);
    expect(found.map((f) => f.name).sort()).toEqual(['eyeBlinkLeft', 'eyeBlinkRight']);
  });

  it('确定性时序：周期峰值≈1，其余为 0', () => {
    expect(blinkWeight(0)).toBe(0);
    expect(blinkWeight(1)).toBe(0);
    const peak = BLINK_PERIOD * (0.86 + 0.11 / 2);
    expect(blinkWeight(peak)).toBeCloseTo(1, 5);
    expect(blinkWeight(peak)).toBe(blinkWeight(peak + BLINK_PERIOD));
    expect(blinkWeight(-1)).toBe(blinkWeight(BLINK_PERIOD - 1));
  });
});
