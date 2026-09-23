import * as THREE from 'three';
import type { BoneNode, BoneTransform, HumanoidSemantic, SkeletonSnapshot } from './types';
import { guessSemantic } from './humanoidMap';

function toTuples(obj: THREE.Object3D): { local: BoneTransform; worldPos: [number, number, number]; worldQuat: [number, number, number, number] } {
  const p = obj.position;
  const q = obj.quaternion;
  const s = obj.scale;
  const wp = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  obj.getWorldPosition(wp);
  obj.getWorldQuaternion(wq);
  return {
    local: {
      position: [p.x, p.y, p.z],
      quaternion: [q.x, q.y, q.z, q.w],
      scale: [s.x, s.y, s.z],
    },
    worldPos: [wp.x, wp.y, wp.z],
    worldQuat: [wq.x, wq.y, wq.z, wq.w],
  };
}

/** 从已加载的 three 场景中派生骨骼树，不假设 Hips/Spine 命名，兼容任意 GLB。 */
export function buildSkeletonTree(root: THREE.Object3D): SkeletonSnapshot {
  root.updateWorldMatrix(true, true);
  const bones: THREE.Bone[] = [];
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
  });

  const nodes: Record<string, BoneNode> = {};
  const byObj = new Map<THREE.Object3D, string>();
  bones.forEach((b, i) => {
    const id = b.uuid;
    byObj.set(b, id);
    const t = toTuples(b);
    const semantic: HumanoidSemantic | null = guessSemantic(b.name);
    nodes[id] = {
      id,
      name: b.name || `Bone_${i}`,
      index: i,
      parent: null,
      children: [],
      local: t.local,
      world: { position: t.worldPos, quaternion: t.worldQuat },
      restLocal: JSON.parse(JSON.stringify(t.local)) as BoneTransform,
      depth: 0,
      isEndSite: true,
      semantic,
    };
  });

  // 第二遍：父子关系（父也必须是 Bone；若父是普通 Object3D 则视为 root）
  bones.forEach((b) => {
    const id = byObj.get(b)!;
    const parentBone = findParentBone(b);
    if (parentBone && byObj.has(parentBone)) {
      const pid = byObj.get(parentBone)!;
      nodes[id].parent = pid;
      nodes[pid].children.push(id);
      nodes[pid].isEndSite = false;
    }
  });

  // depth
  const roots = Object.values(nodes).filter((n) => n.parent === null).map((n) => n.id);
  const visit = (id: string, d: number) => {
    nodes[id].depth = d;
    nodes[id].children.forEach((c) => visit(c, d + 1));
  };
  roots.forEach((r) => visit(r, 0));

  return { roots, nodes, boneCount: bones.length };
}

function findParentBone(o: THREE.Object3D): THREE.Bone | null {
  let p = o.parent;
  while (p) {
    if ((p as THREE.Bone).isBone) return p as THREE.Bone;
    // 若中间隔着非Bone（如 Group），继续向上找；但若到 Scene 则停止
    if (p.type === 'Scene') return null;
    p = p.parent;
  }
  return null;
}
