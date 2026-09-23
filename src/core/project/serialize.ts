import { createEmptyProject, validateProject } from './schema';
import type { ProjectV1 } from './schema';
import type { AnimationData } from '../animation/types';
import { validateAnimation } from '../animation/types';
import type { CharacterMeta } from '../../types/global';

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
    character: r.character ?? null,
    skeleton: r.skeleton ?? null,
    animations: Array.isArray(r.animations) ? (r.animations as AnimationData[]) : [],
    scene: { ...base.scene, ...(r.scene ?? {}) },
    camera: { ...base.camera, ...(r.camera ?? {}) },
    settings: {
      fps: r.settings?.fps === 60 ? 60 : 30,
      loop: r.settings?.loop ?? true,
    },
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
