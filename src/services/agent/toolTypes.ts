/** Agent Tool Calling 类型（P10 冻结）。LLM 只允许输出 AgentAction，绝不直写 Scene/文件。 */

export type ToolName =
  | 'load_character'
  | 'inspect_skeleton'
  | 'select_bone'
  | 'modify_bone'
  | 'create_keyframe'
  | 'delete_keyframe'
  | 'create_animation'
  | 'generate_motion'
  | 'retarget_motion'
  | 'apply_ik'
  | 'apply_inbetween'
  | 'check_physics'
  | 'export_animation';

export interface AgentAction {
  tool: ToolName;
  args: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ToolError {
  code: string;
  message: string;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: ToolError;
}

/** 只读工具（预览可自动执行），其余为变更工具（需用户点执行，可撤销）。 */
export const READONLY_TOOLS: ReadonlySet<ToolName> = new Set([
  'inspect_skeleton',
  'check_physics',
]);

export function isToolName(v: unknown): v is ToolName {
  return (
    v === 'load_character' ||
    v === 'inspect_skeleton' ||
    v === 'select_bone' ||
    v === 'modify_bone' ||
    v === 'create_keyframe' ||
    v === 'delete_keyframe' ||
    v === 'create_animation' ||
    v === 'generate_motion' ||
    v === 'retarget_motion' ||
    v === 'apply_ik' ||
    v === 'apply_inbetween' ||
    v === 'check_physics' ||
    v === 'export_animation'
  );
}
