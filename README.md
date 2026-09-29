# AI 3D Character Animation Editor（Cascadeur Lite，开源、AI Native）

轻量、现代、AI 原生的 3D 角色动画编辑器：**上传人物 → 描述动作 → AI 生成 → 时间轴编辑 → IK/AutoPosing/物理修正 → 导出**。

> 第一阶段 Demo 定位：**武侠角色动作编辑器**（拔剑 / 格挡 / 踢腿 / 踏步等模板开箱即用）。

## 运行

```bash
npm install
npm run serve        # 推荐：常驻拉起前后端 → http://localhost:5173/
```

`serve` 用 `nohup` + PID 文件常驻，**不会随终端关闭被回收**（直接 `npm run dev` 前台跑，关掉终端就没了）。
其余子命令：`npm run serve:status` / `serve:restart` / `serve:stop`。

后端默认 8123，通常已被本机 `~/AI/bin/ai-daemon.py` 反向代理托管，脚本会自动识别并跳过自启（不会重复拉起造成端口冲突）。

手动分别启动（调试用）：

```bash
npm run dev                                        # 前端 http://localhost:5173
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/uvicorn main:app --app-dir backend --port 8123
```

后端不启动则自动用本地 Mock，动作生成功能一致。

验证：`npm run test`（前端 vitest）、`backend/.venv/bin/python backend/test_api.py`（后端）、`npm run build`。

角色来源：左侧 **真人男 Soldier**（在线，Mixamo 骨架）/ **CesiumMan**（内置离线，CC-BY-4.0）一键加载；
或粘贴 Ready Player Me 自建真人 `.glb` 链接（demo.readyplayer.me 免费捏脸，男女自选）；
或拖入外部 GLB；离线保底有程序化示例男女（右侧主题可换肤色/服装）。
公开模型见 `public/samples/README.md`，署名见 `public/samples/ATTRIBUTION.md`。

操作：顶部 🤖 AI 命令条直接对话改动作（一键快捷指令）；`空格`=播放/暂停，`Ctrl+Z`=撤销，`Ctrl+Y`=重做。
右侧 Inspector 为悬浮弹窗（右上 ✕ 关闭，不挤压视口）。生成动作后会显示"X/Y 轨道已绑定"，未绑定的骨骼会点名（换角色后需重新生成）。

## 功能地图

- **P1** 3D Viewport（Orbit/Grid/阴影/FPS/SkeletonHelper）+ GLB 拖拽导入 + Skeleton Explorer（语义映射，兼容 Mixamo/VRoid/任意命名）
- **P2** Timeline（播放/循环/scrub/打点/拖 key）+ Rotation 姿势编辑 + Undo/Redo
- **P3** 双骨 IK + 极向量 + 关节钳制（左/右手、左/右脚），防膝反折/翻转
- **P4** 多动画管理 + `project.json` 存取 + GLB 导出（含 AnimationClip，可拖回验证）
- **P5** MotionProvider 架构（本地 Mock / HTTP 双通道）+ FastAPI 后端
- **P6** 自然语言分段规划（启发式默认，LLM OPT-IN）+ 多段合成
- **P7** 数学补帧（lerp/slerp+缓动，可撤销）+ AI 补帧接口预留
- **P8** AutoPosing（重心高度/躯干倾斜 + 双脚 IK 钉住）
- **P9** Physics Assistant（穿透/脚滑/加速度突变检查 + 一键修复）
- **P10** AI 助手（本地规则 / Claude / Codex / Ollama / 三方兼容，Tool Calling，变更需确认）

## AI 助手模型通道

| 通道 | 接口 | 默认配置 | 说明 |
|---|---|---|---|
| 本地规则 | — | — | 确定性代码（MOCK 智能），离线可用 |
| Claude | `POST {base}/v1/messages`（Anthropic 原生） | `claude-sonnet-5` | Key 只存内存；浏览器直连 |
| Codex | OpenAI-compatible `/chat/completions` | `gpt-5-codex` | Key 只存内存 |
| Ollama | 本地 `/v1/chat/completions` | `qwen3:8b`（面板可拉取本地列表，选中自动） | 免 Key（故意不带 Authorization，避免 CORS 预检失败）；跨域被拒设 `OLLAMA_ORIGINS` |
| 三方兼容 | OpenAI-compatible `/chat/completions` | 空（自填） | DeepSeek 等，有 Key 才带 Authorization |

模型只输出 `{reply, actions}` JSON 并经 `parseAction` 逐个校验；非法 action 丢弃并警告，不整体失败。
助手面板另有一键快捷指令（左手抬高 / 下蹲 / 生成挥手动作 / 检查脚滑 / 补帧），点即发送。

