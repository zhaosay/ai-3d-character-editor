"""Server-side, resource-aware adapters for the local visual generation tools."""

from __future__ import annotations

import os
import re
import base64
import binascii
import struct
import uuid
import zlib
from pathlib import Path
from typing import Literal

import httpx
from fastapi import HTTPException

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
SCHEDULER_URL = os.environ.get("AI_SCHEDULER_URL", "http://127.0.0.1:8090/api/v1").rstrip("/")
VPIPE_URL = os.environ.get("VPIPE_URL", "http://127.0.0.1:8900").rstrip("/")
DEFAULT_CHECKPOINT = os.environ.get("COMFY_CHECKPOINT", "RealVisXL_V5.0_Lightning_fp16.safetensors")
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def decode_previs_reference(encoded: str) -> bytes:
    try:
        image = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="预演参考图不是有效的 Base64 PNG") from exc
    if len(image) > 15_000_000 or len(image) < 8 or image[:8] != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(status_code=422, detail="预演参考图必须是有效且不超过 15 MB 的 PNG")

    offset = 8
    width = height = bit_depth = color_type = interlace = None
    compressed: list[bytes] = []
    saw_idat = False
    saw_iend = False
    chunk_index = 0
    while offset + 12 <= len(image):
        chunk_length = int.from_bytes(image[offset:offset + 4], "big")
        chunk_end = offset + 12 + chunk_length
        if chunk_end > len(image):
            break
        kind = image[offset + 4:offset + 8]
        data = image[offset + 8:offset + 8 + chunk_length]
        checksum = int.from_bytes(image[offset + 8 + chunk_length:chunk_end], "big")
        if zlib.crc32(kind + data) & 0xFFFFFFFF != checksum:
            break
        if chunk_index == 0:
            if kind != b"IHDR" or chunk_length != 13:
                break
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", data)
            if compression != 0 or filtering != 0 or interlace != 0:
                break
            if width < 64 or height < 64 or width > 4096 or height > 4096 or width * height > 4_000_000:
                raise HTTPException(status_code=422, detail="预演参考图尺寸超出支持范围（最大 4 百万像素）")
        elif kind == b"IDAT":
            saw_idat = True
            compressed.append(data)
        elif kind == b"IEND":
            saw_iend = chunk_length == 0
            offset = chunk_end
            break
        elif saw_idat:
            # PNG image data must be consecutive; rejecting later chunks keeps the decoder bounded.
            break
        offset = chunk_end
        chunk_index += 1

    if not saw_iend or offset != len(image) or not saw_idat or width is None or height is None:
        raise HTTPException(status_code=422, detail="预演参考图 PNG 数据损坏")
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(color_type)
    if channels is None or bit_depth not in {1, 2, 4, 8, 16} or color_type in {2, 4, 6} and bit_depth < 8:
        raise HTTPException(status_code=422, detail="预演参考图使用了不支持的 PNG 像素格式")
    expected_size = height * ((width * channels * bit_depth + 7) // 8 + 1)
    try:
        decoder = zlib.decompressobj()
        pixels = decoder.decompress(b"".join(compressed), expected_size + 1)
    except zlib.error as exc:
        raise HTTPException(status_code=422, detail="预演参考图 PNG 像素数据损坏") from exc
    if len(pixels) != expected_size or not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
        raise HTTPException(status_code=422, detail="预演参考图 PNG 像素数据损坏")
    stride = expected_size // height
    if any(pixels[row * stride] > 4 for row in range(height)):
        raise HTTPException(status_code=422, detail="预演参考图 PNG 行滤镜数据损坏")
    return image


async def upload_comfy_reference(encoded: str) -> str:
    image = decode_previs_reference(encoded)
    filename = f"AI3D_previs_reference_{uuid.uuid4().hex}.png"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{COMFY_URL}/upload/image",
                data={"overwrite": "true", "type": "input"},
                files={"image": (filename, image, "image/png")},
            )
            response.raise_for_status()
            result = response.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail="ComfyUI 拒绝接收预演参考图") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"无法上传预演参考图到 ComfyUI：{exc}") from exc
    if not isinstance(result, dict) or result.get("name") != filename:
        raise HTTPException(status_code=502, detail="ComfyUI 未确认预演参考图上传")
    return filename


