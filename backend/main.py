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
from fastapi import HTTPException, Request
import httpx
from pydantic import BaseModel, Field
from fastapi.responses import Response

from motion_mock import generate_tracks_planned, plan_prompt
from llm import llm_configured, try_llm_plan
from bridge import router as bridge_router

from media_integrations import (
    COMFY_URL, build_previs_image_workflow, comfy_readiness, vpipe_request,
    vpipe_video_stream, validate_vpipe_style,
)

app = FastAPI(title="AI 3D Animation Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5177", "http://localhost:3000"],
    # The editor is intentionally exposed on a private LAN by the scheduler.
    # Keep browser calls from common RFC1918 addresses working without opening
    # this development-only action API to arbitrary public origins.
    allow_origin_regex=r"^https?://(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

# Agent 桥接中转（MCP ↔ 浏览器）。放在 CORS 之后以便阅读。
app.include_router(bridge_router)


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
    template: Literal["wave", "bow", "march", "reach", "look", "look_left", "look_right", "raise_left", "raise_right", "turn", "orient", "sit", "squat", "kneel", "lie", "sleep", "stand", "sword", "handoff", "block", "kick", "punch", "breath", "sway"]
    clause: str = ""


class MotionSpace(BaseModel):
    length_unit: Literal["m", "cm", "mm"] = "m"
    up_axis: Literal["Y", "Z"] = "Y"
    handedness: Literal["right"] = "right"


class RestLocalTransform(BaseModel):
    position: list[float]
    quaternion: list[float]
    scale: list[float]


class MotionSkeletonNode(BaseModel):
    name: str
    semantic: str | None = None
    parentName: str | None = None
    restLocal: RestLocalTransform
    isEndSite: bool = False


class MotionSkeleton(BaseModel):
    roots: list[str] = []
    nodes: list[MotionSkeletonNode] = []


class MotionMeta(BaseModel):
    provider: str = "backend-mock"
    source: Literal["real", "mock"] = "mock"
    template: str = ""
    templates: list[str] = []
    planner: str = "heuristic"
    model: str = ""
    segments: list[PlanSegment] = []
    warnings: list[str] = []
    motion_space: MotionSpace | None = None
    bone_mapping: dict[str, str] | None = None


class MotionGenerateRequest(BaseModel):
    prompt: str = ""
    duration: float = Field(default=4, ge=0.5, le=30)
    fps: Literal[12, 24, 30, 60] = 30
    bones: dict[str, str] = {}
    rest: dict[str, list[float]] = {}
    rest_positions: dict[str, list[float]] = {}
    skeleton: MotionSkeleton | None = None
    seed: int = 0
    scene_context: str = ""
    plan: list[PlanSegment] | None = None


class PlanRequest(BaseModel):
    prompt: str = ""
    duration: float = Field(default=4, ge=0.5, le=30)
    scene_context: str = ""


class PlanResponse(BaseModel):
    segments: list[PlanSegment]
    planner: str
    model: str = ""
    warnings: list[str] = []


class MotionGenerateResponse(BaseModel):
    animation: AnimationData
    meta: MotionMeta


class PrevisImageRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    negative_prompt: str = Field(default="blurry, text, watermark, extra limbs, malformed hands", max_length=2000)
    width: int = Field(default=768, ge=512, le=1024, multiple_of=64)
    height: int = Field(default=768, ge=512, le=1024, multiple_of=64)
    seed: int = Field(default=9162026, ge=0, le=2**53 - 1)
    reference_image_base64: str | None = Field(default=None, max_length=20_000_000)


class VpipeGenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    style: Literal["", "real", "anime", "3d"] = "real"
    width: int = Field(default=960, ge=544, le=1280, multiple_of=32)
    height: int = Field(default=544, ge=544, le=1280, multiple_of=32)
    duration_sec: float = Field(default=5.2, ge=1, le=10)
    seed: int | None = Field(default=None, ge=0, le=2**53 - 1)
    image_base64: str | None = Field(default=None, max_length=40_000_000)


@app.get("/health")
def health() -> dict[str, object]:
    llm_ok, _ = llm_configured()
    providers = ["backend-mock", "planner-heuristic"] + (["planner-llm"] if llm_ok else [])
    return {"ok": True, "version": "0.2.0", "providers": providers, "llm": llm_ok}


@app.get("/integrations/comfy/status")
async def comfy_status() -> dict[str, object]:
    from media_integrations import _json_request

    try:
        ready = await comfy_readiness()
    except Exception:
        try:
            await _json_request(f"{COMFY_URL}/system_stats")
        except Exception:
            return {"connected": False, "available": False, "reason": "ComfyUI 未连接"}
        return {
            "connected": True,
            "available": False,
            "reason": "无法确认 GPU 排程或 ComfyUI 队列状态；为避免任务争抢，暂不提交新生成任务",
        }
    try:
        await _json_request(f"{COMFY_URL}/system_stats")
        ready["connected"] = True
    except Exception:
        ready["connected"] = False
        ready["available"] = False
        ready["reason"] = "ComfyUI 未连接"
    return ready


