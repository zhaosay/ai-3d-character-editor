import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useCharacterStore } from '../../stores/characterStore';
import { useIdleStore } from '../../stores/idleStore';
import { blinkWeight, findBlinkTargets, listMorphTargets, setMorphInfluence } from '../../core/face/morphs';

/**
 * 自动眨眼实时层：只写 blink morph 权重，不碰骨骼/时间轴，
 * 与播放、 scrub、IK 求解均无冲突。关闭或卸载时归零动过的目标。
 */
export function BlinkApplier() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const blinkEnabled = useIdleStore((s) => s.blinkEnabled);
  const touched = useRef<Array<{ meshUuid: string; index: number }>>([]);

  const targets = useMemo(() => {
    touched.current = [];
    if (!sceneObject || !blinkEnabled) return [];
    return findBlinkTargets(listMorphTargets(sceneObject));
  }, [sceneObject, blinkEnabled]);

  useEffect(() => () => {
    // 卸载/关闭：归零
    const scene = useCharacterStore.getState().sceneObject;
    if (!scene) return;
    for (const t of touched.current) {
      try {
        setMorphInfluence(scene, t.meshUuid, t.index, 0);
      } catch { /* 忽略 */ }
    }
    touched.current = [];
  }, [blinkEnabled, sceneObject]);

  useFrame(({ clock }) => {
    if (!sceneObject || targets.length === 0) return;
    const w = blinkWeight(clock.elapsedTime);
    for (const t of targets) {
      const mesh = sceneObject.getObjectByProperty('uuid', t.meshUuid) as unknown as {
        morphTargetInfluences?: number[];
      } | undefined;
      if (mesh?.morphTargetInfluences && t.index < mesh.morphTargetInfluences.length) {
        mesh.morphTargetInfluences[t.index] = w;
        if (!touched.current.some((x) => x.meshUuid === t.meshUuid && x.index === t.index)) {
          touched.current.push({ meshUuid: t.meshUuid, index: t.index });
        }
      }
    }
  });

  return null;
}
