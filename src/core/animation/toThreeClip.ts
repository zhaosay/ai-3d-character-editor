import * as THREE from 'three';
import type { AnimationData } from './types';

export interface ClipResult {
  clip: THREE.AnimationClip;
  /** 如混合插值被归一化、cubic 被跳过等情况，在此说明（导出面板展示） */
  warnings: string[];
}

/**
 * 自有 AnimationData → THREE.AnimationClip（预览/GLB 导出用）。
 * three 的 track 是整轨单一插值；整轨全 step 则 STEP，否则 LINEAR。
 * cubic 关键帧整轨跳过并警告（P7 实现）。
 */
export function toThreeClip(anim: AnimationData, root?: THREE.Object3D): ClipResult {
  const warnings: string[] = [];
  const tracks: THREE.KeyframeTrack[] = [];

  for (const t of anim.tracks) {
    if (t.rotation.some((k) => k.interp === 'cubic')) {
      warnings.push(`${t.boneName}.rotation 含 cubic，已跳过（P7）`);
    } else if (t.rotation.length > 0) {
      const keys = [...t.rotation].sort((a, b) => a.time - b.time);
      const times = keys.map((k) => k.time);
      const values = keys.flatMap((k) => k.value);
      const track = new THREE.QuaternionKeyframeTrack(`${t.boneName}.quaternion`, times, values);
      if (keys.every((k) => k.interp === 'step')) {
        track.setInterpolation(THREE.InterpolateDiscrete);
      }
      tracks.push(track);
    }

    if (t.position.some((k) => k.interp === 'cubic')) {
      warnings.push(`${t.boneName}.position 含 cubic，已跳过（P7）`);
    } else if (t.position.length > 0) {
      const keys = [...t.position].sort((a, b) => a.time - b.time);
      const track = new THREE.VectorKeyframeTrack(
        `${t.boneName}.position`,
        keys.map((k) => k.time),
        keys.flatMap((k) => k.value),
      );
      if (keys.every((k) => k.interp === 'step')) track.setInterpolation(THREE.InterpolateDiscrete);
      tracks.push(track);
    }

    if (t.scale.some((k) => k.interp === 'cubic')) {
      warnings.push(`${t.boneName}.scale 含 cubic，已跳过（P7）`);
    } else if (t.scale.length > 0) {
      const keys = [...t.scale].sort((a, b) => a.time - b.time);
      const track = new THREE.VectorKeyframeTrack(
        `${t.boneName}.scale`,
        keys.map((k) => k.time),
        keys.flatMap((k) => k.value),
      );
      if (keys.every((k) => k.interp === 'step')) track.setInterpolation(THREE.InterpolateDiscrete);
      tracks.push(track);
    }
  }

  for (const face of anim.faceTracks ?? []) {
    if (!root) {
      warnings.push(`${face.targetName} 表情轨道需要角色场景才能导出，已跳过`);
      continue;
    }
    const node = face.meshPath ? face.meshPath.split('/').reduce<THREE.Object3D | null>((parent, part) => {
      const index = Number(part);
      return parent && Number.isInteger(index) && index >= 0 ? parent.children[index] ?? null : null;
    }, root) : root;
    const mesh = node as (THREE.Mesh & { morphTargetDictionary?: Record<string, number> }) | null;
    if (!mesh?.isMesh || mesh.morphTargetDictionary?.[face.targetName] === undefined) {
      warnings.push(`${face.targetName} 表情目标在当前角色中不存在，已跳过`);
      continue;
    }
    if (face.keys.some((key) => key.interp === 'cubic')) {
      warnings.push(`${face.targetName} 表情轨道含 cubic，已跳过（P7）`);
      continue;
    }
    if (face.keys.length === 0) continue;
    const keys = [...face.keys].sort((a, b) => a.time - b.time);
    const nodeName = mesh.name || mesh.uuid;
    const track = new THREE.NumberKeyframeTrack(
      `${nodeName}.morphTargetInfluences[${face.targetName}]`,
      keys.map((key) => key.time),
      keys.map((key) => key.value),
    );
    if (keys.every((key) => key.interp === 'step')) track.setInterpolation(THREE.InterpolateDiscrete);
    tracks.push(track);
  }

  const clip = new THREE.AnimationClip(anim.name, anim.duration, tracks);
  return { clip, warnings };
}
