import * as THREE from 'three';
import type { AnimationData } from '../animation/types';
import { applySampledPose, indexBonesByName } from '../animation/applyPose';
import { sampleAnimation } from '../animation/sampler';
import type { CameraKeyframe } from '../camera/track';
import { sampleCameraTrack } from '../camera/track';

const BODY_PROXY = [
  { pattern: /head|neck/i, label: '头部', radius: 0.12 },
  { pattern: /hand|wrist/i, label: '手部', radius: 0.05 },
  { pattern: /upper.?arm|forearm|shoulder|arm/i, label: '手臂', radius: 0.07 },
  { pattern: /thigh|shin|calf|foot|leg/i, label: '腿部', radius: 0.09 },
  { pattern: /hips|pelvis|spine|chest|torso/i, label: '躯干', radius: 0.17 },
];

/** Estimate whether the animated bone proxies stay inside a 16:9 camera safe frame. */
export function inspectCameraSubjectFraming(
  character: THREE.Object3D,
  animation: AnimationData,
  cameraKeys: CameraKeyframe[],
  duration = animation.duration,
  aspect = 16 / 9,
): string[] {
  if (cameraKeys.length === 0 || !(duration > 0) || !(aspect > 0)) return [];
  const bones = indexBonesByName(character);
  const proxies = [...bones.values()].flatMap((bone) => {
    const body = BODY_PROXY.find((part) => part.pattern.test(bone.name));
    return body ? [{ bone, ...body }] : [];
  });
  if (proxies.length === 0) return ['镜头主体检查无法执行：当前骨架没有可识别的人体骨骼代理'];

  const saved = new Map([...bones].map(([name, bone]) => [name, {
    position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone(),
  }]));
  const times = new Set<number>();
  const step = 0.25;
  for (let time = 0; time <= duration + 1e-6; time += step) times.add(Math.min(time, duration));
  cameraKeys.forEach((key) => { if (key.time >= 0 && key.time <= duration) times.add(key.time); });
  animation.tracks.forEach((track) => track.rotation.forEach((key) => { if (key.time >= 0 && key.time <= duration) times.add(key.time); }));

  const violations = new Map<string, string>();
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 1000);
  const view = new THREE.Matrix4();
  try {
    for (const time of [...times].sort((a, b) => a - b)) {
      applySampledPose(character, sampleAnimation(animation, time));
      character.updateWorldMatrix(true, true);
      const pose = sampleCameraTrack(cameraKeys, time);
      if (!pose || !pose.position.every(Number.isFinite) || !pose.target.every(Number.isFinite)) continue;
      camera.fov = THREE.MathUtils.clamp(pose.fov, 1, 179);
      camera.position.fromArray(pose.position);
      camera.lookAt(...pose.target);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      view.copy(camera.matrixWorldInverse);

      for (const { bone, label, radius } of proxies) {
        const center = bone.getWorldPosition(new THREE.Vector3());
        const scale = bone.getWorldScale(new THREE.Vector3());
        const worldRadius = radius * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
        let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
        let behind = false;
        for (const x of [-worldRadius, worldRadius]) for (const y of [-worldRadius, worldRadius]) for (const z of [-worldRadius, worldRadius]) {
          const point = center.clone().add(new THREE.Vector3(x, y, z));
          if (point.clone().applyMatrix4(view).z >= -camera.near) behind = true;
          const projected = point.project(camera);
          minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
          minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
        }
        const direction = behind ? '镜头后方' : minY < -0.96 ? '画面下沿' : maxY > 0.96 ? '画面上沿'
          : minX < -0.96 ? '画面左侧' : maxX > 0.96 ? '画面右侧' : undefined;
        if (direction) {
          const key = `${label}:${direction}`;
          if (!violations.has(key)) violations.set(key, `镜头约 ${time.toFixed(1)} 秒：人物${label}超出${direction}，请检查机位距离、注视点或景别`);
        }
      }
    }
  } finally {
    saved.forEach((pose, name) => {
      const bone = bones.get(name);
      if (!bone) return;
      bone.position.copy(pose.position);
      bone.quaternion.copy(pose.quaternion);
      bone.scale.copy(pose.scale);
    });
    character.updateWorldMatrix(true, true);
  }
  return [...violations.values()].slice(0, 6);
}
