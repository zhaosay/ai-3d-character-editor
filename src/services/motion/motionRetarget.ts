import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import type { BoneTrack, Keyframe, AnimationData } from '../../core/animation/types';
import type { HumanoidSemantic } from '../../core/skeleton/types';
import type { QuatTuple, Vec3Tuple } from '../../types/global';
import {
  buildSourceBoneMap, diagnoseMotionBind, listMotionClips, parseMotionPackage,
  type MotionClipInfo, type MotionManifest, type MotionPackage,
} from './motionLibrary';

/**
 * 内置真人动作库 → 当前角色的 retarget。
 *
 * 思路（与 DirectorDesk 的 humanoid-retarget 一致）：
 * 1. 用 GLTFLoader 完整解析 GLB，保留原始节点层级
 * 2. AnimationMixer 绑到**原始 scene**（不能 clone —— clone 会破坏父子关系，mixer 绑不上）
 * 3. 逐帧采样源骨的**局部**旋转
 * 4. 目标局部 = 目标 rest 局部 ⊗ 源局部
 *
 * 不直接重定向位移轨道：源是 1m 白模、目标是任意身高，直接套用位移会让脚陷地。
 * 位移交由现有的髋部位移管线（interaction / groundedHipOffset）负责。
 */

const loader = new GLTFLoader();

/**
 * 资源在 `public/samples/motions/`，而 Vite 的 public 根即站点根，
 * 所以路径是 **`/samples/motions/...`**。
 *
 * 这里曾经写成不带 `samples/` 的相对路径，解析后落到站点根下的同名目录 ——
 * 那个路径不存在，dev server 会走 SPA fallback 返回 **index.html（200）**，
 * 于是报 `Unexpected token '<'`（把 <!doctype 当 JSON 解析）。
 * 用 `import.meta.env.BASE_URL` 前缀，可同时兼容子路径部署。
 */
const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const PATHS = {
  packageUrl: `${BASE}samples/motions/humanoid-v1.json`,
  manifestUrl: `${BASE}samples/motions/humanoid-v1-manifest.json`,
} as const;

