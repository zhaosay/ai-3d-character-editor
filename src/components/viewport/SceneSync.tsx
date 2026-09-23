import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useViewportStore } from '../../stores/viewportStore';
import { useSelectionStore } from '../../stores/selectionStore';

function setSubtreeEmissive(root: THREE.Object3D, hex: number) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat && 'emissive' in mat && mat.emissive) mat.emissive.setHex(hex);
    }
  });
}

export function HighlightSync({ sceneObject }: { sceneObject: THREE.Group | null }) {
  const selectedBoneId = useSelectionStore((s) => s.selectedBoneId);
  const prev = useRef<THREE.Object3D | null>(null);

  useEffect(() => {
    if (prev.current) {
      setSubtreeEmissive(prev.current, 0x000000);
      prev.current = null;
    }
    if (sceneObject && selectedBoneId) {
      const bone = sceneObject.getObjectByProperty('uuid', selectedBoneId);
      if (bone) {
        prev.current = bone;
        setSubtreeEmissive(bone, 0x332200);
      }
    }
    return () => {
      if (prev.current) {
        setSubtreeEmissive(prev.current, 0x000000);
        prev.current = null;
      }
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