@app.post("/integrations/comfy/jobs")
async def create_comfy_job(req: PrevisImageRequest) -> dict[str, str]:
    from media_integrations import _json_request, upload_comfy_reference

    ready = await comfy_readiness()
    if not ready["available"]:
        raise HTTPException(status_code=409, detail=ready["reason"])
    reference_image = await upload_comfy_reference(req.reference_image_base64) if req.reference_image_base64 else None
    workflow = build_previs_image_workflow(
        req.prompt, req.negative_prompt, req.width, req.height, req.seed, reference_image,
    )
    result = await _json_request(f"{COMFY_URL}/prompt", timeout=15, json={"prompt": workflow})
    prompt_id = result.get("prompt_id")
    if not isinstance(prompt_id, str):
        raise HTTPException(status_code=502, detail="ComfyUI 未返回 prompt_id")
    return {"jobId": prompt_id, "status": "queued"}


@app.get("/integrations/comfy/jobs/{job_id}")
async def get_comfy_job(job_id: str) -> dict[str, object]:
    from media_integrations import _job_id, _json_request

    job_id = _job_id(job_id)
    history = await _json_request(f"{COMFY_URL}/history/{job_id}")
    entry = history.get(job_id)
    if not entry:
        return {"jobId": job_id, "status": "running", "images": []}
    images = [
        {"filename": image.get("filename"), "subfolder": image.get("subfolder", ""), "type": image.get("type", "output")}
        for node in entry.get("outputs", {}).values()
        for image in node.get("images", [])
    ]
    execution = entry.get("status", {})
    status_text = execution.get("status_str", "") if isinstance(execution, dict) else ""
    failed = status_text.lower() in {"error", "failed"}
    return {
        "jobId": job_id,
        "status": "failed" if failed else "completed" if images else "running",
        "images": images,
        "error": execution.get("messages") if failed and isinstance(execution, dict) else None,
    }


@app.get("/integrations/comfy/jobs/{job_id}/image")
async def get_comfy_image(job_id: str) -> Response:
    from media_integrations import _job_id, _json_request

    job_id = _job_id(job_id)
    history = await _json_request(f"{COMFY_URL}/history/{job_id}")
    entry = history.get(job_id)
    images = [image for node in (entry or {}).get("outputs", {}).values() for image in node.get("images", [])]
    if not images:
        raise HTTPException(status_code=404, detail="图片尚未生成")
    image = images[0]
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            response = await client.get(f"{COMFY_URL}/view", params={
                "filename": image["filename"], "subfolder": image.get("subfolder", ""), "type": image.get("type", "output"),
            })
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=503, detail=f"ComfyUI 图片读取失败：{exc}") from exc
        return Response(response.content, media_type=response.headers.get("content-type", "image/png"))


@app.get("/integrations/vpipe/status")
async def vpipe_status() -> dict[str, object]:
    result = await vpipe_request("/health", timeout=5)
    return {"connected": bool(result.get("ok")), **result}


@app.post("/integrations/vpipe/jobs")
async def create_vpipe_job(req: VpipeGenerateRequest) -> dict[str, object]:
    readiness = await comfy_readiness()
    if not readiness["available"]:
        raise HTTPException(
            status_code=409,
            detail=readiness.get("reason") or "生成资源繁忙，请等待当前任务完成后重试",
        )
    style = validate_vpipe_style(req.style)
    image_mode = bool(req.image_base64)
    path = "/generate/image-to-video" if image_mode else "/generate/text-to-video"
    payload: dict[str, object] = {
        "prompt": req.prompt, "style": style, "width": req.width, "height": req.height,
        "durationSec": req.duration_sec,
    }
    if req.seed is not None:
        payload["seed"] = req.seed
    if image_mode:
        payload["imageBase64"] = req.image_base64
    return await vpipe_request(path, method="POST", payload=payload, timeout=30)


@app.get("/integrations/vpipe/jobs/{job_id}")
async def get_vpipe_job(job_id: str) -> dict[str, object]:
    from media_integrations import _job_id

    return await vpipe_request(f"/jobs/{_job_id(job_id)}")


@app.get("/integrations/vpipe/jobs/{job_id}/file")
async def get_vpipe_video(job_id: str, request: Request) -> Response:
    content, status, headers = await vpipe_video_stream(job_id, request.headers.get("range"))
    return Response(content, media_type="video/mp4", status_code=status, headers=headers)


def _plan(prompt: str, duration: float, scene_context: str = "") -> tuple[list[dict], str, str, list[str]]:
    """LLM 优先（配 key 才真调），失败/未配回退启发式。返回 (segments, planner, model, warnings)。"""
    segments, model, warning = try_llm_plan(prompt, duration, scene_context)
    if segments is not None:
        return segments, "llm", model or "", []
    from motion_mock import plan_prompt as heuristic_plan

    warns = [warning] if warning else []
    return heuristic_plan(prompt, duration), "heuristic", "", warns


@app.post("/motion/plan", response_model=PlanResponse)
def motion_plan(req: PlanRequest) -> PlanResponse:
    segments, planner, model, warnings = _plan(req.prompt, req.duration, req.scene_context)
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
        segments, planner, model, warnings = _plan(req.prompt, req.duration, req.scene_context)
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
            motion_space=MotionSpace(),
        ),
    )
