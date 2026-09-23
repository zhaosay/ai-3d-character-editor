import * as THREE from 'three';
import { GLTFExporter } from 'three-stdlib';
import type { AnimationData } from '../../core/animation/types';
import { toThreeClip } from '../../core/animation/toThreeClip';

export interface ExportResult {
  fileName: string;
  clipCount: number;
  warnings: string[];
}

/**
 * 导出 GLB（含全部有效动画，REAL）。
 * tracks 按骨骼名绑定；重名骨骼取第一个（与编辑器内采样一致）。
 * 导出后可将 .glb 拖回编辑器验证播放。
 */
export function exportGltf(
  sceneObject: THREE.Group,
  animations: AnimationData[],
  baseName: string,
): Promise<ExportResult> {
  const warnings: string[] = [];
  const clips: THREE.AnimationClip[] = [];

  for (const anim of animations) {
    const hasKeys = anim.tracks.some((t) => t.rotation.length + t.position.length + t.scale.length > 0);
    if (!hasKeys) {
      warnings.push(`跳过空动画 ${anim.name}`);
      continue;
    }
    const { clip, warnings: w } = toThreeClip(anim);
    if (clip.tracks.length === 0) {
      warnings.push(`跳过 ${anim.name}（无可导出轨道）`);
      continue;
    }
    warnings.push(...w.map((x) => `${anim.name}: ${x}`));
    clips.push(clip);
  }

  const exporter = new GLTFExporter();
  return new Promise<ExportResult>((resolve, reject) => {
    try {
      exporter.parse(
        sceneObject,
        (result) => {
          try {
            const buf = result as ArrayBuffer;
            const blob = new Blob([buf], { type: 'model/gltf-binary' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const fileName = `${baseName.replace(/\.(glb|gltf)$/i, '') || 'character'}_anim.glb`;
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            resolve({ fileName, clipCount: clips.length, warnings });
          } catch (e) {
            reject(e instanceof Error ? e : new Error('导出写入失败'));
          }
        },
        (e) => reject(e instanceof Error ? e : new Error(`GLB 导出失败: ${String(e)}`)),
        { binary: true, animations: clips },
      );
    } catch (e) {
      reject(e instanceof Error ? e : new Error('GLB 导出失败'));
    }
  });
}
