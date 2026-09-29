import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useAnimationStore } from '../../stores/animationStore';
import { useCameraStore } from '../../stores/cameraStore';
import { sampleCameraTrack } from '../../core/camera/track';

/** 与角色使用同一播放头的镜头轨道。 */
export function CameraPlayback() {
  const camera = useThree((state) => state.camera);
  // Camera mutation is the imperative output of the R3F frame loop.
  // oxlint-disable react(immutability)
  useFrame(() => {
    const { enabled, keyframes } = useCameraStore.getState();
    if (!enabled) return;
    const pose = sampleCameraTrack(keyframes, useAnimationStore.getState().currentTime);
    if (!pose) return;
    camera.position.fromArray(pose.position);
    if (camera instanceof THREE.PerspectiveCamera && Math.abs(camera.fov - pose.fov) > 1e-4) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(...pose.target);
  });
  // oxlint-enable react(immutability)
  return null;
}
