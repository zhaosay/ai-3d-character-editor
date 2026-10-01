import { create } from 'zustand';
import type { Object3D, Texture } from 'three';
import type { MaterialEntry, PbrPatch, TextureSlot } from '../core/material/pbr';
import {
  DATA_TEXTURE_SLOTS, TEXTURE_SLOTS, applyPbr, findMaterialByPath, listMaterials,
  readFileAsDataUrl, textureFromDataUrl,
} from '../core/material/pbr';

/**
 * 材质覆盖（按**路径**存，不是 uuid —— uuid 存取项目后就变了）。
 *
 * 存的是「用户改了什么」而非「当前是什么」，这样重新打开项目时
 * 可以在重新加载 GLB 之后再叠加，不依赖运行时材质状态。
 */
export interface MaterialOverride extends PbrPatch {
  textures?: Partial<Record<TextureSlot, string>>;
}
export type MaterialOverrides = Record<string, MaterialOverride>;

/** 单张贴图上限：base64 进 project.json，太大会把项目文件撑爆。 */
export const MAX_TEXTURE_BYTES = 4 * 1024 * 1024;

interface MaterialState {
  /** path → 覆盖值 */
  overrides: MaterialOverrides;
  /**
   * path → **首次编辑前**的原始值。
   *
   * 只存 diff 是不够的：清空覆盖后必须能把材质还原成 GLB 自带的值，
   * 否则面板显示「未修改」而材质仍停在被改过的状态（滑块与画面不一致）。
   */
  originals: Record<string, Record<string, string | number>>;
  /** 已按 overrides 重新施加（避免每次渲染都重复写材质） */
  appliedKey: string | null;
  /** 正在加载贴图的 path#slot */
  busyKey: string | null;
  /** 当前角色场景引用 */
  sceneRef: import('three').Object3D | null;

  setOverride: (path: string, patch: PbrPatch) => void;
  setTexture: (path: string, slot: TextureSlot, dataUrl: string | null) => void;
  clearAll: () => void;
  /** 把 overrides 施加到场景；返回实际改动的材质数 */
  applyTo: (scene: Object3D | null) => number;
  /** 列出场景里的材质 + 已叠加的覆盖值（UI 用） */
  list: (scene: Object3D | null) => Array<MaterialEntry & { override: MaterialOverride | undefined; textures: Partial<Record<TextureSlot, boolean>> }>;
  replaceAll: (o: MaterialOverrides) => void;
}

export const useMaterialStore = create<MaterialState>((set, get) => ({
  overrides: {},
  originals: {},
  appliedKey: null,
  busyKey: null,

  setOverride: (path, patch) => set((s) => {
    const originals = s.originals;
    let nextOriginals = originals;
    if (!(path in originals)) {
      // 首次编辑：记下当前（= GLB 原生）值，供「重置」还原
      const ref = get().sceneRef;
      const live = ref ? findMaterialByPath(ref, path) : null;
      if (live) {
        nextOriginals = {
          ...originals,
          [path]: {
            color: `#${live.color.getHexString()}`,
            metalness: live.metalness,
            roughness: live.roughness,
            normalScale: live.normalScale?.x ?? 1,
            emissive: `#${live.emissive.getHexString()}`,
            emissiveIntensity: live.emissiveIntensity ?? 1,
            envMapIntensity: live.envMapIntensity ?? 1,
          },
        };
      }
    }
    return { originals: nextOriginals, overrides: { ...s.overrides, [path]: { ...s.overrides[path], ...patch } } };
  }),

  setTexture: (path, slot, dataUrl) => set((s) => {
    const cur = s.overrides[path] ?? {};
    const textures = { ...(cur.textures ?? {}) };
    if (dataUrl === null) delete textures[slot];
    else textures[slot] = dataUrl;
    return { overrides: { ...s.overrides, [path]: { ...cur, textures } } };
  }),

  clearAll: () => {
    // 还原材质到 GLB 原值（否则画面停在被改状态，与面板显示不一致）
    const scene = get().sceneRef;
    if (scene) {
      for (const [path, orig] of Object.entries(get().originals)) {
        const m = findMaterialByPath(scene, path);
        if (m) applyPbr(m, orig);
      }
    }
    set({ overrides: {}, originals: {}, appliedKey: null });
  },

  replaceAll: (o) => set({ overrides: o ?? {}, originals: {}, appliedKey: null }),

  /** 当前角色场景（由 applyTo 记录，供「首次编辑前取值」用） */
  sceneRef: null,

  applyTo: (scene) => {
    if (!scene) return 0;
    const { overrides, appliedKey } = get();
    if (appliedKey === scene.uuid) return 0;
    let applied = 0;
    for (const [path, patch] of Object.entries(overrides)) {
      const m = findMaterialByPath(scene, path);
      if (!m) continue;
      const { textures, ...scalars } = patch;
      applyPbr(m, scalars);
      if (textures) {
        for (const slot of TEXTURE_SLOTS) {
          const url = textures[slot];
          if (url === undefined) continue;
          const old = m[slot] as Texture | null | undefined;
          if (url === '') {
            (m as unknown as Record<string, unknown>)[slot] = null;
            old?.dispose();
            continue;
          }
          const { texture, dispose } = textureFromDataUrl(url, DATA_TEXTURE_SLOTS.has(slot) ? 'data' : 'color');
          (m as unknown as Record<string, unknown>)[slot] = texture;
          old?.dispose();
          // 贴图是异步解码，这里不阻塞；dispose 交给材质自身
          texture.userData['pbrOwned'] = true;
          void dispose;
        }
        m.needsUpdate = true;
      }
      applied++;
    }
    set({ appliedKey: scene.uuid, sceneRef: scene });
    return applied;
  },

  list: (scene) => {
    if (!scene) return [];
    const { overrides } = get();
    return listMaterials(scene).map((e) => ({
      ...e,
      override: overrides[e.path],
      textures: Object.fromEntries(
        TEXTURE_SLOTS.filter((s) => overrides[e.path]?.textures?.[s]).map((s) => [s, true]),
      ) as Partial<Record<TextureSlot, boolean>>,
    }));
  },
}));

/** 供 UI 调用：读本地文件 → dataURL → 写入覆盖。 */
export async function importTexture(file: File): Promise<string> {
  return readFileAsDataUrl(file, MAX_TEXTURE_BYTES);
}

/** 判断一份 override 是否「什么都没改」，用于过滤脏数据。 */
export function isEmptyOverride(p?: MaterialOverride): boolean {
  if (!p) return true;
  const { textures, ...rest } = p;
  const hasScalars = Object.values(rest).some((v) => v !== undefined);
  const hasTextures = !!textures && Object.keys(textures).length > 0;
  return !hasScalars && !hasTextures;
}