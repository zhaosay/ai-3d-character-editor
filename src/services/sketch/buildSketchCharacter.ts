import * as THREE from 'three';
import type { CharacterMeta } from '../../types/global';
import { useThemeStore } from '../../stores/themeStore';
import { buildRigged, disposeRigged } from '../../core/rig/skinnedRig';
import { buildSketchSpec, type LandmarkKey, type SketchOptions, type SketchPoint } from '../../core/rig/sketchToSpec';

export interface SketchCharacter {
  scene: THREE.Group;
  meta: CharacterMeta;
  warnings: string[];
  dispose: () => void;
}

/** 描点建模：画布关节点 → 标准化规格 → 蒙皮角色（颜色取当前主题）。 */
export function buildSketchCharacter(
  landmarks: Partial<Record<LandmarkKey, SketchPoint>>,
  opts: SketchOptions,
): SketchCharacter {
  if (!Number.isFinite(opts.headR) || !Number.isFinite(opts.thickness)) {
    throw new Error('手绘角色参数无效，请检查头部大小和身体粗细');
  }
  const { bones, parts, warnings } = buildSketchSpec(landmarks, opts);
  const theme = useThemeStore.getState();
  const skinMat = new THREE.MeshStandardMaterial({ color: theme.skin, roughness: 0.7, metalness: 0.1 });
  const clothMat = new THREE.MeshStandardMaterial({ color: theme.cloth, roughness: 0.5, metalness: 0.3 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x232b36, roughness: 0.8 });
  const matOf = (role: string) => (role === 'skin' ? skinMat : role === 'accent' ? clothMat : darkMat);

  const built = buildRigged(
    'SketchCharacter',
    bones,
    parts.map((p) => ({
      geo: p.geo,
      bone: p.bone,
      mat: matOf(p.role),
      theme: p.role === 'skin' ? ('skin' as const) : ('cloth' as const),
    })),
  );
  built.scene.userData['themable'] = true;

  const meta: CharacterMeta = {
    id: `sketch-${Date.now()}`,
    fileName: 'sketch-character.glb',
    fileSize: 0,
    sketchSource: { landmarks: structuredClone(landmarks), options: { ...opts } },
    gltfInfo: {
      meshes: parts.length,
      materials: 3,
      bones: bones.length,
      hasSkin: true,
      hasAnimations: 0,
    },
  };

  return { scene: built.scene, meta, warnings, dispose: () => disposeRigged(built.scene) };
}

/** Rebuild an editor sketch character from the recipe stored in its project metadata. */
export function rebuildSketchCharacter(meta: CharacterMeta): SketchCharacter {
  if (!meta.sketchSource) throw new Error('项目角色没有手绘配方，无法重建');
  const rebuilt = buildSketchCharacter(meta.sketchSource.landmarks, meta.sketchSource.options);
  return { ...rebuilt, meta: { ...rebuilt.meta, ...meta } };
}
