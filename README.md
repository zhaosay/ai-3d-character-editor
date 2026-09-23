# AI 3D Character Animation Editor（Cascadeur Lite，开源、AI Native）

轻量、现代、AI 原生的 3D 角色动画编辑器：**上传人物 → 描述动作 → AI 生成 → 时间轴编辑 → IK/AutoPosing/物理修正 → 导出**。

> 第一阶段 Demo 定位：**武侠角色动作编辑器**（拔剑 / 格挡 / 踢腿 / 踏步等模板开箱即用）。

## 运行

```bash
npm install
npm run dev        # 前端 http://localhost:5177
```

可选后端（动作生成的 HTTP 通道；不启动则用本地 Mock，功能一致）：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/uvicorn main:app --app-dir backend --port 8123
```

验证：`npm run test`（前端 vitest）、`backend/.venv/bin/python backend/test_api.py`（后端）、`npm run build`。

角色来源：左侧点 **示例男角色 / 示例女角色** 即开即用（程序化武侠人物：17 骨骼全语义映射，男宽肩束发、女长发髻，修长四肢，右侧主题面板可换肤色/服装/骨骼/网格/阴影，导出拖回骨骼保留）；
或拖入外部 GLB（公开模型见 `public/samples/README.md`）。

操作：顶部 🤖 AI 命令条直接对话改动作（一键快捷指令）；`空格`=播放/暂停，`Ctrl+Z`=撤销，`Ctrl+Y`=重做。

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

## 动作模板关键词（过程式，中英）

| 模板 | 关键词 |
|---|---|
| wave | 挥手 / 抬手 / wave |
| bow | 鞠躬 / 点头 / bow |
| sword | 拔剑 / 挥剑 / 刺剑 / 舞剑 / sword |
| block | 格挡 / 防御 / block |
| kick | 踢腿 / 扫腿 / kick |
| march | 踏步 / 走 / 跑 / march |
| sway | 未命中时的站立摇摆占位（会警告） |

支持多子句连招（“拔剑，然后格挡，最后踢腿”→ 三段合成）。

## REAL / MOCK 诚实对照表

| 功能 | 状态 | 说明 |
|---|---|---|
| Viewer / 导入 / 骨骼 / Timeline / Pose / IK | REAL | 自研采样、双骨 IK、50 步 Undo |
| 项目存取 / GLB 导出 | REAL | 导出 clip 可拖回播放验证 |
| Provider 链路（本地/HTTP） | REAL | 传输层真实 |
| 动作内容（7 模板） | MOCK | 过程式正弦，`source=mock` 如实标注 |
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
