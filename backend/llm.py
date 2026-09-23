"""真实 LLM 动作规划（P6，OPT-IN）。

仅当环境变量 LLM_API_KEY（+ 可选 LLM_BASE_URL / LLM_MODEL）配置齐全时启用，
调用 OpenAI-compatible /chat/completions，把自然语言拆成模板分段。
任何失败（无 key、超时、坏 JSON、未知模板）都回退启发式并给出 warning，
绝不假装 LLM 工作过。meta.planner 如实记录 'llm' 或 'heuristic'。
"""

from __future__ import annotations

import json
import os

import httpx

ALLOWED = ("wave", "bow", "march", "sword", "block", "kick", "sway")

SYSTEM = """You split a character-action description into ordered motion segments.
Reply with ONLY a JSON object: {"segments": [{"template": "wave|bow|march|sword|block|kick|sway", "span": <seconds:number>, "note": "<short>"}]}
Rules: keep input order; spans sum roughly to the given duration; unknown actions -> "sway". No prose."""


def llm_configured() -> tuple[bool, str]:
    base = os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("LLM_API_KEY", "")
    model = os.environ.get("LLM_MODEL", "")
    if not key or not model:
        return False, ""
    return True, f"{model}@{base}"


def try_llm_plan(prompt: str, duration: float) -> tuple[list[dict] | None, str | None, str | None]:
    """成功 → (segments, model, None)；失败 → (None, None, warning)。"""
    ok, _ = llm_configured()
    if not ok:
        return None, None, None
    base = os.environ["LLM_BASE_URL"] if "LLM_BASE_URL" in os.environ else "https://api.openai.com/v1"
    base = base.rstrip("/")
    model = os.environ["LLM_MODEL"]
    try:
        r = httpx.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {os.environ['LLM_API_KEY']}"},
            json={
                "model": model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": f"duration={duration}s\naction={prompt}"},
                ],
            },
            timeout=15,
        )
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        data = json.loads(content)
        raw = data.get("segments", [])
        if not raw:
            raise ValueError("empty segments")
        total = sum(max(float(s.get("span", 1)), 0.5) for s in raw)
        t = 0.0
        segments = []
        for s in raw:
            template = s.get("template", "sway")
            if template not in ALLOWED:
                template = "sway"
            span = max(float(s.get("span", 1)), 0.5) / total * duration
            segments.append(
                {"t0": round(t, 3), "t1": round(t + span, 3), "template": template, "clause": str(s.get("note", ""))[:40]}
            )
            t += span
        segments[-1]["t1"] = duration
        return segments, model, None
    except Exception as e:  # noqa: BLE001 — 任何 LLM 故障都回退，错误文本进 warning
        return None, None, f"LLM 规划失败，已回退启发式：{type(e).__name__}: {str(e)[:120]}"
