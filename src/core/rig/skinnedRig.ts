import * as THREE from 'three';
import type { ThemeGroup } from '../theme/theme';

/** 通用刚性蒙皮管线（独立模块，可单测）：骨骼层级 + 单 Skeleton 多部件。 */

export interface RigBoneSpec {
  name: string;
  parent: string | null;
  pos: [number, number, number];
}

export interface RigPartSpec {
  geo: THREE.BufferGeometry;
  bone: string;
  mat: THREE.Material;
  theme?: ThemeGroup;
}

export interface BuiltRig {
  scene: THREE.Group;
  bones: Map<string, THREE.Bone>;
  ordered: THREE.Bone[];
  skeleton: THREE.Skeleton;
  meshes: THREE.SkinnedMesh[];
}

/** 材质按实例克隆（换肤不污染模板）。返回 mesh→克隆材质映射。 */
export function cloneMaterials(parts: RigPartSpec[]): Map<THREE.Material, THREE.Material> {
  const clones = new Map<THREE.Material, THREE.Material>();
  for (const p of parts) {
    if (!clones.has(p.mat)) clones.set(p.mat, p.mat.clone());
  }
  return clones;
}

export function buildRigged(
  name: string,
  specs: RigBoneSpec[],
  parts: RigPartSpec[],
  matClones?: Map<THREE.Material, THREE.Material>,
): BuiltRig {
  const scene = new THREE.Group();
  scene.name = name;

  const bones = new Map<string, THREE.Bone>();
  for (const spec of specs) {
    const b = new THREE.Bone();
    b.name = spec.name;
    b.position.fromArray(spec.pos);
    bones.set(spec.name, b);
    if (spec.parent) {
      const parent = bones.get(spec.parent);
      if (!parent) throw new Error(`骨骼 ${spec.name} 的父节点 ${spec.parent} 不存在（先定义父）`);
      parent.add(b);
    } else {
      scene.add(b);
    }
  }
  scene.updateMatrixWorld(true);
  const ordered = specs.map((s) => bones.get(s.name)!);
  const indexOf = new Map(ordered.map((b, i) => [b.name, i]));
  const skeleton = new THREE.Skeleton(ordered);
  const clones = matClones ?? cloneMaterials(parts);

  const meshes: THREE.SkinnedMesh[] = [];
  for (const part of parts) {
    const bi = indexOf.get(part.bone);
    if (bi === undefined) throw new Error(`部件绑定的骨骼 ${part.bone} 不存在`);
    const geo = part.geo;
    const count = geo.attributes['position'].count;
    const si = new Uint16Array(count * 4);
    const sw = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      si[i * 4] = bi;
      sw[i * 4] = 1;
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const mesh = new THREE.SkinnedMesh(geo, clones.get(part.mat) ?? part.mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (part.theme) mesh.userData['themePart'] = part.theme;
    mesh.bind(skeleton);
    mesh.normalizeSkinWeights();
    scene.add(mesh);
    meshes.push(mesh);
  }
  scene.updateMatrixWorld(true);
  return { scene, bones, ordered, skeleton, meshes };
}

/** 释放几何体 + 本实例克隆材质。 */
export function disposeRigged(scene: THREE.Group) {
  const mats = new Set<THREE.Material>();
  scene.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) {
      mesh.geometry.dispose();
      const mm = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mm.forEach((m) => mats.add(m as THREE.Material));
    }
  });
  mats.forEach((m) => m.dispose());
}
