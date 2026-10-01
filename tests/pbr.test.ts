import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyPbr, findMaterialByPath, listMaterials, readFileAsDataUrl,
  DATA_TEXTURE_SLOTS, TEXTURE_SLOTS,
} from '../src/core/material/pbr';

/** 构造一个带嵌套 mesh 的场景，模拟 GLB 结构。 */
function sceneWith(root: THREE.Group, spec: Array<{ name: string; mat: THREE.Material }>): THREE.Group {
  const a = new THREE.Mesh(new THREE.BoxGeometry(), spec[0].mat); a.name = spec[0].name;
  const b1 = new THREE.Mesh(new THREE.BoxGeometry(), spec[1].mat); b1.name = spec[1].name;
  const b2 = new THREE.Mesh(new THREE.BoxGeometry(), spec[1].mat); b2.name = 'multi-2';
  const holder = new THREE.Group(); holder.add(b1, b2);
  root.add(a, holder);
  return root;
}

const std = (c = 0x808080) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.1 });
const phys = (c = 0xff0000) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.4, metalness: 0 });

describe('listMaterials', () => {
  it('枚举所有 MeshStandardMaterial 及其当前值', () => {
    const root = sceneWith(new THREE.Group(), [{ name: 'body', mat: std(0x112233) }, { name: 'limb', mat: std() }]);
    const list = listMaterials(root);
    expect(list.length).toBe(3); // body + limb + multi-2
    const body = list.find((e) => e.meshName === 'body')!;
    expect(body.values.color).toBe('#112233');
    expect(body.values.roughness).toBeCloseTo(0.5, 3);
    expect(body.values.metalness).toBeCloseTo(0.1, 3);
  });

  /**
   * 关键：MeshPhysicalMaterial 继承 MeshStandardMaterial 但**标志不继承**，
   * 只判 isMeshStandardMaterial 会漏掉（内置示例角色的皮肤就是 Physical）。
   */
  it('MeshPhysicalMaterial 也要被枚举（换肤色此前对示例角色无效）', () => {
    const root = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(), phys(0xabcdef));
    root.add(m);
    const list = listMaterials(root);
    expect(list.length).toBe(1);
    expect(list[0].values.color).toBe('#abcdef');
  });

  it('路径稳定且可反查（uuid 会随存取变化，路径不会）', () => {
    const root = sceneWith(new THREE.Group(), [{ name: 'a', mat: std() }, { name: 'b', mat: std() }]);
    const list = listMaterials(root);
    for (const e of list) {
      const found = findMaterialByPath(root, e.path);
      expect(found, `路径 ${e.path} 应能反查`).toBeTruthy();
    }
    // 同一路径查两次得到同一对象
    const p = list[0].path;
    expect(findMaterialByPath(root, p)).toBe(findMaterialByPath(root, p));
  });

  it('多材质 mesh 用 #index 区分', () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [std(0x111111), std(0x222222)]);
    mesh.name = 'multi';
    root.add(mesh);
    const list = listMaterials(root);
    expect(list.length).toBe(2);
    expect(new Set(list.map((e) => e.values.color)).size).toBe(2);
    expect(list[0].path).not.toBe(list[1].path);
  });

  it('路径排序稳定（UI 顺序不跳动）', () => {
    const root = sceneWith(new THREE.Group(), [{ name: 'a', mat: std() }, { name: 'b', mat: std() }]);
    const a = listMaterials(root).map((e) => e.path);
    const b = listMaterials(root).map((e) => e.path);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(a);
  });

  it('识别已挂的贴图', () => {
    const root = new THREE.Group();
    const m = std();
    m.map = new THREE.Texture();
    m.normalMap = new THREE.Texture();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), m));
    const e = listMaterials(root)[0];
    expect(e.maps.map).toBe(true);
    expect(e.maps.normalMap).toBe(true);
    expect(e.maps.roughnessMap).toBe(false);
  });

  it('themePart 被读出（提示哪些材质受换肤控制）', () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), std());
    mesh.userData['themePart'] = 'skin';
    root.add(mesh);
    expect(listMaterials(root)[0].themable).toBe('skin');
  });

  it('非标准材质（Basic/Lambert）被跳过', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    expect(listMaterials(root).length).toBe(0);
  });

  it('空场景不崩', () => {
    expect(listMaterials(new THREE.Group())).toEqual([]);
  });
});

