import * as THREE from 'three';

/**
 * PBR 材质枚举与编辑。
 *
 * 之前**完全没有**材质面板：导入 GLB 后（`loadGltf.finishLoaded` 只统计材质数量，
 * 从不触碰 material 属性），用户改不了任何金属度/粗糙度/贴图。
 * 内置角色也只有 `Appearance.skinRoughness` 一个标量。
 *
 * ## 为什么用「路径」而不是 material.uuid
 *
 * uuid 是运行时随机值，**存取项目后就变了**。这里用「root 到 mesh 的子索引路径」
 * （如 `0/2/1`），与 `core/face/morphs.ts` 的 `listMorphTargets` 同一套约定，
 * 这样材质覆盖能存进 project.json 并在重新打开后正确恢复。
 */

/** 可编辑的 PBR 通道。 */
export type PbrPatch = {
  /** 基色，#rrggbb */
  color?: string;
  /** 金属度 0..1 */
  metalness?: number;
  /** 粗糙度 0..1 */
  roughness?: number;
  /** 法线贴图强度 0..3 */
  normalScale?: number;
  /** 自发光颜色，#rrggbb */
  emissive?: string;
  /** 自发光强度 0..5 */
  emissiveIntensity?: number;
  /** 环境反射强度 0..3 */
  envMapIntensity?: number;
};

export interface MaterialEntry {
  /** 稳定路径（root→mesh 子索引），用于存取 */
  path: string;
  /** 材质名（GLB 里的原始名，可能为空） */
  name: string;
  /** 所属 mesh 名，便于用户辨认 */
  meshName: string;
  /** 当前值（读出来就能填 UI） */
  values: Required<Pick<PbrPatch, 'color' | 'metalness' | 'roughness' | 'normalScale' | 'emissive' | 'emissiveIntensity' | 'envMapIntensity'>>;
  /** 已挂了哪些贴图 */
  maps: { map: boolean; normalMap: boolean; roughnessMap: boolean; metalnessMap: boolean; emissiveMap: boolean };
  /** 是否受程序化换肤控制（themePart） */
  themable: 'skin' | 'cloth' | null;
}

/** MeshPhysicalMaterial 继承 MeshStandardMaterial 但标志不继承，两个都要判 */
function isStandardLike(m: THREE.Material): m is THREE.MeshStandardMaterial {
  const t = m as unknown as Record<string, boolean>;
  return t['isMeshStandardMaterial'] === true || t['isMeshPhysicalMaterial'] === true;
}

