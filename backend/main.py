"""AI 3D Character Animation Editor — 后端（P5）。

端点：
  GET  /health
  POST /motion/generate   过程式模板动作（MOCK 质量，传输 REAL）
  （P7 /inbetween、P9 /physics/check 在此扩展）

运行见 README.md。
"""

from __future__ import annotations

import time
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from motion_mock import generate_tracks_planned, plan_prompt
from llm import llm_configured, try_llm_plan

app = FastAPI(title="AI 3D Animation Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5177", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Keyframe(BaseModel):
    time: float
    value: list[float]
    interp: Literal["linear", "step", "cubic"] = "linear"


class BoneTrack(BaseModel):
    boneName: str
    position: list[Keyframe] = []
    rotation: list[Keyframe] = []
    scale: list[Keyframe] = []


class AnimationData(BaseModel):
    id: str
    name: str
    duration: float
    fps: int
    tracks: list[BoneTrack]


class PlanSegment(BaseModel):
    t0: float
    t1: float
    template: Literal["wave", "bow", "march", "sword", "block", "kick", "sway"]
    clause: str = ""


class MotionMeta(BaseModel):
    provider: str = "backend-mock"
    source: Literal["real", "mock"] = "mock"
    template: str = ""
    templates: list[str] = []
    planner: str = "heuristic"
    model: str = ""
    segments: list[PlanSegment] = []
    warnings: list[str] = []


class MotionGenerateRequest(BaseModel):
    prompt: str = ""
    duration: float = Field(default=4, ge=0.5, le=30)
    fps: Literal[12, 24, 30, 60] = 30
    bones: dict[str, str] = {}
    rest: dict[str, list[float]] = {}
    seed: int = 0
    plan: list[PlanSegment] | None = None


class PlanRequest(BaseModel):
    prompt: str = ""
    duration: float = Field(default=4, ge=0.5, le=30)


class PlanResponse(BaseModel):
    segments: list[PlanSegment]
    planner: str
    model: str = ""
    warnings: list[str] = []


class MotionGenerateResponse(BaseModel):
    animation: AnimationData
    meta: MotionMeta


@app.get("/health")
def health() -> dict[str, object]:
    llm_ok, _ = llm_configured()
    providers = ["backend-mock", "planner-heuristic"] + (["planner-llm"] if llm_ok else [])
    return {"ok": True, "version": "0.2.0", "providers": providers, "llm": llm_ok}


def _plan(prompt: str, duration: float) -> tuple[list[dict], str, str, list[str]]:
    """LLM 优先（配 key 才真调），失败/未配回退启发式。返回 (segments, planner, model, warnings)。"""
    segments, model, warning = try_llm_plan(prompt, duration)
    if segments is not None:
        return segments, "llm", model or "", []
    from motion_mock import plan_prompt as heuristic_plan

    warns = [warning] if warning else []
    return heuristic_plan(prompt, duration), "heuristic", "", warns


@app.post("/motion/plan", response_model=PlanResponse)
def motion_plan(req: PlanRequest) -> PlanResponse:
    segments, planner, model, warnings = _plan(req.prompt, req.duration)
    return PlanResponse(
        segments=[PlanSegment(**s) for s in segments], planner=planner, model=model, warnings=warnings
    )


@app.post("/motion/generate", response_model=MotionGenerateResponse)
def motion_generate(req: MotionGenerateRequest) -> MotionGenerateResponse:
    t0 = time.perf_counter()
    warnings: list[str] = []
    if req.plan is not None:
        segments = [s.model_dump() for s in req.plan]
        planner, model = "external", ""
    else:
        segments, planner, model, warnings = _plan(req.prompt, req.duration)
    templates, tracks, w2 = generate_tracks_planned(req.bones, segments, req.duration, req.seed, req.rest)
    warnings.extend(w2)
    if not tracks:
        from fastapi import HTTPException

        raise HTTPException(status_code=422, detail="骨骼映射为空或无可用模板轨道（检查 bones 参数）")
    name = f"AI:{req.prompt[:12] or 'motion'}"
    anim = AnimationData(
        id=f"anim_{int(time.time() * 1000)}",
        name=name,
        duration=req.duration,
        fps=req.fps,
        tracks=[BoneTrack(**t) for t in tracks],
    )
    _ms = round((time.perf_counter() - t0) * 1000)
    return MotionGenerateResponse(
        animation=anim,
        meta=MotionMeta(
            template=templates[0] if templates else "",
            templates=templates,
            planner=planner,
            model=model,
            segments=[PlanSegment(**s) for s in segments],
            warnings=warnings,
        ),
    )
