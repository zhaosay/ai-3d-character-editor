# Backend（P5–P6 + 武侠模板）

FastAPI 后端：`/health` + `POST /motion/plan` + `POST /motion/generate`（过程式模板，动作质量 MOCK，传输 REAL）。

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
