import * as THREE from 'three';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useIKStore } from '../../stores/ikStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useThemeStore } from '../../stores/themeStore';
import { detectIKChains } from '../../core/ik/chains';
import { buildSkeletonTree } from '../../core/skeleton/buildSkeletonTree';
import { readTheme } from '../../core/theme/theme';
import type { CharacterMeta } from '../../types/global';

let prevDispose: (() => void) | null = null;

/** 将已构建的场景设为当前角色（拖拽加载与示例角色共用）：快照骨骼、初始化 IK、清空历史、保底空动画。 */
export function activateCharacter(meta: CharacterMeta, scene: THREE.Group, dispose: () => void) {
  prevDispose?.();
  prevDispose = dispose;
  useCharacterStore.getState().setCharacter(meta, scene);
  const snap = buildSkeletonTree(scene);
  useSkeletonStore.getState().setSnapshot(snap.boneCount > 0 ? snap : null);
  useSelectionStore.getState().select(null);
  useHistoryStore.getState().clear();
  useIKStore.getState().initChains(detectIKChains(snap));
  const theme = readTheme(scene);
  if (theme) useThemeStore.getState().init(theme.skin, theme.cloth);
  const anims = useAnimationStore.getState();
  if (anims.animations.length === 0) anims.createAnimation('Take 1');
  else anims.setTime(0);
}
