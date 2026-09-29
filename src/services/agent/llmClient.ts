import type { AgentAction } from './toolTypes';
import { parseAction } from './toolRegistry';
import { parseClarificationRequest } from '../../core/previs/clarifications';
import { planClauses } from '../motion/procedural';
import { fetchWithTimeout, isRequestTimeout, REQUEST_TIMEOUT_MS } from '../httpTransport';

/** LLM 通道：anthropic（Claude 原生）/ openai（Codex）/ ollama（本地）/ custom（三方兼容）。 */
export type LLMKind = 'anthropic' | 'openai' | 'ollama' | 'custom';

export interface LLMConfig {
  kind: LLMKind;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface LLMPlan {
  reply: string;
  actions: AgentAction[];
  warnings: string[];
}

const MOTION_ACTION_RE = /走到|走向|走路|行走|跑步|跑向|挥手|招手|抬高|举起|抬起|下蹲|蹲下|站起|起身|坐下|躺下|躺倒|睡觉|翻身|拿起|拿取|放下|放到|开门|关门|回头|看向|转头|头向[左右]|转身|挥剑|挥刀|挥舞|格挡|攻击|踢腿|踢击|出拳|弯腰|鞠躬|伸手|呼吸|摇摆|点头/;
const OTHER_TOOL_ACTION_RE = /检查|诊断|修复|补帧|导出|保存|载入|删除|添加场景|移除|设置|镜头|摄像机|相机|特效|分镜|提示词|眨眼|表情|物理|脚滑|穿透|重心|关键帧|单独|动作段|当前段|修改|改成|改为|替换|撤销|重做/;

const MOTION_PLANNING_SYSTEM = `你是 3D 视频预演动作规划器。只输出严格有效的 JSON 对象，不要 Markdown、注释、占位文字或额外字段。顶层为 reply（字符串）和 actions（数组）。动作请求的 actions 不能是空数组，必须恰有一个 action 对象；action 对象只能有 tool 和 args 两个字段，tool 必须为 generate_motion。prompt、duration、segments、interpretation 必须放在 args 内，不能放在 action 外层，不能额外嵌套 args。args 中 prompt 为用户原句，duration 为秒数。segments 为动作阶段数组；每段必须有 t0、t1、template、clause，可选 intensity、speed。interpretation 必须有 certainty、reasons、missingInfo、questions，其中 certainty 为 high/medium/low，其余三项必须始终为字符串数组，缺项使用空数组。intensity 只能是 0.4–1.6，speed 只能是 0.5–2；未明确幅度/速度时省略这两个字段。时间从 0 开始，顺序连续递增并覆盖整个 duration。clause 必须准确描述该阶段对应的用户动作，保留手侧、身体部位、方向、对象和先后关系；禁止写“实际动作阶段”等泛化占位词。模板必须逐字使用以下之一：march、orient、sit、squat、kneel、lie、sleep、stand、reach、look、look_left、look_right、raise_left、raise_right、turn、wave、bow、sword、handoff、block、kick、punch、breath、sway。尤其头向右转用 look_right，头向左转用 look_left，走路用 march，不要自行拼造模板名。不得改变或丢弃用户原句中的否定、左右方向、物体、动作幅度、速度和先后关系，不得增加无关动作；复杂动作按自然阶段拆分。默认简单动作4秒、躺下/睡觉8秒，遵从用户明确时长。目标或支撑条件缺失时仍给安全草案，同时降低 interpretation.certainty 并填写 missingInfo/questions。服务会强制保留原文 prompt，不要改写。`;

function defaultMotionDuration(input: string): number {
  const explicit = input.match(/(?:时长|持续)?\s*(\d+(?:\.\d+)?)\s*(?:秒|s)(?![a-z])/i);
  if (explicit) return Math.min(Math.max(Number(explicit[1]), 0.5), 30);
  return /睡|躺|卧/.test(input) ? 8 : 4;
}

export function usesMotionPreviewPlanner(input: string): boolean {
  return MOTION_ACTION_RE.test(input) && !OTHER_TOOL_ACTION_RE.test(input);
}

function compactMotionSceneContext(sceneContext: string): string {
  return sceneContext.split('；').filter((item) =>
    item.startsWith('角色身高约')
    || item.startsWith('当前道具：')
    || item === '当前场景未放置道具',
  ).join('；');
}

export const SYSTEM = `你是 3D 角色动画编辑器的动作规划器。只允许调用以下工具：
inspect_skeleton, select_bone, modify_bone, create_keyframe, delete_keyframe,
create_animation, generate_motion, revise_action_segment, set_scene_prop, set_previs_target, set_previs_event, set_camera_keyframe, set_previs_effect, set_face_keyframe, apply_ik, apply_inbetween, check_physics, repair_joint_limit, repair_physics, export_animation.
（load_character 需用户传文件、retarget_motion 已内建，均不可用）

只输出 JSON 对象：{"reply":"一句话说明","actions":[{"tool":"...","args":{...}}]}，不输出其他文字。
- modify_bone 的 bone 可用骨骼名或语义（如 upperArm.L）；旋转用 rotationDeltaDeg（度，局部系）或 rotationEulerDeg；位移用 positionDelta。
- 四肢优先用 apply_ik：{"chain":"arm.L","enable":true,"targetDelta":[0,0.25,0]}，再对整链三块骨骼 create_keyframe。
- 单个静态姿势指令（如“左手抬高”“头向左转”）使用 modify_bone 并为受影响骨骼 create_keyframe。
- 有时间顺序或包含连续行为的描述（如“走到桌前，拿起手机，再回头看门口”“躺下再起身”“慢慢大幅挥剑”）必须调用 generate_motion，并把用户原句完整传入 prompt，不要缩写、改写成一个宽泛动作或只回报“已完成”。
- generate_motion 在 args 内提供 segments 数组，描述每个阶段的 t0/t1、template、clause、intensity、speed；涉及场景交互时用当前上下文中的 targetPropId 绑定每一段的目标，无交互目标时省略或设为 null。模板仅可使用 march（用于走路/行走）、orient、sit、squat、lie、sleep、stand、reach、look、look_left、look_right、raise_left、raise_right、turn、wave、bow、sword、handoff、block、kick、punch、breath、sway 等当前编辑器支持项。武器交接要把 handoff 作为独立阶段并绑定具体 sword ID，描述交给哪只手；时间必须递增并覆盖整个时长。未指定时长时，以动作分段最后的 t1 作为总时长。模型分段将作为预演生成输入，而不是只写在回复里。
- 对明确包含“攻击/格挡对手”的武打描述，若场景没有对应 opponent 道具，先调用 set_scene_prop 添加静态对手占位体，再生成动作；把接近、转向和攻击阶段的 targetPropId 绑定到该 opponent ID。多个对手未明确选择时必须先请求消歧。占位体只能用于距离和粗略接触提示，不得声称已生成第二个可动角色、真实命中或格挡模拟。
- generate_motion 还应返回 interpretation：{certainty:"high|medium|low",reasons:["判断依据"],missingInfo:["缺失信息"],questions:["需要用户确认的问题"]}。只对明确表达且有可播放阶段的意图给 high；对象、支撑面、方向、先后关系或场景条件不确定时降低置信度并列出可回答的问题；不能为了凑出动作而隐藏歧义。即使有问题也给出安全、可撤销的预演草案。
- 如果用户输入以 [预演澄清] 开头，generate_motion.prompt 必须只使用其中“原始描述(JSON)”的原文，并把“用户选择(JSON)”原文放入 args.clarification；不要把包装说明或问题文本塞入动作 prompt。若选择添加场景物体，先调用 set_scene_prop，再调用 generate_motion。
- 用户明确要求单独修改当前预演的某一段时，调用 revise_action_segment，只传目标段索引和实际需要改的字段；只调整幅度/速度时不要重写动作描述或模板。必须保留未选中段的时间与内容，不要重新生成整条动画。
- revise_action_segment 参数形如 {"segmentIndex":0,"intensity":1.2}，也可按需传 clause、template、speed、targetPropId；至少传一个修改字段。intensity 范围为 0.4–1.6，speed 范围为 0.5–2，超范围要先向用户说明而不是改成另一个值。targetPropId 必须来自当前场景道具 ID，null 表示解除绑定；template 必须是当前编辑器支持的动作模板。
- 用户要求添加、摆放、调整或移除场景/动作道具时使用 set_scene_prop。参数为 {"operation":"add|update|remove","kind":"room|bed|chair|sofa|table|door|phone|sword|opponent","id":"可选现有道具ID","position":[x,y,z],"rotationY":0,"size":{"width":1,"height":1,"length":1},"attachTo":"hand.R|hand.L|null"}；修改只作用于指定道具，武器可挂在左右手或解除挂接；sofa 是可坐的沙发支撑面；opponent 是可摆放的静态对手占位体，可作为武打动作目标，但不是会自主攻防的第二套骨架；移除后检查预演目标引用。
- 用户要求单独修改预演目标或人物与目标的距离时使用 set_previs_target。参数为 {"propId":"场景道具ID|null","distanceMeters":1.2|null}；只传需要修改的字段，null 表示清除该字段；不能虚构场景道具 ID。此工具会把新目标同步到相关走位动作并重建可播放路径；清除目标会解除相应动作绑定并清掉依赖该目标的距离。
- 用户要求单独添加、修改或移除预演事件时使用 set_previs_event。参数为 {"operation":"add|update|remove","eventIndex":0,"actionIndex":0,"time":1.2,"label":"动作触发说明"}；增改事件必须关联现有动作段，时间必须落在该动作段内；更新/移除使用当前上下文提供的事件索引。
- 用户要求修改镜头运动/机位时用 set_camera_keyframe；参数 {"operation":"upsert|remove","time":2,"position":[x,y,z],"target":[x,y,z],"fov":45}，秒数须在当前动画范围内，新增/修改后镜头路径启用。
- 用户要求添加、移动、调整或移除特效时用 set_previs_effect；参数 {"operation":"add|update|remove","id":"已有事件ID","kind":"slash|impact|dust|spark|smoke|energy","time":2,"actionIndex":0,"duration":0.4,"position":[x,y,z],"path":[[x,y,z],[x,y,z]],"bladeSweep":[{"base":[x,y,z],"tip":[x,y,z]},{"base":[x,y,z],"tip":[x,y,z]}],"scale":1,"color":"#f5b942"}。path 是 slash 拖尾的 2–64 个世界坐标剑尖轨迹点；bladeSweep 是 2–64 个同时间采样的剑柄端到剑尖线段。用户明确要求改挥砍轨迹时只更新目标事件对应字段；设为 null 可清除。新增或改时应绑定触发该效果的动作段，且 time 必须在该段范围内；只操作当前动画的特效。火花、烟雾和能量环是预演占位形状，按动作事件设定时间与位置。
- 修复 ScenePlan 中 slash 路径/剑身扫掠面与静态道具冲突的警告时，先从场景上下文读取警告指出的道具 ID 与目标特效 ID；仅更新该特效对应的 path 或 bladeSweep，参考现有 worldPath/worldBladeSweep 调整轨迹，不改事件时间、动作段、位置、持续时间或其他事件。无法判断安全路径时应说明并请求用户给出方向/路径，不要声称已完成碰撞求解。
- 用户要求表情或眨眼进入动画时用 set_face_keyframe；参数 {"operation":"upsert|remove","meshPath":"场景上下文中的稳定路径","targetName":"场景上下文中的 morph 名称","time":1.2,"value":0.8}。必须只使用当前角色真实存在的 morph 名称和路径，时间在动画范围内，权重 0–1；不要编造表情目标。
- 若一句描述同时包含身体动作和表情/眨眼，把身体阶段交给 generate_motion，并为每个表情时间点单独调用 set_face_keyframe；眨眼至少规划闭眼与睁眼关键帧，使用实际存在的左右眼目标。
- 躺下、睡觉等多阶段动作默认规划 8 秒；简单单步动作默认 4 秒，用户显式给出时长时优先遵循用户时长。
- 保留用户提到的物体、相对距离/方位、动作幅度（轻柔/大幅/用力）和速度（缓慢/快速）；这些将由场景预演规划器读取。不要把“走到桌前拿手机”缩成原地伸手。若收到场景上下文，按其中当前已摆放的物体与尺寸规划；generate_motion.prompt 仍只传用户原句。
- generate_motion 会读取当前场景物体并自动拆动作、设置距离目标和建议镜头；若有武器会建议挥砍特效事件。若物体不存在，明确说明目标缺失并保留可播放草案。
- 接触目前是可视化支撑/交互目标近似，不具备通用碰撞与抓握求解；不得声称已真实抓住物体、躺到受力平衡的床面或自动避开障碍。
- 用户明确要求修复已检查到的关节偏转超限时，使用 repair_joint_limit，参数为 {"boneName":"当前诊断中的骨骼名","time":问题时间秒}；只修复该骨骼附近的问题，变更可撤销。脚滑、穿透、重心和支撑问题仍只能检查，不能声称 AI 已自动修复。
- check_physics 会同时返回轨迹 issues、collisionFindings/collisionWarnings 和 supportWarnings；碰撞结果必须结合时间、身体部位和道具 ID 解释，并明确这是代理几何估算。现有 repair_physics 只支持脚滑、脚部穿透、落地加速度突变和重心失衡；不得把它用于全身碰撞、物体接触、持物或武器格挡，也不得声称这些已自动修复。用户明确要求修复场景穿透时，只有在可无歧义地判断该动作段/道具且用户已授权修改该字段时，才通过 revise_action_segment 或 set_scene_prop 单独修改；道具方位或动作意图不明确时先说明具体冲突并询问选项。每次修改后重新 check_physics 并报告残余告警；不得擅自挪动用户布置的家具。
- 用户明确要求修复已检查到的脚滑、脚部穿透、落地加速度突变或重心失衡时，使用 repair_physics，参数 kind 为 footSlide、penetration、accelSpike 或 balance，time 必须落入当前诊断区间；脚部问题还要传 foot 为 L 或 R。若检查结果在该时刻有多个同类脚部问题，必须补充 foot，不能任选其一。脚滑依赖已映射的 IK 链；balance 仅在质量骨覆盖足够且支撑脚有腿部 IK 链时尝试髋部配平，结果必须重新检查并报告残余问题；工具返回警告或无修复关键帧时如实说明。
- 不要编造骨骼名；不确定时先 inspect_skeleton。`;

function connectionError(provider: string, base: string, error: unknown): Error {
  if (isRequestTimeout(error)) {
    return new Error(`${provider} 请求超过 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒，已停止等待；请检查模型负载、缩短任务或选择更快的模型`);
  }
  return new Error(provider === 'Ollama'
    ? `连不上 ${base}（确认 ollama serve 在运行；浏览器跨域需 OLLAMA_ORIGINS 包含本页地址）`
    : `连不上 ${base}（检查地址与网络）`);
}

function newKey(prefix: string, n: number): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${n}`;
}

/** 模型输出 → 校验后的 actions（非法逐个丢弃并警告，不整体失败）。 */
export function toPlan(content: string, keyPrefix: string, model?: string, userInput = ''): LLMPlan {
  const warnings: string[] = [];
  const jsonText = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
  let parsed: { reply?: unknown; actions?: unknown };
  try {
    parsed = JSON.parse(jsonText) as { reply?: unknown; actions?: unknown };
  } catch {
    const preview = content.trim().replace(/\s+/g, ' ').slice(0, 180);
    throw new Error(preview
      ? `LLM 返回了非 JSON（已拒绝执行）；响应片段：${preview}`
      : 'LLM 返回了空内容或没有 JSON 对象（已拒绝执行）');
  }
  if (!Array.isArray(parsed.actions)) throw new Error('LLM 返回缺少 actions 数组');
  const actions: AgentAction[] = [];
  const clarification = parseClarificationRequest(userInput);
  const motionRequest = usesMotionPreviewPlanner(clarification?.originalPrompt ?? userInput);
  for (const raw of parsed.actions as unknown[]) {
    let r = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
    if (motionRequest && parsed.actions.length === 1 && r['tool'] === undefined) {
      const nested = typeof r['args'] === 'object' && r['args'] !== null ? r['args'] as Record<string, unknown> : null;
      const candidate = nested && typeof nested['prompt'] === 'string' && Array.isArray(nested['segments']) ? nested : r;
      if (typeof candidate['prompt'] === 'string' && Array.isArray(candidate['segments'])) {
        r = { tool: 'generate_motion', args: candidate };
        warnings.push('模型动作对象缺少 tool 外壳，已按唯一 generate_motion 动作修复');
      }
    }
    if (r['tool'] === 'generate_motion') {
      const args = typeof r['args'] === 'object' && r['args'] !== null ? { ...(r['args'] as Record<string, unknown>) } : {};
      const prompt = clarification?.originalPrompt ?? userInput;
      if (prompt.trim()) args['prompt'] = prompt;
      if (clarification) {
        args['prompt'] = clarification.originalPrompt;
        args['clarification'] = clarification.answer;
      }
      if (motionRequest) {
        const wantedDuration = defaultMotionDuration(prompt);
        const rawSegments = Array.isArray(args['segments']) ? args['segments'] : [];
        let processedSegments = rawSegments;
        const explicitGazeDirection = /(?:头|脑袋|脸)(?:部)?\s*(?:向|朝|往)\s*(?:左|右)(?:侧)?\s*(?:转|看|望)|(?:左|右)(?:转头|看向|望向)/.test(prompt);
        const ruleLook = planClauses(prompt, wantedDuration).find((segment) => ['look', 'look_left', 'look_right'].includes(segment.template));
        if (!explicitGazeDirection && ruleLook?.template === 'look') {
          let normalized = false;
          processedSegments = rawSegments.map((segment) => {
            if (typeof segment !== 'object' || segment === null) return segment;
            const value = { ...(segment as Record<string, unknown>) };
            if (value['template'] === 'look_left' || value['template'] === 'look_right') {
              value['template'] = 'look';
              value['clause'] = ruleLook.clause;
              normalized = true;
            }
            return value;
          });
          if (normalized) warnings.push('模型给未指定方向的注视增加了左右偏向，已按原文改为目标注视');
        }
        const lastEnd = processedSegments.reduce((end, segment) => {
          if (typeof segment !== 'object' || segment === null) return end;
          const t1 = (segment as Record<string, unknown>)['t1'];
          return typeof t1 === 'number' && Number.isFinite(t1) ? Math.max(end, t1) : end;
        }, 0);
        const sourceDuration = lastEnd > 0 ? lastEnd : args['duration'];
        if (Array.isArray(args['segments']) && typeof sourceDuration === 'number' && Number.isFinite(sourceDuration)
          && sourceDuration > 0 && Math.abs(sourceDuration - wantedDuration) > 1e-3) {
          const scale = wantedDuration / sourceDuration;
          args['segments'] = processedSegments.map((segment) => {
            if (typeof segment !== 'object' || segment === null) return segment;
            const value = { ...(segment as Record<string, unknown>) };
            if (typeof value['t0'] === 'number' && Number.isFinite(value['t0'])) value['t0'] *= scale;
            if (typeof value['t1'] === 'number' && Number.isFinite(value['t1'])) value['t1'] *= scale;
            return value;
          });
          warnings.push(`模型动作时间与请求时长不符，已按比例调整动作阶段至 ${wantedDuration} 秒`);
        } else args['segments'] = processedSegments;
        args['duration'] = wantedDuration;
      }
      args['_planner'] = 'llm';
      args['_plannerModel'] = model ?? keyPrefix;
      r['args'] = args;
    }
    if (typeof r['idempotencyKey'] !== 'string') r['idempotencyKey'] = newKey(keyPrefix, actions.length);
    const { action, error } = parseAction(r);
    if (!action) {
      warnings.push(`丢弃非法 action：${error}`);
      continue;
    }
    actions.push(action);
  }
  if (motionRequest && !actions.some((action) => action.tool === 'generate_motion')) {
    const detail = warnings.length > 0 ? `：${warnings.join('；')}` : '';
    throw new Error(`模型没有返回合法的 generate_motion action${detail}`);
  }
  return { reply: typeof parsed.reply === 'string' ? parsed.reply : '', actions, warnings };
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

/** OpenAI-compatible（含 Ollama /v1 与 Codex / 三方）：无 key 时不带 Authorization（Ollama CORS 需要）。 */
export async function planOpenAICompatible(input: string, cfg: LLMConfig, sceneContext = ''): Promise<LLMPlan> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!base) throw new Error('请先填写 Base URL');
  if (!cfg.model) throw new Error('请先填写模型名');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  const compactMotion = cfg.kind === 'ollama' && usesMotionPreviewPlanner(input);
  const requestSceneContext = compactMotion ? compactMotionSceneContext(sceneContext) : sceneContext;
  let res: Response;
  try {
    res = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: compactMotion ? 1024 : 2048,
        ...(compactMotion ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: compactMotion ? MOTION_PLANNING_SYSTEM : SYSTEM },
          { role: 'user', content: requestSceneContext ? `用户请求（generate_motion.prompt 必须原样传入这一行）：${input}\n当前场景上下文：${requestSceneContext}` : input },
        ],
      }),
    });
  } catch (error) {
    throw connectionError(cfg.kind === 'ollama' ? 'Ollama' : 'LLM', base, error);
  }
  if (!res.ok) throw new Error(`LLM ${res.status}：${await readError(res)}`);
  const data = (await res.json().catch((error) => {
    if (isRequestTimeout(error)) throw connectionError(cfg.kind === 'ollama' ? 'Ollama' : 'LLM', base, error);
    return null;
  })) as {
    choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; thinking?: unknown } }>;
  } | null;
  const message = data?.choices?.[0]?.message;
  const content = [message?.content, message?.reasoning_content, message?.thinking]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? '';
  if (!content) {
    const fields = message ? Object.keys(message).join(', ') : 'no message';
    throw new Error(`LLM 返回空内容（message fields: ${fields}）`);
  }
  return toPlan(content, 'http', cfg.model, input);
}

/** Claude 原生 Messages API（浏览器直调用 bearer 风格 x-api-key + 显式 CORS 许可头）。 */
export async function planAnthropic(input: string, cfg: LLMConfig, sceneContext = ''): Promise<LLMPlan> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!base) throw new Error('请先填写 Base URL');
  if (!cfg.model) throw new Error('请先填写模型名');
  if (!cfg.apiKey) throw new Error('Claude 通道需要 API Key（仅内存，不保存）');
  let res: Response;
  try {
    res = await fetchWithTimeout(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: 'user', content: sceneContext ? `用户请求（generate_motion.prompt 必须原样传入这一行）：${input}\n当前场景上下文：${sceneContext}` : input }],
      }),
    });
  } catch (error) {
    if (isRequestTimeout(error)) throw connectionError('Claude', base, error);
    throw new Error(`连不上 ${base}（检查网络；浏览器直连需该头被允许，失败可改走后端代理）`);
  }
  if (!res.ok) throw new Error(`Claude ${res.status}：${await readError(res)}`);
  const data = (await res.json().catch(() => null)) as {
    content?: Array<{ type?: string; text?: string }>;
  } | null;
  const text = (data?.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
  return toPlan(text, 'claude', cfg.model, input);
}

async function planOllamaMotion(input: string, cfg: LLMConfig, sceneContext: string): Promise<LLMPlan> {
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!base) throw new Error('请先填写 Ollama 地址');
  if (!cfg.model) throw new Error('请先填写 Ollama 模型名');
  const requestSceneContext = compactMotionSceneContext(sceneContext);
  const userContent = requestSceneContext
    ? `用户请求（generate_motion.prompt 必须原样传入这一行）：${input}\n当前场景上下文：${requestSceneContext}`
    : input;
  let response: Response;
  try {
    response = await fetchWithTimeout(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        think: false,
        format: 'json',
        options: { temperature: 0.2, num_predict: 1024 },
        messages: [
          { role: 'system', content: MOTION_PLANNING_SYSTEM },
          { role: 'user', content: userContent },
        ],
      }),
    });
  } catch (error) {
    throw connectionError('Ollama', base, error);
  }
  if (!response.ok) throw new Error(`Ollama ${response.status}：${await readError(response)}`);
  const data = await response.json().catch((error) => {
    if (isRequestTimeout(error)) throw connectionError('Ollama', base, error);
    return null;
  }) as { message?: { content?: unknown } } | null;
  const content = typeof data?.message?.content === 'string' ? data.message.content : '';
  if (!content.trim()) throw new Error('Ollama 返回空动作 JSON；请检查本地模型是否支持 JSON 格式输出');
  return toPlan(content, 'ollama', cfg.model, input);
}

async function planOllamaAgent(input: string, cfg: LLMConfig, sceneContext: string): Promise<LLMPlan> {
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!base) throw new Error('请先填写 Ollama 地址');
  if (!cfg.model) throw new Error('请先填写 Ollama 模型名');
  const userContent = sceneContext ? `用户请求：${input}\n当前场景上下文：${sceneContext}` : input;
  let response: Response;
  try {
    response = await fetchWithTimeout(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        think: false,
        format: 'json',
        options: { temperature: 0.2, num_predict: 2048 },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userContent },
        ],
      }),
    });
  } catch (error) {
    throw connectionError('Ollama', base, error);
  }
  if (!response.ok) throw new Error(`Ollama ${response.status}：${await readError(response)}`);
  const data = await response.json().catch((error) => {
    if (isRequestTimeout(error)) throw connectionError('Ollama', base, error);
    return null;
  }) as { message?: { content?: unknown } } | null;
  const content = typeof data?.message?.content === 'string' ? data.message.content : '';
  if (!content.trim()) throw new Error('Ollama 返回空工具 JSON；请检查本地模型是否支持 JSON 格式输出');
  return toPlan(content, 'ollama', cfg.model, input);
}

export async function planWithLLM(input: string, cfg: LLMConfig, sceneContext = ''): Promise<LLMPlan> {
  if (cfg.kind === 'anthropic') return planAnthropic(input, cfg, sceneContext);
  if (cfg.kind === 'ollama') {
    return usesMotionPreviewPlanner(input)
      ? planOllamaMotion(input, cfg, sceneContext)
      : planOllamaAgent(input, cfg, sceneContext);
  }
  return planOpenAICompatible(input, cfg, sceneContext);
}

const PHYSICS_SUMMARY_SYSTEM = `你是3D预演物理诊断解读助手。只根据给定的本地检查结果写简短中文总结，输出严格JSON：{"summary":"..."}。说明具体动作时间、身体部位、道具和严重程度；碰撞/支撑结果是代理几何估算，不是完整物理模拟。不得声称已修复、不得编造数据、不得调用或建议执行工具。无告警时只能说本次采样未发现问题，并指出这不证明真实物理绝对安全。`;

function parsePhysicsSummary(content: string): string {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI 物理解读没有返回 JSON');
  const parsed = JSON.parse(content.slice(start, end + 1)) as { summary?: unknown };
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('AI 物理解读缺少 summary');
  return parsed.summary.trim().slice(0, 600);
}

/** Summarize an already executed, read-only physics check without allowing a second tool call. */
export async function summarizePhysicsResult(
  prompt: string,
  result: { ok: boolean; data?: unknown; error?: { code: string; message: string } },
  cfg: LLMConfig,
): Promise<string> {
  const data = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
  const findings = Array.isArray(data['collisionFindings']) ? data['collisionFindings'].map((finding) => {
    if (!finding || typeof finding !== 'object') return finding;
    const item = finding as Record<string, unknown>;
    return Object.fromEntries(['propId', 'bodyPart', 'time', 'estimatedOverlapMeters', 'opponentContact', 'opponentZone'].flatMap((key) =>
      item[key] === undefined ? [] : [[key, item[key]]],
    ));
  }) : [];
  const diagnostic = JSON.stringify({
    request: prompt,
    success: result.ok,
    ...(result.error ? { error: result.error } : {}),
    issues: Array.isArray(data['issues']) ? data['issues'] : [],
    collisionFindings: findings,
    collisionWarnings: Array.isArray(data['collisionWarnings']) ? data['collisionWarnings'] : [],
    supportWarnings: Array.isArray(data['supportWarnings']) ? data['supportWarnings'] : [],
    warnings: Array.isArray(data['warnings']) ? data['warnings'] : [],
  });
  const userContent = `用户问题：${prompt}\n已执行的诊断结果：${diagnostic}`;
  let content = '';
  if (cfg.kind === 'ollama') {
    const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    if (!base || !cfg.model) throw new Error('请先填写 Ollama 地址和模型名');
    let response: Response;
    try {
      response = await fetchWithTimeout(`${base}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, stream: false, think: false, format: 'json',
          options: { temperature: 0.1, num_predict: 512 },
          messages: [{ role: 'system', content: PHYSICS_SUMMARY_SYSTEM }, { role: 'user', content: userContent }] }),
      });
    } catch (error) { throw connectionError('Ollama', base, error); }
    if (!response.ok) throw new Error(`Ollama ${response.status}：${await readError(response)}`);
    const body = await response.json().catch(() => null) as { message?: { content?: unknown } } | null;
    content = typeof body?.message?.content === 'string' ? body.message.content : '';
  } else if (cfg.kind === 'anthropic') {
    const base = cfg.baseUrl.replace(/\/+$/, '');
    if (!cfg.apiKey) throw new Error('Claude 通道需要 API Key');
    let response: Response;
    try {
      response = await fetchWithTimeout(`${base}/v1/messages`, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      }, body: JSON.stringify({ model: cfg.model, max_tokens: 512, system: PHYSICS_SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: userContent }] }) });
    } catch (error) { throw connectionError('Claude', base, error); }
    if (!response.ok) throw new Error(`Claude ${response.status}：${await readError(response)}`);
    const body = await response.json().catch(() => null) as { content?: Array<{ type?: string; text?: string }> } | null;
    content = (body?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
  } else {
    const base = cfg.baseUrl.replace(/\/+$/, '');
    if (!base) throw new Error('请先填写 Base URL');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({
        model: cfg.model, temperature: 0.1, max_tokens: 512, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: PHYSICS_SUMMARY_SYSTEM }, { role: 'user', content: userContent }],
      }) });
    } catch (error) { throw connectionError('LLM', base, error); }
    if (!response.ok) throw new Error(`LLM ${response.status}：${await readError(response)}`);
    const body = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const value = body?.choices?.[0]?.message?.content;
    content = typeof value === 'string' ? value : '';
  }
  return parsePhysicsSummary(content);
}

/** Ollama 本地模型列表（GET /api/tags，无需 key；base 形如 http://host:port/v1）。 */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!base) throw new Error('请先填写 Ollama 地址');
  let res: Response;
  try {
    res = await fetchWithTimeout(`${base}/api/tags`, {}, 10_000);
  } catch (error) {
    if (isRequestTimeout(error)) throw new Error(`Ollama 模型列表请求超时：${base}`);
    throw new Error(`连不上 ${base}（确认 ollama serve 在运行）`);
  }
  if (!res.ok) throw new Error(`Ollama ${res.status}：${await readError(res)}`);
  const data = (await res.json().catch((error) => {
    if (isRequestTimeout(error)) throw new Error(`Ollama 模型列表请求超时：${base}`);
    return null;
  })) as { models?: Array<{ name?: string }> } | null;
  return (data?.models ?? []).map((m) => m.name ?? '').filter(Boolean);
}
