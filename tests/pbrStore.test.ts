import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { useMaterialStore, isEmptyOverride } from '../src/stores/materialStore';
import { findMaterialByPath, listMaterials } from '../src/core/material/pbr';

function scene() {
  const root = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5 }));
  m.name = 'body';
  root.add(m);
  return root;
}

describe('材质覆盖 store', () => {
  beforeEach(() => {
    useMaterialStore.setState({ overrides: {}, originals: {}, appliedKey: null, busyKey: null, sceneRef: null });
  });

  it('覆盖按路径写入并能施加到材质', () => {
    const root = scene();
    const path = listMaterials(root)[0].path;
    useMaterialStore.getState().setOverride(path, { metalness: 0.9, roughness: 0.1 });
    const n = useMaterialStore.getState().applyTo(root);
    expect(n).toBe(1);
    const m = findMaterialByPath(root, path)!;
    expect(m.metalness).toBeCloseTo(0.9, 5);
    expect(m.roughness).toBeCloseTo(0.1, 5);
  });

  it('同一场景重复施加不重复计数（避免每帧重写材质）', () => {
    const root = scene();
    const path = listMaterials(root)[0].path;
    useMaterialStore.getState().setOverride(path, { metalness: 0.5 });
    expect(useMaterialStore.getState().applyTo(root)).toBe(1);
    expect(useMaterialStore.getState().applyTo(root)).toBe(0);
  });

  it('改覆盖后同场景会重新施加（PBR 面板滑块必须真的生效）', () => {
    // 回归测试：守卫曾只比较 scene.uuid，且 setOverride 不重置 appliedKey，
    // 导致首次施加之后所有滑块/贴图改动都被早退吞掉 —— 面板动了、画面不动。
    const root = scene();
    const path = listMaterials(root)[0].path;
    useMaterialStore.getState().setOverride(path, { metalness: 0.5 });
    expect(useMaterialStore.getState().applyTo(root)).toBe(1);

    // 同一场景，只改了 overrides
    useMaterialStore.getState().setOverride(path, { metalness: 0.95 });
    expect(useMaterialStore.getState().applyTo(root)).toBe(1);

    const m = findMaterialByPath(root, path)!;
    expect(m.metalness).toBeCloseTo(0.95, 6);
  });

  it('换角色（不同场景）会重新施加', () => {
    const a = scene(); const b = scene();
    const pa = listMaterials(a)[0].path;
    useMaterialStore.getState().setOverride(pa, { metalness: 0.7 });
    useMaterialStore.getState().applyTo(a);
    useMaterialStore.getState().applyTo(b); // 不同 uuid → 应该真的施加
    const mb = findMaterialByPath(b, listMaterials(b)[0].path)!;
    expect(mb.metalness).toBeCloseTo(0.7, 5);
  });

  it('覆盖是合并而非替换', () => {
    const root = scene();
    const path = listMaterials(root)[0].path;
    useMaterialStore.getState().setOverride(path, { metalness: 0.8 });
    useMaterialStore.getState().setOverride(path, { roughness: 0.2 });
    useMaterialStore.getState().applyTo(root);
    const m = findMaterialByPath(root, path)!;
    expect(m.metalness).toBeCloseTo(0.8, 5);
    expect(m.roughness).toBeCloseTo(0.2, 5);
  });

  it('路径失效（GLB 变了）时安全跳过，不崩', () => {
    const root = scene();
    useMaterialStore.getState().setOverride('99/99#0', { metalness: 0.5 });
    expect(useMaterialStore.getState().applyTo(root)).toBe(0);
  });

  it('clearAll 清空覆盖并把材质还原为 GLB 原值', () => {
    const root = scene();
    const path = listMaterials(root)[0].path;
    useMaterialStore.setState({ sceneRef: root });
    useMaterialStore.getState().setOverride(path, { metalness: 0.9 });
    useMaterialStore.getState().applyTo(root);
    expect(findMaterialByPath(root, path)!.metalness).toBeCloseTo(0.9, 5);

    useMaterialStore.getState().clearAll();
    expect(useMaterialStore.getState().overrides).toEqual({});
    // 覆盖没了，但要**把材质本身还原**，否则画面停在被改状态而面板显示「未改」
    // MeshStandardMaterial 默认 metalness = 0
    useMaterialStore.getState().applyTo(root);
    expect(findMaterialByPath(root, path)!.metalness).toBeCloseTo(0, 5);
  });

  it('replaceAll 用于项目打开（含贴图 dataURL）', () => {
    const root = scene();
    const path = listMaterials(root)[0].path;
    useMaterialStore.setState({ sceneRef: root });
    useMaterialStore.getState().replaceAll({ [path]: { metalness: 0.3, textures: { normalMap: 'data:image/png;base64,AAA' } } });
    const n = useMaterialStore.getState().applyTo(root);
    expect(n).toBe(1);
    const m = findMaterialByPath(root, path)!;
    expect(m.metalness).toBeCloseTo(0.3, 5);
    // 贴图是异步解码，但引用应该已经挂上
    expect(m.normalMap).toBeTruthy();
  });

  it('清空贴图用空串表示（与「未设置」区分）', () => {
    const root = scene();
    const path = listMaterials(root)[0].path;
    useMaterialStore.setState({ sceneRef: root });
    useMaterialStore.getState().setOverride(path, { textures: { normalMap: 'data:image/png;base64,AAA' } });
    useMaterialStore.getState().applyTo(root);
    useMaterialStore.getState().setTexture(path, 'normalMap', '');
    useMaterialStore.getState().clearAll(); // 触发 appliedKey 重置
    useMaterialStore.getState().setOverride(path, { textures: { normalMap: '' } });
    useMaterialStore.getState().applyTo(root);
    expect(findMaterialByPath(root, path)!.normalMap).toBeNull();
  });
});

describe('isEmptyOverride', () => {
  it('识别空覆盖', () => {
    expect(isEmptyOverride(undefined)).toBe(true);
    expect(isEmptyOverride({})).toBe(true);
    expect(isEmptyOverride({ textures: {} })).toBe(true);
    expect(isEmptyOverride({ metalness: 0 })).toBe(false);
    expect(isEmptyOverride({ textures: { map: 'x' } })).toBe(false);
  });
});
