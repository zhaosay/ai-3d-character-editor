# Backend（P5–P6 + 武侠模板）

FastAPI 后端：`/health` + `POST /motion/plan` + `POST /motion/generate`（过程式模板，动作质量 MOCK，传输 REAL）。

当前预演分镜面板还可通过后端提交 ComfyUI 静帧，并将提示词或已生成静帧交给 V-Pipe；Gateway key 只由后端读取（`VPIPE_API_KEY` / `VPIPE_API_KEY_FILE`），不会发送给浏览器。ComfyUI 图像生成使用固定的内置节点图；GPU 使用率达到 85% 或内存达到 95% 时拒绝新图片任务，避免与正在运行的生成争抢资源。默认 ComfyUI 地址为 `http://127.0.0.1:8188`，默认 V-Pipe Gateway 为 `http://127.0.0.1:8900`；可分别用 `COMFY_URL` 和 `VPIPE_URL` 覆盖。

## 动作模板（与前端 `procedural.ts` 同构）

`wave`（挥手）/ `bow`（鞠躬）/ `sword`（拔剑）/ `block`（格挡）/ `kick`（踢腿）/ `march`（踏步）/ `sway`（占位）。
武侠单发模板（sword/block/kick）为起势→发力→收势包络，段内回到起点，可循环拼接。

## 启动

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/uvicorn main:app --app-dir backend --port 8123
```

> 注：本机 8000 端口已被其他服务占用，后端默认使用 **8123**，前端默认 Base URL 与之对应。

## 真实 LLM 规划（OPT-IN，P6）

默认规划为确定性启发式（`planner=heuristic`）。配置以下环境变量后，
`/motion/plan` 与 `/motion/generate` 改用真实模型做语言理解（`planner=llm`），
合成仍为过程式模板（`source=mock`），失败自动回退并警告：

`/motion/generate` 的 `meta.motion_space` 描述返回骨骼轨道的坐标约定：
`{"length_unit":"m|cm|mm","up_axis":"Y|Z","handedness":"right"}`。
编辑器将已声明轨道转换为右手系、Y-up、米制；旧服务缺少该字段时会明确显示“按米/Y-up 解释”的假设。
可选的 `meta.bone_mapping` 使用“Provider 返回骨骼名 → 当前请求的骨骼语义或骨骼名”映射，例如 `{"mixamorig:RightArm":"upperArm.R"}`；未声明映射时会自动识别标准语义名，其余未知轨道会保留并由 Agent 报告无法绑定。
新增 REAL Provider 时必须按轨道实际坐标填写，不要根据接口传输是否成功推断动作质量。

`/motion/generate` 请求除兼容旧版的 `bones` / `rest` 外，也携带 `rest_positions` 与 `skeleton`：后者给出根骨骼名称、骨骼语义、父骨骼名称及每个节点的静息局部位置/旋转/缩放。新 Provider 可据此还原目标角色层级并进行姿态重定向；这些字段目前只建立传输契约，后端模板生成器尚未消费它们，也不代表已接入 MDM 或完成 retarget。

```bash
export LLM_BASE_URL="https://api.openai.com/v1"  # 或任意 OpenAI-compatible 地址
export LLM_API_KEY="sk-..."
export LLM_MODEL="gpt-4o-mini"
backend/.venv/bin/uvicorn main:app --app-dir backend --port 8123
```

## 验证

```bash
curl 127.0.0.1:8123/health
curl -X POST 127.0.0.1:8123/motion/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"挥手","duration":2,"fps":30,"bones":{"upperArm.R":"ArmR","forearm.R":"ForeR","head":"Head"}}'
```

## 测试（标准库断言，无需 pytest）

```bash
backend/.venv/bin/python backend/test_api.py
```
