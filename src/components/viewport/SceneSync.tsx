import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useViewportStore } from '../../stores/viewportStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { buildPreviewEnv } from '../../core/render/previewEnv';

/** 写实预览：内置环境反射 + ACES 色调映射 + 曝光（viewer 侧，不导出）。 */
export function EnvAndTone() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const exposure = useViewportStore((s) => s.exposure);
  const envIntensity = useViewportStore((s) => s.envIntensity);

  const envRT = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const rt = pmrem.fromScene(buildPreviewEnv(), 0.04);
    pmrem.dispose();
    return rt;
  }, [gl]);

  useEffect(() => {
    const previousToneMapping = gl.toneMapping;
    const previousExposure = gl.toneMappingExposure;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    return () => {
      gl.toneMapping = previousToneMapping;
      gl.toneMappingExposure = previousExposure;
    };
  }, [gl]);

  useEffect(() => {
    gl.toneMappingExposure = exposure;
  }, [gl, exposure]);

  useEffect(() => {
    const prevEnv = scene.environment;
    const prevInt = scene.environmentIntensity;
    scene.environment = envRT.texture;
    scene.environmentIntensity = envIntensity;
    return () => {
      scene.environment = prevEnv;
      scene.environmentIntensity = prevInt;
    };
  }, [scene, envRT, envIntensity]);

  useEffect(() => () => envRT.dispose(), [envRT]);

  return null;
}

function setSubtreeEmissive(root: THREE.Object3D, hex: number) {
  const original: Array<{ material: THREE.Material; color: THREE.Color; intensity: number }> = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const mat = material as THREE.MeshStandardMaterial;
        if (mat && 'emissive' in mat && mat.emissive) {
          original.push({ material, color: mat.emissive.clone(), intensity: mat.emissiveIntensity });
          mat.emissive.setHex(hex);
        }
      }
    }
  });
  return () => {
    for (const item of original) {
      const mat = item.material as THREE.MeshStandardMaterial;
      mat.emissive.copy(item.color);
      mat.emissiveIntensity = item.intensity;
    }
  };
}

export function HighlightSync({ sceneObject }: { sceneObject: THREE.Group | null }) {
  const selectedBoneId = useSelectionStore((s) => s.selectedBoneId);
  const restore = useRef<(() => void) | null>(null);

  useEffect(() => {
    restore.current?.();
    restore.current = null;
    if (sceneObject && selectedBoneId) {
      const bone = sceneObject.getObjectByProperty('uuid', selectedBoneId);
      if (bone) {
        restore.current = setSubtreeEmissive(bone, 0x332200);
      }
    }
    return () => {
      restore.current?.();
      restore.current = null;
    };
  }, [sceneObject, selectedBoneId]);

  return null;
}

export function SkeletonOverlay({ sceneObject }: { sceneObject: THREE.Group | null }) {
  const showSkeleton = useViewportStore((s) => s.showSkeleton);
  const skeletonColor = useViewportStore((s) => s.skeletonColor);
  const scene = useThree((s) => s.scene);
  const helper = useMemo(() => {
    if (!sceneObject) return null;
    let bones = 0;
    sceneObject.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones++;
    });
    if (bones === 0) return null;
    const h = new THREE.SkeletonHelper(sceneObject);
    const mat = h.material as THREE.Material;
    mat.depthTest = false;
    mat.transparent = true;
    return h;
  }, [sceneObject]);

  useEffect(() => {
    if (!helper) return;
    scene.add(helper);
    return () => {
      scene.remove(helper);
      (helper.geometry as THREE.BufferGeometry)?.dispose();
      (helper.material as THREE.Material)?.dispose();
    };
  }, [scene, helper]);

  useEffect(() => {
    if (helper) helper.visible = showSkeleton;
  }, [helper, showSkeleton]);

  useEffect(() => {
    if (helper) {
      const mat = helper.material as THREE.LineBasicMaterial;
      if (mat && 'color' in mat) mat.color.set(skeletonColor);
    }
  }, [helper, skeletonColor]);

  return null;
}

export function FpsMeter() {
  const setFps = useViewportStore((s) => s.setFps);
  const acc = useRef({ frames: 0, last: performance.now() });
  useFrame(() => {
    const a = acc.current;
    a.frames++;
    const now = performance.now();
    if (now - a.last >= 500) {
      setFps(Math.round((a.frames * 1000) / (now - a.last)));
      a.frames = 0;
      a.last = now;
    }
  });
  return null;
}
