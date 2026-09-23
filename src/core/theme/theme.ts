import * as THREE from 'three';

/** 人物主题（独立模块，可单测）。仅示例角色（userData.themable）支持换肤/换装。 */

export type ThemeGroup = 'skin' | 'cloth';

export function isThemable(scene: THREE.Object3D): boolean {
  return (scene.userData['themable'] as boolean | undefined) === true;
}

function isHex(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

/** 收集带主题标记的去重材质。 */
export function collectThemedMaterials(scene: THREE.Object3D): Record<ThemeGroup, THREE.MeshStandardMaterial[]> {
  const skin = new Map<string, THREE.MeshStandardMaterial>();
  const cloth = new Map<string, THREE.MeshStandardMaterial>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const group = (mesh.userData['themePart'] as ThemeGroup | undefined) ?? undefined;
    if (group !== 'skin' && group !== 'cloth') return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (std && std.isMeshStandardMaterial) {
        (group === 'skin' ? skin : cloth).set(std.uuid, std);
      }
    }
  });
  return { skin: [...skin.values()], cloth: [...cloth.values()] };
}

export interface SceneTheme {
  skin: string;
  cloth: string;
}

/** 读取当前主题色（无标记材质时返回 null）。 */
export function readTheme(scene: THREE.Object3D): SceneTheme | null {
  if (!isThemable(scene)) return null;
  const { skin, cloth } = collectThemedMaterials(scene);
  if (skin.length === 0 && cloth.length === 0) return null;
  return {
    skin: `#${(skin[0] ?? cloth[0]).color.getHexString()}`,
    cloth: `#${(cloth[0] ?? skin[0]).color.getHexString()}`,
  };
}

/** 设置主题色，返回实际作用的材质数；hex 非法时抛错。 */
export function setThemeColor(scene: THREE.Object3D, group: ThemeGroup, hex: string): { applied: number } {
  if (!isThemable(scene)) throw new Error('当前角色不支持换肤（仅示例角色）');
  if (!isHex(hex)) throw new Error(`非法颜色值 ${hex}`);
  const mats = collectThemedMaterials(scene)[group];
  const color = new THREE.Color(hex);
  for (const m of mats) m.color.copy(color);
  return { applied: mats.length };
}
