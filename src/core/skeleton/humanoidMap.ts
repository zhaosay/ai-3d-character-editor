import type { HumanoidSemantic } from './types';
import { guessSemantic as detect } from './rigDetect';

/**
 * 骨骼名识别（历史入口）。
 * 实际实现在 `rigDetect.ts`（分层归一化 + 侧别 + 部位三步判定），
 * 这里保留原导出以兼容既有调用方。
 */

/** 名称匹配，失败返回 null（UI 显示"未映射"，不阻塞）。 */
export function guessSemantic(boneName: string): HumanoidSemantic | null {
  return detect(boneName);
}
