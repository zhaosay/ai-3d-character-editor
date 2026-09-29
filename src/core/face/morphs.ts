import * as THREE from 'three';
import type { FaceTrack } from '../animation/types';
import { sampleScalarTrack } from '../animation/sampler';

/**
 * 面部 blendshape 支持（独立模块，可单测）。
 * 仅当导入模型自带 morph target（如 ARKit 表情）时生效，否则面板隐藏。
 * 注意：表情权重为实时预览，不进入关键帧系统（AnimationData 仅存骨骼变换）。
 */

export interface MorphTarget {
  targetId: string;
  meshPath: string;
  meshUuid: string;
  meshName: string;
  index: number;
  name: string;
  value: number;
}

function pathFromRoot(root: THREE.Object3D, object: THREE.Object3D): string | null {
  const indices: number[] = [];
  let current: THREE.Object3D | null = object;
  while (current && current !== root) {
    const parent: THREE.Object3D | null = current.parent;
    if (!parent) return null;
    const index = parent.children.indexOf(current);
    if (index < 0) return null;
    indices.unshift(index);
    current = parent;
  }
  return current === root ? indices.join('/') : null;
}

export function resolveObjectPath(root: THREE.Object3D, path: string): THREE.Object3D | null {
  let current: THREE.Object3D = root;
  if (!path) return current;
  for (const part of path.split('/')) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || index >= current.children.length) return null;
    current = current.children[index];
  }
  return current;
}

/** 列出场景中全部 morph target（mesh.morphTargetDictionary）。 */
export function listMorphTargets(root: THREE.Object3D): MorphTarget[] {
  const out: MorphTarget[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const dict = (mesh as THREE.Mesh & { morphTargetDictionary?: Record<string, number> }).morphTargetDictionary;
    const infl = (mesh as THREE.Mesh & { morphTargetInfluences?: number[] }).morphTargetInfluences;
    if (!dict || !infl) return;
    const meshPath = pathFromRoot(root, mesh);
    if (meshPath === null) return;
    for (const [name, index] of Object.entries(dict)) {
      out.push({ targetId: `${meshPath}#${name}`, meshPath, meshUuid: mesh.uuid, meshName: mesh.name || '(unnamed)', index, name, value: infl[index] ?? 0 });
    }
  });
  return out;
}

/** Apply saved face tracks by stable mesh child-path + morph name, not runtime UUID. */
export function applyFaceTracks(root: THREE.Object3D, tracks: FaceTrack[], time: number): void {
  for (const track of tracks) {
    const weight = sampleScalarTrack(track.keys, time);
    if (weight === undefined) continue;
    const mesh = resolveObjectPath(root, track.meshPath) as (THREE.Mesh & {
      morphTargetDictionary?: Record<string, number>;
      morphTargetInfluences?: number[];
    }) | null;
    const index = mesh?.morphTargetDictionary?.[track.targetName];
    if (index === undefined || !mesh?.morphTargetInfluences || index >= mesh.morphTargetInfluences.length) continue;
    mesh.morphTargetInfluences[index] = Math.min(Math.max(weight, 0), 1);
  }
}

export function hasMorphTargets(root: THREE.Object3D): boolean {
  return listMorphTargets(root).length > 0;
}

/** 设置权重并钳制 0..1；返回实际值。找不到时抛错（不静默）。 */
export function setMorphInfluence(root: THREE.Object3D, meshUuid: string, index: number, value: number): number {
  const mesh = root.getObjectByProperty('uuid', meshUuid) as
    | (THREE.Mesh & { morphTargetInfluences?: number[] })
    | undefined;
  if (!mesh || !mesh.isMesh || !mesh.morphTargetInfluences) {
    throw new Error('目标 mesh 无 morph target');
  }
  if (index < 0 || index >= mesh.morphTargetInfluences.length) {
    throw new Error(`morph index ${index} 越界`);
  }
  const v = Math.min(Math.max(value, 0), 1);
  mesh.morphTargetInfluences[index] = v;
  return v;
}

/** 全部归零（恢复中性脸）。返回重置个数。 */
export function resetMorphs(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh & { morphTargetInfluences?: number[] };
    if (mesh.isMesh && mesh.morphTargetInfluences) {
      mesh.morphTargetInfluences.fill(0);
      n += mesh.morphTargetInfluences.length;
    }
  });
  return n;
}

/** 眨眼目标名匹配（ARKit eyeBlink* 及常见命名）。 */
const BLINK_PATTERNS = [/blink/i, /eyes?\s*clos/i, /eyelid/i];

export function findBlinkTargets(list: MorphTarget[]): MorphTarget[] {
  return list.filter((m) => BLINK_PATTERNS.some((re) => re.test(m.name)));
}

export const BLINK_PERIOD = 3.7;
const BLINK_START = 0.86;
const BLINK_LEN = 0.11;

/**
 * 确定性眨眼权重（wall-clock 秒）：每 3.7s 一次、0.4s 内闭合再睁开。
 * 纯函数，可单测；同一 t 恒返回同一值。
 */
export function blinkWeight(timeSec: number): number {
  const phase = ((timeSec % BLINK_PERIOD) + BLINK_PERIOD) % BLINK_PERIOD / BLINK_PERIOD;
  if (phase < BLINK_START || phase > BLINK_START + BLINK_LEN) return 0;
  return Math.sin(((phase - BLINK_START) / BLINK_LEN) * Math.PI);
}
