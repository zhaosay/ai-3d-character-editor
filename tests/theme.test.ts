import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';
import { collectThemedMaterials, isThemable, readTheme, setThemeColor } from '../src/core/theme/theme';

describe('theme core', () => {
  it('示例角色可换肤，外部场景不可', () => {
    const { scene } = buildDemoCharacter('male');
    expect(isThemable(scene)).toBe(true);
    expect(isThemable(new THREE.Group())).toBe(false);
    expect(readTheme(new THREE.Group())).toBeNull();
  });

  it('读取原生色 + 设置肤色/服装色', () => {
    const { scene } = buildDemoCharacter('female');
    const native = readTheme(scene)!;
    expect(native.skin).toMatch(/^#[0-9a-f]{6}$/);
    expect(native.cloth).toMatch(/^#[0-9a-f]{6}$/);

    const clothBefore = collectThemedMaterials(scene).cloth.map((m) => `#${m.color.getHexString()}`);

    const r1 = setThemeColor(scene, 'skin', '#c8956c');
    expect(r1.applied).toBeGreaterThan(0);
    const { skin } = collectThemedMaterials(scene);
    expect(skin.length).toBeGreaterThan(0);
    for (const m of skin) expect(`#${m.color.getHexString()}`).toBe('#c8956c');
    // 服装不受影响（逐材质对比）
    const clothAfter = collectThemedMaterials(scene).cloth.map((m) => `#${m.color.getHexString()}`);
    expect(clothAfter).toEqual(clothBefore);

    const r2 = setThemeColor(scene, 'cloth', '#123456');
    expect(r2.applied).toBeGreaterThan(0);
  });

  it('非法颜色与非示例角色抛错（不静默失败）', () => {
    const { scene } = buildDemoCharacter('male');
    expect(() => setThemeColor(scene, 'skin', 'red')).toThrow(/非法颜色/);
    expect(() => setThemeColor(scene, 'skin', '#12345')).toThrow(/非法颜色/);
    expect(() => setThemeColor(new THREE.Group(), 'skin', '#ffffff')).toThrow(/不支持换肤/);
  });

  it('材质按实例克隆：改色不污染下一次构建', () => {
    const a = buildDemoCharacter('male');
    setThemeColor(a.scene, 'skin', '#111111');
    const b = buildDemoCharacter('male');
    expect(readTheme(b.scene)?.skin).not.toBe('#111111');
    a.dispose();
    b.dispose();
  });
});
