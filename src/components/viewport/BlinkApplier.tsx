import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useCharacterStore } from '../../stores/characterStore';
import { useIdleStore } from '../../stores/idleStore';
import { applyFaceTracks, blinkWeight, findBlinkTargets, listMorphTargets, setMorphInfluence } from '../../core/face/morphs';
import { useAnimationStore } from '../../stores/animationStore';

/**
 * 自动眨眼实时层：只写 blink morph 权重，不碰骨骼/时间轴，
 * 与播放、 scrub、IK 求解均无冲突。关闭或卸载时归零动过的目标。
 */
export function BlinkApplier() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const blinkEnabled = useIdleStore((s) => s.blinkEnabled);
  const touched = useRef<Array<{ meshUuid: string; meshPath: string; targetName: string; index: number }>>([]);

  const targets = useMemo(() => {
    if (!sceneObject || !blinkEnabled) return [];
    return findBlinkTargets(listMorphTargets(sceneObject));
  }, [sceneObject, blinkEnabled]);

  useEffect(() => () => {
    // 卸载/关闭：归零
    const scene = useCharacterStore.getState().sceneObject;
    if (!scene) return;
    const active = useAnimationStore.getState().active();
    for (const t of touched.current) {
      if (active?.faceTracks?.some((track) => track.meshPath === t.meshPath && track.targetName === t.targetName)) continue;
      try {
        setMorphInfluence(scene, t.meshUuid, t.index, 0);
      } catch { /* 忽略 */ }
    }
    if (active) applyFaceTracks(scene, active.faceTracks ?? [], useAnimationStore.getState().currentTime);
    touched.current = [];
  }, [blinkEnabled, sceneObject]);

  useFrame(({ clock }) => {
    if (!sceneObject || targets.length === 0) return;
    const w = blinkWeight(clock.elapsedTime);
    const authored = useAnimationStore.getState().active()?.faceTracks ?? [];
    for (const t of targets) {
      if (authored.some((track) => track.meshPath === t.meshPath && track.targetName === t.name)) continue;
      const mesh = sceneObject.getObjectByProperty('uuid', t.meshUuid) as unknown as {
        morphTargetInfluences?: number[];
      } | undefined;
      if (mesh?.morphTargetInfluences && t.index < mesh.morphTargetInfluences.length) {
        mesh.morphTargetInfluences[t.index] = w;
        if (!touched.current.some((x) => x.meshUuid === t.meshUuid && x.index === t.index)) {
          touched.current.push({ meshUuid: t.meshUuid, meshPath: t.meshPath, targetName: t.name, index: t.index });
        }
      }
    }
  });

  return null;
}
