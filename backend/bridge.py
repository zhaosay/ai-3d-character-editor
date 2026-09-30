"""Agent 桥接中转（MCP ↔ 浏览器）。

为什么需要它：MCP server 与编辑器不在同一进程，**场景状态在浏览器里**。
Node 侧无法直接执行编辑器工具（TS 模块、且依赖浏览器 API），
所以这里用 FastAPI 当中转：

    MCP server ──HTTP──▶ 本模块(队列) ◀──WebSocket── 浏览器(持有状态，执行工具)

浏览器通过 WebSocket 主动拉取待执行请求、执行后回传结果；
MCP server 同步等待结果后返回。任一端不在线时明确报错，不静默挂起。

两个必须守住的安全/正确性约束：

1. **必须鉴权。** 本服务的 CORS 允许局域网任意来源（编辑器按设计暴露在
   私网），若无 token，任何能访问本端口的页面都能在编辑器打开时驱动它改场景。
   因此所有会改变状态的端点都要求 `BRIDGE_TOKEN`（常量时间比较）。
   WebSocket 无法自定义 header，故用 `?token=` 查询参数。

2. **单一消费者。** 多个浏览器标签页都会连上来；若每个都能取走同一请求，
   一个写操作会被执行多次（重复插关键帧、重复导出处）。因此
   `/bridge/pending` 采用 **claim 语义**：请求被某个客户端取走后即从队列移除，
   并记录 claimed_by；第二个标签页拿不到。
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import os
import time
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, WebSocket, WebSocketDisconnect

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


def _bridge_token() -> str | None:
    """共享密钥。未配置时桥接整体关闭（fail-closed，绝不默认放行）。"""
    token = os.environ.get("BRIDGE_TOKEN", "").strip()
    return token or None


def _token_ok(candidate: str | None) -> bool:
    expected = _bridge_token()
    if expected is None:
        return False
    if not candidate:
        return False
    return hmac.compare_digest(candidate, expected)


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    prefix = "Bearer "
    if authorization.startswith(prefix):
        return authorization[len(prefix):]
    return authorization


def _require_auth(authorization: str | None) -> None:
    if _bridge_token() is None:
        raise HTTPException(
            status_code=503,
            detail="桥接未启用：后端未设置 BRIDGE_TOKEN，已按 fail-closed 拒绝所有请求。",
        )
    if not _token_ok(_extract_bearer(authorization)):
        raise HTTPException(status_code=401, detail="缺少或错误的桥接令牌")


router = APIRouter(prefix="/bridge", tags=["bridge"])

# request_id -> 待浏览器执行的请求
_pending: dict[str, dict[str, Any]] = {}
# request_id -> 已被某个客户端 claim、等待回传结果的请求
_claimed: dict[str, dict[str, Any]] = {}
# request_id -> 结果
_results: dict[str, dict[str, Any]] = {}
_seq = 0
_lock = asyncio.Lock()
_clients: set[WebSocket] = set()
# client_id -> WebSocket，用于把请求投递给特定客户端
_client_sockets: dict[str, WebSocket] = {}


def _next_id() -> str:
    global _seq
    _seq += 1
    return f"req-{int(time.time() * 1000)}-{_seq}"


def _sweep_expired(now: float) -> None:
    for rid, item in list(_pending.items()):
        if now - item["created"] > PENDING_TTL:
            _pending.pop(rid, None)
    for rid, item in list(_claimed.items()):
        if now - item["created"] > PENDING_TTL:
            _claimed.pop(rid, None)


async def _broadcast(message: dict[str, Any]) -> None:
    """通知所有客户端有新请求（真正的执行走 /pending 轮询 claim）。"""
    for ws in list(_clients):
        with contextlib.suppress(Exception):
            await ws.send_json(message)


@router.get("/health")
async def health() -> dict[str, Any]:
    """健康检查：公开只读，用于确认桥接是否启用，不泄露任何敏感信息。"""
    return {
        "ok": True,
        "bridge": True,
        "tools": len(TOOL_NAMES),
        "clients": len(_clients),
        # 前端据此决定是否连接；enabled=False 时不发起任何请求
        "enabled": _bridge_token() is not None,
    }


@router.post("/execute")
async def execute(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """MCP server 调用此端点：入队并等待浏览器执行结果。"""
    _require_auth(authorization)

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

    await _broadcast({"type": "pending", "id": rid})

    timeout = float(payload.get("timeout") or DEFAULT_TIMEOUT)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        async with _lock:
            if rid in _results:
                return _results.pop(rid)
            # 客户端已全部断开
            if not _clients:
                _pending.pop(rid, None)
                _claimed.pop(rid, None)
                return {"ok": False, "error": "编辑器连接已断开，请求未执行。"}
        await asyncio.sleep(0.05)

    async with _lock:
        _pending.pop(rid, None)
        _claimed.pop(rid, None)
    return {"ok": False, "error": f"编辑器未在 {timeout:.0f}s 内返回结果（执行状态未知，请先查询状态再决定是否重试）。"}


@router.get("/pending")
async def take_pending(
    clientId: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """浏览器轮询：**claim** 语义 —— 取走的请求立刻出队，别的标签页拿不到。

    防止多标签页重复执行写操作（重复插关键帧、重复导出处）。
    """
    _require_auth(authorization)

    cid = clientId or "anonymous"
    async with _lock:
        _sweep_expired(time.monotonic())
        items: list[dict[str, Any]] = []
        for rid in list(_pending.keys()):
            item = _pending.pop(rid)  # claim：出队，转入 _claimed 等回传结果
            _claimed[rid] = item
            items.append({
                "id": rid,
                "tool": item["tool"],
                "args": item["args"],
                "idempotencyKey": item["idempotencyKey"],
            })
        return {"requests": items, "claimedBy": cid}


@router.post("/result/{request_id}")
async def post_result(
    request_id: str,
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """浏览器回传执行结果。"""
    _require_auth(authorization)
    async with _lock:
        if request_id not in _pending and request_id not in _claimed and request_id not in _results:
            raise HTTPException(status_code=404, detail="未知或已过期的 request_id")
        _pending.pop(request_id, None)
        _claimed.pop(request_id, None)
        _results[request_id] = payload if isinstance(payload, dict) else {"ok": False, "error": "结果格式无效"}
    return {"ok": True}


@router.websocket("/ws")
async def bridge_socket(websocket: WebSocket, token: str | None = Query(default=None)) -> None:
    """浏览器保持此连接以表明在线，并接收有新请求的通知。

    WebSocket 握手无法自定义 header，令牌走查询参数。
    """
    if not _token_ok(token):
        # 握手阶段拒绝：直接关闭，不进入应用逻辑
        await websocket.close(code=4401)
        return

    await websocket.accept()
    client_id = ""
    async with _lock:
        try:
            first = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
            if isinstance(first, dict):
                client_id = str(first.get("clientId") or "")
        except (asyncio.TimeoutError, Exception):
            client_id = ""
        _clients.add(websocket)
        if client_id:
            _client_sockets[client_id] = websocket
    try:
        while True:
            message = await websocket.receive_json()
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with _lock:
            _clients.discard(websocket)
            if client_id and _client_sockets.get(client_id) is websocket:
                _client_sockets.pop(client_id, None)
