"""Agent 桥接中转（MCP ↔ 浏览器）。

为什么需要它：MCP server 与编辑器不在同一进程，**场景状态在浏览器里**。
Node 侧无法直接执行编辑器工具（TS 模块、且依赖浏览器 API），
所以这里用 FastAPI 当中转：

    MCP server ──HTTP──▶ 本模块(队列) ◀──WebSocket── 浏览器(持有状态，执行工具)

浏览器通过 WebSocket 主动拉取待执行请求、执行后回传结果；
MCP server 同步等待结果后返回。任一端不在线时明确报错，不静默挂起。
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

# 已知工具白名单（与前端 src/services/agent/toolTypes.ts 的 ToolName 保持一致）
TOOL_NAMES: set[str] = {
    "load_character", "inspect_skeleton", "select_bone", "modify_bone",
    "create_keyframe", "delete_keyframe", "create_animation", "generate_motion",
    "revise_action_segment", "set_scene_prop", "set_previs_target", "set_previs_event",
    "set_camera_keyframe", "set_previs_effect", "set_face_keyframe", "retarget_motion",
    "apply_ik", "apply_inbetween", "check_physics", "repair_joint_limit",
    "repair_physics", "export_animation",
}

MAX_BODY_BYTES = 512 * 1024
DEFAULT_TIMEOUT = 30.0
# 未取走的请求最多保留多久（秒），避免内存里堆积
PENDING_TTL = 300.0

router = APIRouter(prefix="/bridge", tags=["bridge"])

# request_id -> 待浏览器执行的请求
_pending: dict[str, dict[str, Any]] = {}
# request_id -> 结果
_results: dict[str, dict[str, Any]] = {}
_seq = 0
_lock = asyncio.Lock()
_clients: set[WebSocket] = set()


def _next_id() -> str:
    global _seq
    _seq += 1
    return f"req-{int(time.time() * 1000)}-{_seq}"


def _sweep_expired(now: float) -> None:
    for rid, item in list(_pending.items()):
        if now - item["created"] > PENDING_TTL:
            _pending.pop(rid, None)


@router.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "bridge": True, "tools": len(TOOL_NAMES), "clients": len(_clients)}


@router.post("/execute")
async def execute(payload: dict[str, Any]) -> dict[str, Any]:
    """MCP server 调用此端点：入队并等待浏览器执行结果。"""
    tool = payload.get("tool")
    if not isinstance(tool, str) or tool not in TOOL_NAMES:
        raise HTTPException(status_code=400, detail=f"未知工具：{tool!r}")

    raw_args = payload.get("args", {})
    if not isinstance(raw_args, dict):
        raise HTTPException(status_code=400, detail="args 必须是对象")

    body_size = len(str(raw_args).encode("utf-8"))
    if body_size > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="args 过大")

    async with _lock:
        _sweep_expired(time.monotonic())
        if not _clients:
            return {
                "ok": False,
                "error": "编辑器未连接。请打开编辑器页面并保持开启（Agent 桥接会自动连接）。",
            }
        rid = _next_id()
        _pending[rid] = {
            "tool": tool,
            "args": raw_args,
            "idempotencyKey": payload.get("idempotencyKey"),
            "created": time.monotonic(),
        }

    # 通知所有客户端有新请求
    for ws in list(_clients):
        with contextlib.suppress(Exception):
            await ws.send_json({"type": "pending", "id": rid})

    timeout = float(payload.get("timeout") or DEFAULT_TIMEOUT)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        async with _lock:
            if rid in _results:
                return _results.pop(rid)
            # 客户端已全部断开
            if not _clients:
                _pending.pop(rid, None)
                return {"ok": False, "error": "编辑器连接已断开，请求未执行。"}
        await asyncio.sleep(0.05)

    async with _lock:
        _pending.pop(rid, None)
    return {"ok": False, "error": f"编辑器未在 {timeout:.0f}s 内返回结果（执行状态未知，请先查询状态再决定是否重试）。"}


@router.get("/pending")
async def take_pending() -> dict[str, Any]:
    """浏览器轮询：取走待执行请求（无请求时返回空列表）。"""
    async with _lock:
        _sweep_expired(time.monotonic())
        if not _pending:
            return {"requests": []}
        items = [
            {"id": rid, "tool": item["tool"], "args": item["args"], "idempotencyKey": item["idempotencyKey"]}
            for rid, item in _pending.items()
        ]
        return {"requests": items}


@router.post("/result/{request_id}")
async def post_result(request_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """浏览器回传执行结果。"""
    async with _lock:
        if request_id not in _pending:
            raise HTTPException(status_code=404, detail="未知或已过期的 request_id")
        _pending.pop(request_id, None)
        _results[request_id] = payload if isinstance(payload, dict) else {"ok": False, "error": "结果格式无效"}
    return {"ok": True}


@router.websocket("/ws")
async def bridge_socket(websocket: WebSocket) -> None:
    """浏览器保持此连接以表明在线，并接收有新请求的通知。"""
    await websocket.accept()
    async with _lock:
        _clients.add(websocket)
    try:
        while True:
            # 客户端只需保持连接；真正的执行走 take_pending 轮询
            message = await websocket.receive_json()
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        async with _lock:
            _clients.discard(websocket)