/** 递归子索引路径（与 morphs.ts 的约定一致）。 */
function pathFromRoot(root: THREE.Object3D, target: THREE.Object3D): string | null {
  const walk = (node: THREE.Object3D, trail: number[]): string | null => {
    if (node === target) return trail.join('/');
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) {
      const hit = walk(kids[i], [...trail, i]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, []);
}

function readValues(m: THREE.MeshStandardMaterial): MaterialEntry['values'] {
  return {
    color: `#${m.color.getHexString()}`,
    metalness: round(m.metalness),
    roughness: round(m.roughness),
    normalScale: round(m.normalScale?.x ?? 1),
    emissive: `#${(m.emissive ?? new THREE.Color(0)).getHexString()}`,
    emissiveIntensity: round(m.emissiveIntensity ?? 1),
    envMapIntensity: round(m.envMapIntensity ?? 1),
  };
}

function round(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

/** 枚举场景中所有可编辑的 PBR 材质（按路径排序，保证 UI 顺序稳定）。 */
export function listMaterials(root: THREE.Object3D): MaterialEntry[] {
  const out: MaterialEntry[] = [];
  const seen = new Set<string>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const path = pathFromRoot(root, mesh);
    if (path === null) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    mats.forEach((m, idx) => {
      if (!m || !isStandardLike(m)) return;
      const key = `${path}#${idx}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        path: key,
        name: m.name ?? '',
        meshName: mesh.name || '(未命名)',
        values: readValues(m),
        maps: {
          map: !!m.map,
          normalMap: !!m.normalMap,
          roughnessMap: !!m.roughnessMap,
          metalnessMap: !!m.metalnessMap,
          emissiveMap: !!m.emissiveMap,
        },
        themable: (mesh.userData['themePart'] as 'skin' | 'cloth' | undefined) ?? null,
      });
    });
  });
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** 按 `path#idx` 找到材质（找不到返回 null，不抛错）。 */
export function findMaterialByPath(root: THREE.Object3D, path: string): THREE.MeshStandardMaterial | null {
  const hash = path.lastIndexOf('#');
  if (hash < 0) return null;
  const meshPath = path.slice(0, hash);
  const index = Number(path.slice(hash + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  let node: THREE.Object3D | undefined = root;
  for (const seg of meshPath.split('/')) {
    const i = Number(seg);
    if (!Number.isInteger(i) || !node) return null;
    node = node.children[i];
  }
  if (!node) return null;
  const mesh = node as THREE.Mesh;
  if (!mesh.isMesh) return null;
  const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
  const m = mats[index];
  // 索引越界时 mats[index] 是 undefined —— 必须判空再走类型守卫，
  // 否则 isStandardLike(undefined) 会抛「读 undefined 的属性」。
  if (!m) return null;
  return isStandardLike(m) ? m : null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
function clampRange(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

/**
 * 把 PBR 覆盖写到材质上。非法输入被钳制/忽略，**不抛错**（面板是实时拖动）。
 * 返回实际应用的字段数。
 */
export function applyPbr(m: THREE.MeshStandardMaterial, patch: PbrPatch): number {
  let applied = 0;
  if (patch.color !== undefined && HEX.test(patch.color)) {
    m.color.set(patch.color);
    applied++;
  }
  if (patch.metalness !== undefined) {
    m.metalness = clamp01(patch.metalness);
    applied++;
  }
  if (patch.roughness !== undefined) {
    m.roughness = clamp01(patch.roughness);
    applied++;
  }
  if (patch.normalScale !== undefined) {
    const v = clampRange(patch.normalScale, 0, 3);
    // normalScale 是 Vector2（three 的约定：GLTF 的 y 分量需取负，此处按 uniform 处理）
    if (m.normalScale) m.normalScale.set(v, v);
    applied++;
  }
  if (patch.emissive !== undefined && HEX.test(patch.emissive)) {
    m.emissive.set(patch.emissive);
    applied++;
  }
  if (patch.emissiveIntensity !== undefined) {
    m.emissiveIntensity = clampRange(patch.emissiveIntensity, 0, 5);
    applied++;
  }
  if (patch.envMapIntensity !== undefined) {
    m.envMapIntensity = clampRange(patch.envMapIntensity, 0, 3);
    applied++;
  }
  m.needsUpdate = true;
  return applied;
}

/**
 * 从 dataURL 创建贴图（用于本地导入）。
 *
 * 用 `Image` + `Texture`，不引入新的加载器依赖（本项目没装 KTX2/basis）。
 * 自动按颜色空间区分：基色/自发光用 sRGB，数据类（法线/粗糙/金属）必须线性。
 */
export function textureFromDataUrl(
  dataUrl: string,
  kind: 'color' | 'data' = 'color',
): { texture: THREE.Texture; dispose: () => void } {
  const texture = new THREE.Texture();
  // 数据贴图（法线/粗糙/金属）必须线性解读，标成 sRGB 会让画面失真
  texture.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    texture.dispose();
  };
  // 非浏览器环境（单测/SSR）没有 Image —— 返回一个空贴图占位而不是抛错，
  // 否则「引用挂上了」这类断言无法在 node 里验证。
  const g = globalThis as unknown as { Image?: new () => HTMLImageElement };
  if (typeof g.Image !== 'function') return { texture, dispose: cleanup };
  const image = new g.Image();
  image.onload = () => {
    if (disposed) return;
    texture.image = image;
    texture.needsUpdate = true;
  };
  image.src = dataUrl;
  return { texture, dispose: cleanup };
}

/** 贴图通道的可选列表（与 PbrPatch 的 map 字段对应）。 */
export const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'] as const;
export type TextureSlot = (typeof TEXTURE_SLOTS)[number];

/** 哪些通道按线性（数据贴图）解读 —— 法线/粗糙/金属错了会看起来「塑料+诡异」。 */
export const DATA_TEXTURE_SLOTS: ReadonlySet<TextureSlot> = new Set<TextureSlot>([
  'normalMap', 'roughnessMap', 'metalnessMap',
]);

export const TEXTURE_LABELS: Record<TextureSlot, string> = {
  map: '基色',
  normalMap: '法线',
  roughnessMap: '粗糙度',
  metalnessMap: '金属度',
  emissiveMap: '自发光',
};

/** 读本地文件为 dataURL。超限直接抛错，不静默截断。 */
export function readFileAsDataUrl(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) {
    return Promise.reject(new Error(`贴图过大（${(file.size / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}