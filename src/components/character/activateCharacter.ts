import * as THREE from 'three';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useIKStore } from '../../stores/ikStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useThemeStore } from '../../stores/themeStore';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { detectIKChains } from '../../core/ik/chains';
import { buildSkeletonTree } from '../../core/skeleton/buildSkeletonTree';
import { suggestHumanoidRig } from '../../core/skeleton/rigDetect';
import { readTheme } from '../../core/theme/theme';
import { clampAppearance, type Appearance } from '../../core/character/appearance';
import type { CharacterMeta } from '../../types/global';

let prevDispose: (() => void) | null = null;

/** 将已构建的场景设为当前角色（拖拽加载与示例角色共用）：快照骨骼、初始化 IK、清空历史、保底空动画。 */
export function activateCharacter(meta: CharacterMeta, scene: THREE.Group, dispose: () => void) {
  prevDispose?.();
  prevDispose = dispose;
  useCharacterStore.getState().setCharacter(meta, scene);
  const snap = buildSkeletonTree(scene);
  useSkeletonStore.getState().setSnapshot(snap.boneCount > 0 ? snap : null);
  // 骨架自动识别诊断：陌生 GLB 换了命名时，这里告诉用户哪些没绑上、缺哪些核心骨。
  useSkeletonStore.setState({
    rigSuggestion: snap.boneCount > 0
      ? suggestHumanoidRig(Object.values(snap.nodes).map((n) => n.name))
      : null,
  });
  useSelectionStore.getState().select(null);
  useHistoryStore.getState().clear();
  useIKStore.getState().initChains(detectIKChains(snap));
  const theme = readTheme(scene);
  if (theme) useThemeStore.getState().init(theme.skin, theme.cloth);
  const appearance = (scene.userData['appearance'] as Appearance | undefined)
    ?? meta.appearanceSource
    ?? null;
  if (appearance) useAppearanceStore.getState().replace(clampAppearance(appearance));
  const anims = useAnimationStore.getState();
  if (anims.animations.length === 0) anims.createAnimation('Take 1');
  else anims.setTime(0);
}

/** 清除角色但保留已打开项目的动画，避免它们继续作用到旧角色。 */
export function deactivateCharacter() {
  prevDispose?.();
  prevDispose = null;
  useCharacterStore.getState().clear();
  useSkeletonStore.getState().setSnapshot(null);
  useSkeletonStore.setState({ rigSuggestion: null });
  useSelectionStore.getState().select(null);
  useIKStore.getState().clear();
  useHistoryStore.getState().clear();
  useAnimationStore.setState({ playing: false, currentTime: 0 });
}

export type ProjectCharacterRestoreStatus = 'match' | 'missing' | 'mismatch' | 'sketch-restored';

/** 项目没有可用角色绑定时清掉当前角色；手绘角色则从项目配方重建。 */
export function reconcileProjectCharacter(
  projectCharacter: CharacterMeta | null,
  currentCharacter: CharacterMeta | null,
  actions: {
    clear: () => void;
    rebuildSketch: (meta: CharacterMeta) => void;
  },
): ProjectCharacterRestoreStatus {
  if (projectCharacter?.sketchSource) {
    actions.rebuildSketch(projectCharacter);
    return 'sketch-restored';
  }
  if (!projectCharacter) {
    actions.clear();
    return 'missing';
  }
  if (!currentCharacter) {
    actions.clear();
    return 'missing';
  }
  const matches = currentCharacter.fileName === projectCharacter.fileName
    && currentCharacter.fileSize === projectCharacter.fileSize
    && currentCharacter.gltfInfo.bones === projectCharacter.gltfInfo.bones;
  if (matches) return 'match';
  actions.clear();
  return 'mismatch';
}