def build_previs_image_workflow(
    prompt: str, negative_prompt: str, width: int, height: int, seed: int,
    reference_image: str | None = None,
) -> dict:
    """Build a fixed, built-in-node-only graph; callers cannot submit arbitrary node graphs."""
    workflow = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": DEFAULT_CHECKPOINT}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "5": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 6, "cfg": 1.5, "sampler_name": "dpmpp_sde",
            "scheduler": "karras", "denoise": 1.0, "model": ["1", 0],
            "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0],
        }},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"filename_prefix": "AI3D_previs", "images": ["6", 0]}},
    }
    if reference_image:
        if not re.fullmatch(r"AI3D_previs_reference_[a-f0-9]{32}\.png", reference_image):
            raise HTTPException(status_code=422, detail="无效的预演参考图名称")
        workflow["8"] = {"class_type": "LoadImage", "inputs": {"image": reference_image}}
        workflow["9"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["8", 0], "vae": ["1", 2]}}
        workflow["5"]["inputs"]["latent_image"] = ["9", 0]
        workflow["5"]["inputs"]["denoise"] = 0.38
    return workflow


async def _json_request(url: str, *, timeout: float = 8, **kwargs) -> dict:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request("GET" if "json" not in kwargs else "POST", url, **kwargs)
            response.raise_for_status()
            return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"本地生成服务暂不可用：{exc}") from exc


async def comfy_readiness() -> dict:
    scheduler, queue = await __import__("asyncio").gather(
        _json_request(f"{SCHEDULER_URL}/status"),
        _json_request(f"{COMFY_URL}/queue"),
    )
    system = scheduler.get("system", {})
    gpu_busy = (system.get("gpu_util_pct") or 0) >= 85
    memory_busy = (scheduler.get("memory", {}).get("percent") or 0) >= 95
    vpipe_active = any(
        service.get("name") in {"vpipe", "vpipe-queue"} and service.get("status") == "running"
        for service in scheduler.get("services", [])
        if service.get("name") == scheduler.get("current")
    )
    comfy_busy = bool(queue.get("queue_running") or queue.get("queue_pending"))
    busy_reason = (
        "V-Pipe 正在运行，请等待视频任务结束" if vpipe_active
        else "ComfyUI 队列已有任务，请等待完成" if comfy_busy
        else "GPU 繁忙，等待当前生成任务结束" if gpu_busy or memory_busy
        else None
    )
    return {
        "available": not (gpu_busy or memory_busy or vpipe_active or comfy_busy),
        "gpuUtilPct": system.get("gpu_util_pct"),
        "memoryPercent": scheduler.get("memory", {}).get("percent"),
        "comfyQueued": comfy_busy,
        "reason": busy_reason,
    }


def _gateway_key() -> str:
    key = os.environ.get("VPIPE_API_KEY", "").strip()
    if key:
        return key
    key_file = Path(os.environ.get(
        "VPIPE_API_KEY_FILE",
        str(Path(__file__).resolve().parents[2] / "vpipe-gateway" / "data" / "gateway_key.txt"),
    ))
    try:
        return key_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise HTTPException(status_code=503, detail="未配置 VPIPE_API_KEY 或可读的本地 Gateway key 文件") from exc


def _job_id(job_id: str) -> str:
    if not JOB_ID_RE.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="无效的生成任务 ID")
    return job_id


async def vpipe_request(path: str, *, method: str = "GET", payload: dict | None = None, timeout: float = 15) -> dict:
    headers = {"Authorization": f"Bearer {_gateway_key()}"}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(method, f"{VPIPE_URL}{path}", headers=headers, json=payload)
            response.raise_for_status()
            return response.json()
    except httpx.HTTPStatusError as exc:
        body = exc.response.text[:500]
        raise HTTPException(status_code=exc.response.status_code, detail=f"V-Pipe 请求失败：{body}") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"V-Pipe Gateway 暂不可用：{exc}") from exc


async def vpipe_video_stream(job_id: str, range_header: str | None = None):
    job_id = _job_id(job_id)
    headers = {"Authorization": f"Bearer {_gateway_key()}"}
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            if range_header:
                headers["Range"] = range_header
            response = await client.get(f"{VPIPE_URL}/jobs/{job_id}/file", headers=headers)
            response.raise_for_status()
            return response.content, response.status_code, {
                name: value for name, value in response.headers.items()
                if name.lower() in {"content-range", "accept-ranges", "content-length"}
            }
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail="V-Pipe 视频文件暂不可用") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"V-Pipe 视频获取失败：{exc}") from exc


def validate_vpipe_style(style: str) -> Literal["", "real", "anime", "3d"]:
    if style not in {"", "real", "anime", "3d"}:
        raise HTTPException(status_code=422, detail="视频风格必须是 real、anime、3d 或空")
    return style  # type: ignore[return-value]