/** 读取 JSON；若服务端回了 HTML（SPA fallback / 代理错误）给出可诊断的错误。 */
async function readJson(res: Response, what: string): Promise<unknown> {
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) {
    throw new Error(`${what}返回了 HTML 而不是 JSON（路径 ${res.url}）；请检查资源路径或 dev server 代理`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what}不是合法 JSON（${res.url}，${text.slice(0, 80)}…）`);
  }
}

let pkgCache: MotionPackage | null = null;
let gltfCache: { scene: THREE.Group; animations: THREE.AnimationClip[] } | null = null;

/** 加载并缓存动作包（2.7MB JSON + 2.1MB GLB）。 */
export async function loadMotionLibrary(baseUrl = ''): Promise<MotionPackage> {
  if (pkgCache) return pkgCache;
  const [pkgRes, manifestRes] = await Promise.all([
    fetch(`${baseUrl}${PATHS.packageUrl}`),
    fetch(`${baseUrl}${PATHS.manifestUrl}`),
  ]);
  if (!pkgRes.ok) throw new Error(`动作包下载失败：${pkgRes.status}`);
  if (!manifestRes.ok) throw new Error(`动作清单下载失败：${manifestRes.status}`);
  const manifest = await readJson(manifestRes, '动作清单') as MotionManifest;
  pkgCache = parseMotionPackage(await readJson(pkgRes, '动作包'), manifest);
  return pkgCache;
}

/** 解析 GLB 并缓存（含原始节点层级，mixer 需要）。 */
async function loadGltfCached(baseUrl: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  if (gltfCache) return gltfCache;
  const pkg = await loadMotionLibrary(baseUrl);
  const parsed = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) => {
    loader.parse(
      pkg.glb.slice(0), '',
      (g) => resolve({ scene: g.scene as THREE.Group, animations: g.animations }),
      (e) => reject(e instanceof Error ? e : new Error(String(e))),
    );
  });
  gltfCache = parsed;
  return parsed;
}

export async function listLibraryClips(baseUrl = ''): Promise<MotionClipInfo[]> {
  return listMotionClips(await loadMotionLibrary(baseUrl));
}

/** 取原始场景与 clips（供 mixer 使用；不要手动修改其层级）。 */
export async function getLibraryScene(baseUrl = ''): Promise<{
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}> {
  return loadGltfCached(baseUrl);
}

export interface RetargetOptions {
  /** 目标角色：语义 → 骨骼名 */
  targetBoneMap: Partial<Record<HumanoidSemantic, string>>;
  /** 目标角色根对象 */
  targetRoot: THREE.Object3D;
  fps?: number;
  /** 源场景（默认用内置库的） */
  sourceScene?: THREE.Group;
  /** 源 clip */
  clip: THREE.AnimationClip;
}

export interface RetargetResult {
  animation: AnimationData;
  bound: number;
  missing: HumanoidSemantic[];
  warnings: string[];
}

const _pq = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** 取骨的世界朝向（分解 matrixWorld 的四元数分量）。 */
function worldQuatOf(bone: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  bone.updateWorldMatrix(true, false);
  bone.matrixWorld.decompose(_v, out, _v);
  return out;
}

/** 目标骨的静息局部四元数（父世界朝向的逆 × 自身世界朝向）。 */
function restLocalQuat(bone: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  worldQuatOf(bone, out);
  if (bone.parent) {
    worldQuatOf(bone.parent, _pq);
    return _pq.invert().multiply(out);
  }
  return out.clone();
}

/**
 * 把一个源 clip retarget 成目标角色的 AnimationData（仅旋转轨道）。
 */
export function retargetClip(options: RetargetOptions): RetargetResult {
  const { clip, targetRoot, targetBoneMap } = options;
  const warnings: string[] = [];
  const fps = options.fps ?? 30;
  if (!options.sourceScene) throw new Error('retargetClip 需要 sourceScene');

  const sourceNodes: THREE.Bone[] = [];
  options.sourceScene.traverse((o) => { if ((o as THREE.Bone).isBone) sourceNodes.push(o as THREE.Bone); });
  const sourceMap = buildSourceBoneMap(sourceNodes.map((b) => ({ name: b.name })));
  const report = diagnoseMotionBind(sourceMap);
  if (report.missing.length > 0) {
    warnings.push(`源动作缺少骨骼：${report.missing.join('、')}，相关轨道将跳过`);
  }

  // 目标骨查找
  targetRoot.updateWorldMatrix(true, true);
  const targetBones = new Map<HumanoidSemantic, THREE.Bone>();
  for (const key of Object.keys(targetBoneMap) as HumanoidSemantic[]) {
    const name = targetBoneMap[key];
    if (!name) continue;
    const bone = targetRoot.getObjectByProperty('name', name) as THREE.Bone | undefined;
    if (bone?.isBone) targetBones.set(key, bone);
    else warnings.push(`目标角色缺少骨骼 ${name}（${key}），该轨道将跳过`);
  }

  // mixer 绑到源场景（真实层级）
  const mixer = new THREE.AnimationMixer(options.sourceScene);
  const action = mixer.clipAction(clip);
  action.reset().play();
  action.setLoop(THREE.LoopOnce, clip.duration);
  action.clampWhenFinished = true;

  const duration = clip.duration;
  const frameCount = Math.max(2, Math.floor(duration * fps) + 1);
  const tracks: BoneTrack[] = [];
  const restQuat = new THREE.Quaternion();
  const srcLocal = new THREE.Quaternion();
  const outQuat = new THREE.Quaternion();
  const srcParentQuat = new THREE.Quaternion();

  for (const [semantic, targetBone] of targetBones) {
    const sourceName = sourceMap[semantic];
    const sourceBone = sourceName ? sourceNodes.find((b) => b.name === sourceName) : undefined;
    if (!sourceBone) continue;

    restLocalQuat(targetBone, restQuat);
    const keys: Keyframe<QuatTuple>[] = [];
    for (let i = 0; i < frameCount; i++) {
      const t = Math.min(i / fps, duration);
      mixer.setTime(t);
      options.sourceScene.updateMatrixWorld(true);
      // 源骨局部 = 源父世界朝向的逆 × 源世界朝向
      worldQuatOf(sourceBone, outQuat);
      if (sourceBone.parent) {
        worldQuatOf(sourceBone.parent, srcParentQuat);
        srcLocal.copy(srcParentQuat).invert().multiply(outQuat);
      } else {
        srcLocal.copy(outQuat);
      }
      // 目标局部 = 目标 rest ⊗ 源局部
      const q = restQuat.clone().multiply(srcLocal);
      keys.push({ time: Math.round(t * 1000) / 1000, value: [q.x, q.y, q.z, q.w], interp: 'linear' });
    }
    tracks.push({ boneName: targetBone.name, position: [] as Keyframe<Vec3Tuple>[], rotation: keys, scale: [] });
  }

  action.stop();
  mixer.uncacheClip(clip);

  if (tracks.length === 0) {
    warnings.push('没有任何语义成功绑定，动作未产生轨道');
  }

  return {
    animation: {
      id: `lib-${clip.uuid || clip.name || 'clip'}`,
      name: clip.name || 'Library clip',
      duration,
      fps,
      tracks,
    },
    bound: report.bound,
    missing: report.missing,
    warnings,
  };
}
