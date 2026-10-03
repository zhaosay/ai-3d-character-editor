import { createEmptyProject, validateProject } from './schema';
import type { ProjectV1 } from './schema';
import type { AnimationData } from '../animation/types';
import { validateAnimation } from '../animation/types';
import type { CharacterMeta } from '../../types/global';
import { LANDMARK_ORDER, validateSketchLandmarks, type SketchDraftData, type SketchSourceData } from '../rig/sketchToSpec';
import { clampAppearance, type Appearance } from '../character/appearance';

/** project.json 序列化（P4）：角色只存引用（文件名/大小/骨骼数），不嵌入 GLB 二进制。 */
export function serializeProject(p: ProjectV1): string {
  return JSON.stringify(p, null, 2);
}

export interface ParsedProject {
  project: ProjectV1;
  warnings: string[];
}

export function parseProjectFile(json: string): ParsedProject {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('project.json 解析失败：不是合法 JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('project.json 格式错误');
  const base = createEmptyProject();
  const r = raw as Partial<ProjectV1>;
  const warnings: string[] = [];

  const project: ProjectV1 = {
    version: r.version === '1.0' ? '1.0' : '1.0',
    character: normalizeCharacter(r.character),
    sketchDraft: normalizeSketchDraft(r.sketchDraft),
    skeleton: r.skeleton ?? null,
    animations: Array.isArray(r.animations)
      ? (r.animations as AnimationData[]).map((animation) => ({ ...animation, faceTracks: Array.isArray(animation.faceTracks) ? animation.faceTracks : [] }))
      : [],
    activeAnimationId: typeof r.activeAnimationId === 'string' ? r.activeAnimationId : null,
    previs: r.previs && typeof r.previs === 'object' ? r.previs : {},
    scene: { ...base.scene, ...(r.scene ?? {}) },
    camera: { ...base.camera, ...(r.camera ?? {}) },
    settings: {
      fps: r.settings?.fps === 60 ? 60 : 30,
      loop: r.settings?.loop ?? true,
      // 缺省视为开启：旧项目文件没有这个字段，但双手握持才是正确行为
      twoHandGrip: r.settings?.twoHandGrip !== false,
    },
    // 材质覆盖：只接受「路径 → 对象」的结构，其他一律丢弃（不因脏数据崩）
    materialOverrides: (() => {
      const m = (r as Record<string, unknown>)['materialOverrides'];
      if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        if (typeof k === 'string' && k.includes('#') && v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    })(),
  };
  if (r.version !== '1.0') warnings.push(`未知版本号 ${String(r.version)}，已按 1.0 读取`);

  const errors = validateProject(project);
  if (errors.length > 0) throw new Error(`project.json 校验失败：${errors.join('; ')}`);
  for (const a of project.animations) {
    const ae = validateAnimation(a);
    if (ae.length > 0) warnings.push(`动画 ${a.name}: ${ae.join('; ')}`);
  }
  return { project, warnings };
}

function normalizeCharacter(value: unknown): CharacterMeta | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('project.json 校验失败：character 必须是对象或 null');
  const raw = value as Partial<CharacterMeta>;
  const info = raw.gltfInfo as Partial<CharacterMeta['gltfInfo']> | undefined;
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.fileName !== 'string' || !raw.fileName
    || !Number.isFinite(raw.fileSize) || raw.fileSize! < 0
    || !info || !['meshes', 'materials', 'bones', 'hasAnimations'].every((key) => Number.isInteger(info[key as keyof typeof info]) && (info[key as keyof typeof info] as number) >= 0)
    || typeof info.hasSkin !== 'boolean') {
    throw new Error('project.json 校验失败：character 缺少有效的 id、文件信息或 gltfInfo');
  }
  let sketchSource: SketchSourceData | undefined;
  if (raw.sketchSource !== undefined && raw.sketchSource !== null) {
    const source = raw.sketchSource as Partial<SketchSourceData> | null;
    if (!source || typeof source !== 'object' || !source.landmarks || typeof source.landmarks !== 'object') {
      throw new Error('project.json 校验失败：character.sketchSource 格式无效');
    }
    const landmarks = source.landmarks;
    for (const key of LANDMARK_ORDER) {
      const point = landmarks[key];
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new Error(`project.json 校验失败：character.sketchSource.landmarks.${key} 无效`);
      }
    }
    const errors = validateSketchLandmarks(landmarks);
    if (errors.length) throw new Error(`project.json 校验失败：character.sketchSource ${errors[0]}`);
    const headR = Number.isFinite(source.options?.headR) ? Math.min(Math.max(source.options!.headR, 0.09), 0.15) : 0.115;
    const thickness = Number.isFinite(source.options?.thickness) ? Math.min(Math.max(source.options!.thickness, 0.7), 1.3) : 1;
    sketchSource = { landmarks: structuredClone(landmarks), options: { headR, thickness } };
  }
  let appearanceSource: Appearance | undefined;
  if (raw.appearanceSource !== undefined && raw.appearanceSource !== null) {
    if (typeof raw.appearanceSource !== 'object' || Array.isArray(raw.appearanceSource)) {
      throw new Error('project.json 校验失败：character.appearanceSource 格式无效');
    }
    appearanceSource = clampAppearance(raw.appearanceSource as Partial<Appearance>);
  }
  return {
    ...raw,
    gltfInfo: { ...info } as CharacterMeta['gltfInfo'],
    ...(sketchSource ? { sketchSource } : {}),
    ...(appearanceSource ? { appearanceSource } : {}),
  } as CharacterMeta;
}

function normalizeSketchDraft(value: unknown): SketchDraftData | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<SketchDraftData>;
  if (!Array.isArray(raw.points) || raw.points.length !== 8) return null;
  const points = raw.points.map((point) => {
    if (typeof point !== 'object' || point === null) return null;
    const p = point as { x?: unknown; y?: unknown };
    return typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y)
      ? { x: p.x, y: p.y }
      : null;
  });
  const options = raw.options;
  const headR = Number.isFinite(options?.headR) ? Math.min(Math.max(options!.headR, 0.09), 0.15) : 0.115;
  const thickness = Number.isFinite(options?.thickness) ? Math.min(Math.max(options!.thickness, 0.7), 1.3) : 1;
  return { points, options: { headR, thickness } };
}

export type BindStatus = 'match' | 'missing' | 'mismatch';

/** 打开项目时检查内存中的角色是否与项目记录一致（文件名+大小+骨骼数）。 */
export function checkCharacterBind(meta: CharacterMeta | null, project: ProjectV1): BindStatus {
  const c = project.character;
  if (!c) return 'missing';
  if (!meta) return 'missing';
  if (meta.fileName === c.fileName && meta.fileSize === c.fileSize && meta.gltfInfo.bones === c.gltfInfo.bones) {
    return 'match';
  }
  return 'mismatch';
}
