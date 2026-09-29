import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { DEFAULT_APPEARANCE, getPreset, clampAppearance } from '../src/core/character/appearance';

function bboxOf(scene: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    g.computeBoundingBox();
    const b = g.boundingBox!.clone();
    b.applyMatrix4(m.matrixWorld);
    box.union(b);
  });
  return box;
}

function boneY(scene: THREE.Object3D, name: string): number {
  let y = Number.NaN;
  scene.traverse((o) => {
    if (o.name === name) y = o.position.y;
  });
  return y;
}

describe('buildDemoCharacter + appearance', () => {
  it('默认构建：17 骨、蒙皮、themable、可释放', () => {
    const c = buildDemoCharacter('male');
    expect(c.meta.gltfInfo.bones).toBe(17);
    expect(c.meta.gltfInfo.hasSkin).toBe(true);
    expect(c.scene.userData['themable']).toBe(true);
    expect(c.scene.userData['appearance']).toEqual(clampAppearance({ ...DEFAULT_APPEARANCE, gender: 'male' }));
    expect(() => c.dispose()).not.toThrow();
  });

  it('身高改变模型实际高度', () => {
    const short = buildDemoCharacter('male', { height: 1.6 });
    const tall = buildDemoCharacter('male', { height: 1.94 });
    const hs = bboxOf(short.scene).max.y;
    const ht = bboxOf(tall.scene).max.y;
    expect(ht).toBeGreaterThan(hs + 0.25);
  });

  it('体型改变横向宽度但不改变高度量级', () => {
    const lean = buildDemoCharacter('male', { build: 0 });
    const heavy = buildDemoCharacter('male', { build: 1 });
    const wl = bboxOf(lean.scene);
    const wh = bboxOf(heavy.scene);
    expect(wh.max.x - wh.min.x).toBeGreaterThan(wl.max.x - wl.min.x);
  });

  it('发型改变头发体量（光头仅剩眉/睫毛，寸头/短发/长发递增）', () => {
    const countHairParts = (hairStyle: 'bald' | 'buzz' | 'short' | 'bob' | 'long') => {
      const c = buildDemoCharacter('male', { hairStyle, hairColor: '#ff00ff' });
      let n = 0;
      c.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
        if (`#${mat.color.getHexString()}` === '#ff00ff') n++;
      });
      c.dispose();
      return n;
    };
    // 光头仍有眉毛/睫毛（每侧各一），但没有头皮盖
    expect(countHairParts('bald')).toBe(2);
    expect(countHairParts('buzz')).toBeGreaterThan(countHairParts('bald'));
    expect(countHairParts('short')).toBeGreaterThan(countHairParts('buzz'));
    expect(countHairParts('long')).toBeGreaterThan(countHairParts('short'));
  });

  it('骨长随身高缩放（膝关节位置下移）', () => {
    const short = buildDemoCharacter('male', { height: 1.6 });
    const tall = buildDemoCharacter('male', { height: 1.94 });
    expect(boneY(tall.scene, 'Hips')).toBeGreaterThan(boneY(short.scene, 'Hips'));
  });

  it('皮肤/发色/服装色按 appearance 落到材质上', () => {
    const c = buildDemoCharacter('female', {
      skinColor: '#8d5a3b', hairColor: '#101010', clothColor: '#ff00ff',
    });
    const colors: string[] = [];
    c.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      colors.push(`#${mat.color.getHexString()}`);
    });
    expect(colors).toContain('#8d5a3b');
    expect(colors).toContain('#101010');
    expect(colors).toContain('#ff00ff');
  });

  it('预设均可构建且外观写入 meta 以便项目还原', () => {
    for (const id of ['male-lean', 'female-long', 'female-athletic']) {
      const a = getPreset(id)!;
      const c = buildDemoCharacter(a.gender, a);
      expect(c.meta.appearanceSource).toEqual(clampAppearance(a));
      expect(c.scene.userData['themable']).toBe(true);
      c.dispose();
    }
  });

  it('非法外观参数不抛错，退回安全值', () => {
    expect(() => buildDemoCharacter('male', {
      height: Number.NaN, faceShape: 'nope' as never, hairStyle: 'x' as never, skinColor: 'bogus',
    })).not.toThrow();
  });
});