连接 LLM 后，`generate_motion` 会携带按时间排列的动作段（模板、动作描述、幅度、速度），由编辑器校验后驱动预演；未连接 LLM 时才使用本地规则拆解。Agent 遵循动作面板选中的本地或 HTTP Motion Provider，并把结构化分段传给后端。后端返回 `source=mock` 时使用过程式模板；返回 `source=real` 时保留其骨骼轨道，但必须先通过 AnimationData 校验。界面和项目分别记录规划来源与动作质量来源，不把模板结果标成真实动捕。
Agent 还能在确认后单独改动作段、增删改场景道具/镜头关键帧/特效事件；提示词面板可使用当前 LLM 增强 ComfyUI 与 V-Pipe 文案的视觉风格和跨镜头连续性。

## 动作模板关键词（过程式，中英；相对各绑定静息的偏移量，T-pose/A-pose 通用）

| 模板 | 关键词 |
|---|---|
| wave | 挥手 / 抬手 / wave |
| bow | 鞠躬 / 点头 / bow |
| sword | 拔剑 / 挥剑 / 刺剑 / 舞剑 / sword |
| block | 格挡 / 防御 / block |
| kick | 踢腿 / 扫腿 / kick |
| breath | 呼吸 / 待机 / breath（每段一次缓慢起伏，站立待机） |
| march | 踏步 / 走 / 跑 / march |
| sway | 未命中时的站立摇摆占位（会警告） |

支持多子句连招（“拔剑，然后格挡，最后踢腿”→ 三段合成）。

## 人物定制（程序化示例角色）

右侧 **人物定制**面板可调：**体型**（身高 1.55–1.95m、瘦↔壮、性别）、**面部**（鹅蛋/圆/方/心形/长脸、眼睛大小、眉厚、鼻大小、嘴宽）、**发型**（光头/寸头/短发/波波头/长发 + 发色）、**皮肤**（肤色、亮↔哑质感、服装色），并有 6 个预设一键起手。

实现说明：
- 参数与派生系数在 `src/core/character/appearance.ts`（纯函数、可单测）；非法输入一律钳制/回退，不崩。
- 身高/体型通过缩放骨骼位置与部件几何实现；头颈只吸收 35% 身高、30% 体型变化，避免"巨人小头/巨头"。
- 改动会重建程序化网格并刷新骨骼（骨骼名不变，动作轨道继续可用），配方 `appearanceSource` 随项目保存，打开时按配方还原。
- **仅对程序化示例角色生效**：外部 GLB 无法改体型/面部（需重新拓扑），只能换色。

## 写实预览与真人资产路线

- 右侧 **写实预览**面板：曝光 / 环境反射 / 主光 / 补光 / 轮廓光 / 半球光（ACES + 内置摄影棚环境，**只影响预览，不随 GLB 导出**——导出效果以目标引擎为准，浏览器验收为准）。
- 右侧 **表情**面板：模型自带 blendshape（ARKit 等）时自动出现，可实时试权重，并把指定表情/眨眼权重记录为动画关键帧；与身体共用播放头、撤销历史、项目保存和 GLB 动画导出。AI 可用当前角色真实 morph 名称单独增删关键帧。
- 右侧 **待机律动**面板：一键生成 4s 呼吸待机（进时间轴，可播放/导出/撤销）；自动眨眼仍可实时补充，但对已有手工眨眼轨道让出控制权，且不覆盖已录制的脸部关键帧。
- **人物资产建议**：先做**一个**写实中国人物样板（自然面部、真实皮肤贴图、头发层次、身体+面部绑定），在浏览器近景/全身/动作三档验收后再扩展。目标定**写实游戏级**；特写实拍级需要影视资产与离线渲染，与本工作流冲突，暂不做。
- AI 照片转 3D 只适合辅助（补背面/贴图灵感），不能一步得到可编辑绑定人物；手绘捏人保留为风格化路线。

## REAL / MOCK 诚实对照表

| 功能 | 状态 | 说明 |
|---|---|---|
| Viewer / 导入 / 骨骼 / Timeline / Pose / IK | REAL | 自研采样、双骨 IK、50 步 Undo |
| 项目存取 / GLB 导出 | REAL | 导出 clip 可拖回播放验证 |
| Provider 链路（本地/HTTP） | REAL | 传输层真实 |
| 本地 / 当前 HTTP 后端动作内容 | MOCK | 当前过程式动作模板，`source=mock` 如实标注；有效的外部 `source=real` 骨骼轨道可由 Provider 接受 |
| 语言理解 | heuristic（MOCK 智能）/ llm（配 key 后 REAL） | `meta.planner` 记录 |
| 数学补帧 / AutoPosing / 物理检查修复 | REAL | 本地算法 |
| AI 补帧 / 独立 retarget | 预留（MOCK） | 明确报错，不假装成功 |
| FBX / BVH 导出 | 未实现 | 不设假按钮 |

## 架构速览

```
components/* → stores/* (zustand) → core/* (纯逻辑，可单测) → three 场景
services/* (loader/export/motion/inbetween/agent) 为 IO 与 AI 边界
backend/ (FastAPI) 仅经 MotionProvider / Agent HTTP 通道接入
```

AI 永不直写场景：`LLM → JSON Action → 校验 → toolRegistry → stores/core → undo 压栈`。
