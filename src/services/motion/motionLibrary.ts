import { guessSemantic } from '../../core/skeleton/humanoidMap';
import { CORE_SEMANTICS } from '../../core/skeleton/rigDetect';
import type { HumanoidSemantic } from '../../core/skeleton/types';

/**
 * 内置真人动作库（Quaternius Universal Animation Library, Standard collection）。
 *
 * 许可：**CC0-1.0 公有领域**（作者放弃全部著作权，无署名义务、无商用限制）。
 * 溯源与声明见 `public/samples/motions/NOTICE-Quaternius-CC0.txt`。
 *
 * 资产以 DirectorDesk 打包的 `{format:'gltf', entry, files:[{path,data:base64}]}`
 * 形式存放，解出后是标准 glTF 2.0 Binary，可直接交给 GLTFLoader。
 */

/** manifest 里的 21 个解剖部位 → 我们的语义。 */
const RIG_BONES: Record<string, HumanoidSemantic> = {
  hips: 'hips',
  spine: 'spine',
  chest: 'chest',
  upperChest: 'chest',
  neck: 'neck',
  head: 'head',
  leftShoulder: 'shoulder.L',
  leftUpperArm: 'upperArm.L',
  leftLowerArm: 'forearm.L',
  leftHand: 'hand.L',
  rightShoulder: 'shoulder.R',
  rightUpperArm: 'upperArm.R',
  rightLowerArm: 'forearm.R',
  rightHand: 'hand.R',
  leftUpperLeg: 'thigh.L',
  leftLowerLeg: 'shin.L',
  leftFoot: 'foot.L',
  leftToes: 'foot.L',
  rightUpperLeg: 'thigh.R',
  rightLowerLeg: 'shin.R',
  rightFoot: 'foot.R',
  rightToes: 'foot.R',
};

export interface MotionClipInfo {
  /** 中文显示名 */
  name: string;
  /** glTF animations 数组下标 */
  index: number;
  duration: number;
  loop: boolean;
}

export interface MotionManifest {
  version: number;
  presets: Array<{ name: string; index: number; duration: number; loop: boolean }>;
  rig: { bones: Record<string, string> };
}

export interface MotionPackage {
  id: string;
  license: string;
  copyright: string;
  entry: string;
  /** 解出的 GLB 二进制 */
  glb: ArrayBuffer;
  manifest: MotionManifest;
}

/** 见 motionRetarget.ts 的同名常量：资源在 public/samples/motions 下。 */
const MOTION_BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const MANIFEST_URL = `${MOTION_BASE}samples/motions/humanoid-v1-manifest.json`;
const PACKAGE_URL = `${MOTION_BASE}samples/motions/humanoid-v1.json`;

/** base64 → ArrayBuffer（不用 atob 的 latin1 截断问题）。 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** 解包并校验。格式不符时抛错，不静默降级。 */
export function parseMotionPackage(pkg: unknown, manifest: MotionManifest): MotionPackage {
  const p = pkg as {
    id?: string; license?: string; copyright?: string;
    package?: { entry?: string; files?: Array<{ path: string; data: string }> };
  };
  const file = p.package?.files?.[0];
  if (!p.package?.entry || !file) throw new Error('动作包格式无效：缺少 package.entry 或 files[0]');
  const glb = base64ToArrayBuffer(file.data);
  if (glb.byteLength < 12) throw new Error('动作包无效：GLB 太短');
  const magic = new TextDecoder().decode(new Uint8Array(glb, 0, 4));
  if (magic !== 'glTF') throw new Error(`动作包无效：GLB magic 应为 glTF，实际为 ${magic}`);
  return {
    id: p.id ?? 'unknown',
    license: p.license ?? 'UNKNOWN',
    copyright: p.copyright ?? '',
    entry: p.package.entry,
    glb,
    manifest,
  };
}

/** 列出全部 clip。 */
export function listMotionClips(pkg: MotionPackage): MotionClipInfo[] {
  return pkg.manifest.presets.map((p) => ({
    name: p.name,
    index: p.index,
    duration: p.duration,
    loop: p.loop,
  }));
}

/**
 * 源骨架语义 → 我们语义的映射。
 * 优先用 manifest 的显式部位表；缺失时退回骨骼名猜测。
 */
export function buildSourceBoneMap(
  sourceNodes: Array<{ name: string }>,
): Partial<Record<HumanoidSemantic, string>> {
  // manifest.rig.bones 是「根→子索引路径」（如 "hips":"0/0/1/0"），需要整棵节点树才能解析；
  // 而节点名本身已是解剖命名（head / leftUpperArm / leftToes…），按名字映射更直接可靠。
  const used = new Set<HumanoidSemantic>();
  const map: Partial<Record<HumanoidSemantic, string>> = {};
  for (const node of sourceNodes) {
    const semantic = RIG_BONES[node.name] ?? guessSemantic(node.name);
    if (!semantic || used.has(semantic)) continue;
    map[semantic] = node.name;
    used.add(semantic);
  }
  return map;
}

/** 绑定诊断：报告哪些语义没对上。 */
export interface MotionBindReport {
  bound: number;
  missing: HumanoidSemantic[];
}

export function diagnoseMotionBind(sourceMap: Partial<Record<HumanoidSemantic, string>>): MotionBindReport {
  const missing = CORE_SEMANTICS.filter((s) => !sourceMap[s]);
  return { bound: CORE_SEMANTICS.length - missing.length, missing };
}

export const MOTION_ASSET = {
  manifestUrl: MANIFEST_URL,
  packageUrl: PACKAGE_URL,
  attribution: 'Quaternius Universal Animation Library (Standard) — CC0-1.0',
  sourceUrl: 'https://quaternius.com/packs/universalanimationlibrary.html',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
} as const;
