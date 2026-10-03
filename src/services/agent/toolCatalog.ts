import type { ToolName } from './toolTypes';

/**
 * 声明式工具目录 —— Agent 工具参数的**单一真相源**。
 *
 * 为什么要有它：此前参数知识只隐含在 toolRegistry 的 handler 函数体里，
 * MCP 只能发一句「参数见 editor_help」的占位描述 —— 而 editor_help 本身
 * 也无从得知真实参数。模型因此无法正确构造调用。
 *
 * 双层披露（省 context）：
 *   - 首发层 `briefSchema()`：每个工具一行描述 + 必填参数名。
 *     tools/list 全量下发时只占很小 context。
 *   - 全文层 `fullSchema(name)` / `fullSchemaAll()`：含类型、取值范围、
 *     语义说明、示例与错误码，供 editor_help 按需拉取。
 *
 * 参数与取值必须与 toolRegistry 的 handler 保持一致；
 * tests/toolCatalog.test.ts 用交叉校验锁住这条约束。
 */

export interface ToolParam {
  name: string;
  /** `number[][]` = 数值二维数组（如路径点序列 [[x,y,z],…]）。 */
  type: 'string' | 'number' | 'boolean' | 'number[]' | 'number[][]' | 'object' | 'object[]';
  /** 是否必填（对应 handler 里的 reqStr/reqNum）。 */
  required: boolean;
  desc: string;
  /** 可选：枚举取值。 */
  values?: readonly string[];
  /** 可选：示例值，帮助模型构造合法参数。 */
  example?: string | number | boolean;
}

export interface ToolDoc {
  name: ToolName;
  /** 一行职责。 */
  summary: string;
  /** 详细说明（仅全文层下发）。 */
  detail: string;
  /** 该工具会产生副作用、需用户确认。 */
  mutates: boolean;
  params: ToolParam[];
  /** 典型错误码，便于模型自纠。 */
  errors?: readonly string[];
}

type ParamExample = ToolParam['example'] | readonly unknown[];

const P = (
  name: string,
  type: ToolParam['type'],
  required: boolean,
  desc: string,
  extra: Omit<Partial<ToolParam>, 'example'> & { example?: ParamExample } = {},
): ToolParam => ({ name, type, required, desc, ...extra }) as ToolParam;

const VEC3 = '世界坐标 [x, y, z]';
const BONE = '骨骼名或语义名（如 "spine"、"upperArm.L"）';