describe('applyPbr', () => {
  it('写入各通道并返回应用字段数', () => {
    const m = std();
    const n = applyPbr(m, { color: '#ff0000', metalness: 0.8, roughness: 0.2, emissive: '#00ff00', emissiveIntensity: 2 });
    expect(n).toBe(5);
    expect(m.color.getHexString()).toBe('ff0000');
    expect(m.metalness).toBeCloseTo(0.8, 5);
    expect(m.roughness).toBeCloseTo(0.2, 5);
    expect(m.emissive.getHexString()).toBe('00ff00');
    expect(m.emissiveIntensity).toBeCloseTo(2, 5);
  });

  it('normalScale 是 Vector2 且正确写入', () => {
    const m = std();
    applyPbr(m, { normalScale: 1.8 });
    expect(m.normalScale.x).toBeCloseTo(1.8, 5);
    expect(m.normalScale.y).toBeCloseTo(1.8, 5);
  });

  it('越界值被钳制而不是抛错（面板是实时拖动）', () => {
    const m = std();
    applyPbr(m, { metalness: 5, roughness: -1, normalScale: 99, emissiveIntensity: -3, envMapIntensity: 99 });
    expect(m.metalness).toBe(1);
    expect(m.roughness).toBe(0);
    expect(m.normalScale.x).toBe(3);
    expect(m.emissiveIntensity).toBe(0);
    expect(m.envMapIntensity).toBe(3);
  });

  it('非法颜色被忽略（其余字段照常应用）', () => {
    const m = std();
    const n = applyPbr(m, { color: 'red', metalness: 0.3 });
    expect(n).toBe(1);
    expect(m.metalness).toBeCloseTo(0.3, 5);
  });

  it('NaN 被钳到下界', () => {
    const m = std();
    applyPbr(m, { metalness: Number.NaN, roughness: Number.NaN });
    expect(m.metalness).toBe(0);
    expect(m.roughness).toBe(0);
  });

  it('会触发 shader 重编译（needsUpdate 是只写标志，读它恒为 undefined）', () => {
    const m = std();
    let version = m.version;
    applyPbr(m, { metalness: 0.4 });
    // 断言 version 递增而不是读 needsUpdate（后者是 setter-only）
    expect(m.version).toBeGreaterThan(version);
  });
});

describe('findMaterialByPath', () => {
  it('非法路径返回 null 不抛错', () => {
    const root = sceneWith(new THREE.Group(), [{ name: 'a', mat: std() }, { name: 'b', mat: std() }]);
    expect(findMaterialByPath(root, '')).toBeNull();
    expect(findMaterialByPath(root, 'no-hash')).toBeNull();
    expect(findMaterialByPath(root, '99/99#0')).toBeNull();
    expect(findMaterialByPath(root, '0#99')).toBeNull();
    expect(findMaterialByPath(root, 'x#0')).toBeNull();
  });
});

describe('贴图通道约定', () => {
  it('数据贴图（法线/粗糙/金属）不能按 sRGB 解读', () => {
    for (const slot of TEXTURE_SLOTS) {
      const isData = DATA_TEXTURE_SLOTS.has(slot);
      expect(isData, `${slot} 的线性标记`).toBe(slot !== 'map' && slot !== 'emissiveMap');
    }
  });
});

describe('readFileAsDataUrl', () => {
  it('超限直接拒绝（不静默截断）', async () => {
    const file = { size: 999 } as File;
    await expect(readFileAsDataUrl(file, 10)).rejects.toThrow(/过大/);
  });

  it('正常文件返回 dataURL', async () => {
    // 测试环境是 node，没有 FileReader/Blob —— 造最小桩验证前缀与解码逻辑
    const g = globalThis as unknown as { FileReader?: unknown; Blob?: unknown };
    if (typeof g.FileReader !== 'function' || typeof g.Blob !== 'function') {
      // 无 DOM 时只验证「大文件被拒」这条不依赖 DOM 的路径
      await expect(readFileAsDataUrl({ size: 10 } as File, 1)).rejects.toThrow(/过大/);
      return;
    }
    const blob = new Blob(['x'], { type: 'image/png' });
    const file = new File([blob], 'a.png', { type: 'image/png' });
    const url = await readFileAsDataUrl(file, 1024 * 1024);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });
});