/** 全部 22 个工具的声明式目录。 */
export const TOOL_DOCS: Record<ToolName, ToolDoc> = {
  load_character: {
    name: 'load_character',
    summary: '加载角色 GLB。',
    detail: '需用户拖入文件，Agent 无法代传文件路径。',
    mutates: true,
    params: [],
    errors: ['NEEDS_USER_FILE'],
  },
  inspect_skeleton: {
    name: 'inspect_skeleton',
    summary: '读骨架：骨名、语义、层级。',
    detail: '只读。返回每根骨的 name/semantic/parent。用于确认能操作哪些骨骼，不要凭空编造骨名。',
    mutates: false,
    params: [
      P('query', 'string', false, '按名称/语义过滤（大小写不敏感的部分匹配）；省略则返回全部'),
    ],
  },
  select_bone: {
    name: 'select_bone',
    summary: '选中一根骨骼。',
    detail: '按骨名或语义选中，供后续修改与打关键帧。',
    mutates: true,
    params: [P('bone', 'string', true, BONE, { example: 'upperArm.L' })],
    errors: ['BONE_NOT_FOUND'],
  },
  modify_bone: {
    name: 'modify_bone',
    summary: '改骨骼姿态（绝对或增量）。',
    detail:
      '四种模式至少给一种：rotationEulerDeg（绝对欧拉角，度）、rotationDeltaDeg（增量欧拉角）、position（绝对位置）、positionDelta（增量位置）。绝对值基于 rest 姿态。',
    mutates: true,
    params: [
      P('bone', 'string', true, BONE, { example: 'spine' }),
      P('rotationEulerDeg', 'number[]', false, '绝对欧拉角 [x,y,z] 度', { example: '[0, 8, 0]' }),
      P('rotationDeltaDeg', 'number[]', false, '增量欧拉角 [x,y,z] 度'),
      P('position', 'number[]', false, '绝对位置 [x,y,z]'),
      P('positionDelta', 'number[]', false, '增量位置 [x,y,z]'),
    ],
    errors: ['BONE_NOT_FOUND'],
  },
  create_keyframe: {
    name: 'create_keyframe',
    summary: '给骨骼在指定时间打关键帧。',
    detail: '默认取当前姿态作为该时刻的旋转关键帧。需已有活动动画（先 create_animation / generate_motion）。',
    mutates: true,
    params: [
      P('bone', 'string', true, BONE, { example: 'spine' }),
      P('time', 'number', false, '秒，默认当前时间', { example: 1.2 }),
      P('interp', 'string', false, '插值方式', { values: ['linear', 'step'], example: 'linear' }),
      P('includePosition', 'boolean', false, '是否同时记录位置关键帧'),
    ],
    errors: ['NO_ANIMATION', 'BONE_NOT_FOUND'],
  },
  delete_keyframe: {
    name: 'delete_keyframe',
    summary: '删除某骨骼某时刻的关键帧。',
    detail: '',
    mutates: true,
    params: [
      P('bone', 'string', true, BONE),
      P('time', 'number', true, '秒', { example: 1.2 }),
    ],
    errors: ['KEY_NOT_FOUND'],
  },
  create_animation: {
    name: 'create_animation',
    summary: '新建动画并设为活动动画。',
    detail: '',
    mutates: true,
    params: [P('name', 'string', false, '动画名', { example: 'Take 2' })],
  },
  generate_motion: {
    name: 'generate_motion',
    summary: '用自然语言生成/规划动作片段。',
    detail:
      '核心动作工具。给一句描述（如"先下蹲再挥剑"），返回规划好的时间段与模板轨道。',
    mutates: true,
    params: [
      P('prompt', 'string', true, '动作描述', { example: '角色从站立缓慢坐下再站起' }),
      P('clarification', 'string', false, '补充约束（≤1000字）'),
      P('segments', 'object[]', false, '显式分段规划，每段含 t0/t1/模板/强度'),
      P('interpretation', 'object', false, '对描述的理解结果：certainty(high/medium/low)、reasons[]、questions[]、missingInfo[]'),
      P('duration', 'number', false, '时长（秒），0.5–30；缺省由分段终点或默认值推断'),
    ],
    errors: ['NO_CHARACTER', 'BAD_ARGS'],
  },
  revise_action_segment: {
    name: 'revise_action_segment',
    summary: '修改已规划动作的某一段。',
    detail: '在已生成的 segments 上做局部修订：换模板、调强度/速度、改指向道具。',
    mutates: true,
    params: [
      P('segmentIndex', 'number', true, '要改的段序号', { example: 0 }),
      P('template', 'string', false, '换成哪个动作模板（如 march/sit/squat）'),
      P('intensity', 'number', false, '强度 0..1'),
      P('speed', 'number', false, '播放速度倍率'),
      P('targetPropId', 'string', false, '改指向的道具 id'),
      P('clause', 'string', false, '自然语言修订说明'),
    ],
  },
  set_scene_prop: {
    name: 'set_scene_prop',
    summary: '增删改场景道具。',
    detail: '操作 add/update/remove 三选一。',
    mutates: true,
    params: [
      P('operation', 'string', true, '操作类型', { values: ['add', 'update', 'remove'], example: 'add' }),
      P('kind', 'string', true, '道具类型（如 chair/sword）', { example: 'chair' }),
      P('id', 'string', false, '道具 id（update/remove 必填）'),
      P('position', 'number[]', false, `摆放位置 ${VEC3}`, { example: '[0, 0, -0.8]' }),
      P('size', 'number[]', false, '尺寸 [w,h,d]'),
      P('attachTo', 'string', false, '附着骨骼（手持道具）'),
      P('rotationY', 'number', false, '绕 Y 旋转弧度'),
    ],
  },
  set_previs_target: {
    name: 'set_previs_target',
    summary: '设定预演目标道具与距离。',
    detail: '影响走位/朝向计算。',
    mutates: true,
    params: [
      P('propId', 'string', false, '目标道具 id'),
      P('distanceMeters', 'number', false, '期望距离（米）', { example: 1.2 }),
    ],
  },
  set_previs_event: {
    name: 'set_previs_event',
    summary: '在预演动作上增改删事件标记。',
    detail: '用于让特效/音效对齐到某个时间点。',
    mutates: true,
    params: [
      P('operation', 'string', true, '操作', { values: ['add', 'update', 'remove'], example: 'add' }),
      P('actionIndex', 'number', true, '动作序号'),
      P('time', 'number', true, '时间（秒）', { example: 0.8 }),
      P('label', 'string', true, '事件标签（如 "swing"）', { example: 'swing' }),
      P('eventIndex', 'number', false, '事件序号（update/remove 必填）'),
    ],
  },
  set_camera_keyframe: {
    name: 'set_camera_keyframe',
    summary: '给镜头打关键帧。',
    detail: '需先生成预演动画。镜头字段可能被锁定（FIELD_LOCKED）。upsert 按 time 覆盖写入。',
    mutates: true,
    params: [
      P('operation', 'string', true, '操作', { values: ['upsert', 'remove'], example: 'upsert' }),
      P('time', 'number', true, '时间（秒）', { example: 0.5 }),
      // handler 对 upsert 强制要求这三个，目录漏了会让模型无从得知 → 必然 BAD_ARGS
      P('position', 'number[]', false, `机位 ${VEC3}`, { example: [2.5, 1.8, 3.2] }),
      P('target', 'number[]', false, `看向点 ${VEC3}`, { example: [0, 1, 0] }),
      P('fov', 'number', false, '视场角（度），15–100', { example: 45 }),
    ],
    errors: ['NO_ANIMATION', 'FIELD_LOCKED', 'BAD_ARGS'],
  },
  set_previs_effect: {
    name: 'set_previs_effect',
    summary: '给预演动作挂特效。',
    detail: '操作 add/update/remove。',
    mutates: true,
    params: [
      P('operation', 'string', true, '操作', { values: ['add', 'update', 'remove'], example: 'add' }),
      P('actionIndex', 'number', true, '动作序号'),
      P('kind', 'string', true, '特效类型'),
      P('time', 'number', true, '时间（秒）'),
      P('duration', 'number', true, '持续（秒）'),
      P('scale', 'number', false, '缩放'),
      P('color', 'string', false, '颜色'),
      // handler 要求 2–64 个三维点的数组；写成 string 会让模型直接传错类型
      P('path', 'number[][]', false, '特效路径：2–64 个三维点数组', { example: [[0, 1.3, 0], [0.4, 1.1, 0.6]] }),
      P('position', 'number[]', false, `位置 ${VEC3}`),
      P('bladeSweep', 'number[][]', false, '刀光扫掠样本：2–64 个 {base,tip} 对', { example: [{ base: [0, 1, 0], tip: [0, 1.8, 0] }] }),
      P('id', 'string', false, '特效 id（update/remove 必填）'),
    ],
  },
  set_face_keyframe: {
    name: 'set_face_keyframe',
    summary: '改表情/面部 morph。',
    detail: '操作 upsert/remove。targetName 为 morph 目标名。',
    mutates: true,
    params: [
      P('operation', 'string', true, '操作', { values: ['upsert', 'remove'], example: 'upsert' }),
      P('targetName', 'string', true, '面部 morph 目标名'),
      P('meshPath', 'string', false, '面部 mesh 路径'),
      P('time', 'number', true, '时间（秒）'),
      P('value', 'number', true, 'morph 强度 0..1', { example: 0.8 }),
    ],
  },
  retarget_motion: {
    name: 'retarget_motion',
    summary: '（已内建于 generate_motion）独立重定向。',
    detail: '保留占位，当前版本返回 RESERVED。',
    mutates: true,
    params: [],
    errors: ['RESERVED'],
  },
  apply_ik: {
    name: 'apply_ik',
    summary: '开关 IK 链或设 IK 目标。',
    detail: '需语义已映射到手臂/腿骨骼。IK 仅暂停时生效。',
    mutates: true,
    params: [
      P('chain', 'string', true, 'IK 链', { values: ['arm.L', 'arm.R', 'leg.L', 'leg.R'], example: 'arm.L' }),
      P('enable', 'boolean', false, '是否启用（缺省=切换）'),
      P('target', 'number[]', false, `IK 目标 ${VEC3}`),
      P('targetDelta', 'number[]', false, `目标增量 ${VEC3}（在当前目标上叠加，省去先查绝对坐标）`),
      P('polePoint', 'number[]', false, `极向量 ${VEC3}`),
    ],
    errors: ['CHAIN_MISSING'],
  },
  apply_inbetween: {
    name: 'apply_inbetween',
    summary: '两关键帧间自动补间。',
    detail: '在当前动画全程按密度与缓动补间。',
    mutates: true,
    params: [
      P('density', 'number', false, '补间密度 2..120', { example: 12 }),
      P('ease', 'string', false, '缓动', {
        values: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'easeOutIn'],
      }),
    ],
    errors: ['NO_ANIMATION'],
  },
  check_physics: {
    name: 'check_physics',
    summary: '体检：失衡/穿地/关节超限。',
    detail: '只读。需已有活动动画与角色骨骼（尤其 hips）。返回问题清单。',
    mutates: false,
    params: [],
    errors: ['NO_ANIMATION', 'NO_CHARACTER', 'NO_HIPS'],
  },
  repair_joint_limit: {
    name: 'repair_joint_limit',
    summary: '修复单关节超限。',
    detail: '把某骨某时刻的旋转夹回合法范围。',
    mutates: true,
    params: [
      P('boneName', 'string', false, '骨骼名'),
      P('time', 'number', false, '时间（秒），须在动画范围内'),
    ],
    errors: ['BAD_ARGS'],
  },
  repair_physics: {
    name: 'repair_physics',
    summary: '修复物理问题（穿地/失衡）。',
    detail: '可按 kind 指定修法。',
    mutates: true,
    params: [
      P('kind', 'string', false, '修复类型', { values: ['penetration', 'footSlide', 'accelSpike', 'balance'], example: 'penetration' }),
      P('foot', 'string', false, '指定脚', { values: ['L', 'R'], example: 'L' }),
      P('time', 'number', false, '时间（秒）'),
    ],
  },
  export_animation: {
    name: 'export_animation',
    summary: '导出动画为 GLB。',
    detail: '不指定 animationId 则导出全部动画。',
    mutates: false,
    params: [P('animationId', 'string', false, '只导出指定动画')],
    errors: ['NO_ANIMATION'],
  },
};

/** 全部工具名（按目录顺序）。 */
export const TOOL_DOC_NAMES = Object.keys(TOOL_DOCS) as ToolName[];

/** 首发层：单工具的精简 schema（一行描述 + 必填参数）。 */
export function briefSchema(name: ToolName): { name: ToolName; description: string; requiredArgs: string[] } {
  const d = TOOL_DOCS[name];
  const required = d.params.filter((p) => p.required).map((p) => p.name);
  return { name: d.name, description: d.summary, requiredArgs: required };
}

/** 首发层：全量精简 schema 列表。 */
export function briefSchemas(): Array<{ name: ToolName; description: string; requiredArgs: string[] }> {
  return TOOL_DOC_NAMES.map(briefSchema);
}

/** 全文层：单工具的完整文档（供 editor_help 按需拉取）。 */
export function fullSchema(name: ToolName): ToolDoc {
  return TOOL_DOCS[name];
}

/** 全文层：全部工具的完整文档。 */
export function fullSchemaAll(): ToolDoc[] {
  return TOOL_DOC_NAMES.map((n) => TOOL_DOCS[n]);
}
