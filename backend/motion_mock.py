"""过程式动作模板（MOCK 质量，与前端 procedural.ts 同构）。

P6 新增：自然语言分段规划（启发式，确定性）+ 多段合成。
真实 LLM 规划在 llm.py（配 key 才启用），合成仍为过程式，meta 如实标注。
"""

from __future__ import annotations

import math
import re
from typing import Literal

STEP = 0.25
TIME_EPS = 1e-4
Interp = Literal["linear", "step", "cubic"]


def euler_xyz_to_quat(x_deg: float, y_deg: float, z_deg: float) -> list[float]:    # 与 three.js Quaternion.setFromEuler XYZ 分支逐行一致
    x, y, z = math.radians(x_deg), math.radians(y_deg), math.radians(z_deg)
    c1, s1 = math.cos(x / 2), math.sin(x / 2)
    c2, s2 = math.cos(y / 2), math.sin(y / 2)
    c3, s3 = math.cos(z / 2), math.sin(z / 2)
    return [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    ]


def quat_mul(a: list[float], b: list[float]) -> list[float]:
    """四元数乘法 a⊗b（与 three.js Quaternion.multiply 语义一致：先作用 b）。"""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


def compose_rest_offset(rest: list[float] | None, x_deg: float, y_deg: float, z_deg: float) -> list[float]:
    """模板输出相对静息的偏移量；rest 缺失时退化为绝对欧拉。"""
    if rest is None or len(rest) != 4:
        return euler_xyz_to_quat(x_deg, y_deg, z_deg)
    return quat_mul(list(rest), euler_xyz_to_quat(x_deg, y_deg, z_deg))


KNOWN_TEMPLATES = ("wave", "bow", "march", "sword", "block", "kick", "sway")


def pick_template(prompt: str) -> str:
    p = prompt.lower()
    # 武侠优先：避免“挥剑”被 wave 的“挥”截胡（“挥手”不含“剑”，不受影响）
    if any(k in p for k in ("sword", "slash", "draw", "stab")) or any(k in prompt for k in ("拔剑", "挥剑", "刺剑", "劈剑", "舞剑", "剑")):
        return "sword"
    if any(k in p for k in ("block", "parry", "guard", "defend")) or any(k in prompt for k in ("格挡", "防御", "抵挡", "招架")):
        return "block"
    if any(k in p for k in ("kick",)) or any(k in prompt for k in ("踢", "扫腿", "鞭腿")):
        return "kick"
    if any(k in p for k in ("wave", "hello")) or any(k in prompt for k in ("挥", "抬手", "招手")):
        return "wave"
    if any(k in p for k in ("bow", "nod")) or any(k in prompt for k in ("鞠", "躬", "点头")):
        return "bow"
    if any(k in p for k in ("march", "walk", "run")) or any(k in prompt for k in ("踏步", "走", "跑")):
        return "march"
    return "sway"


def _schedules(template: str, phase: float):
    tau = math.pi * 2
    if template == "wave":
        return {
            "upperArm.R": lambda t: (0, 0, -55 + 20 * math.sin(tau * (t + phase))),
            "forearm.R": lambda t: (0, 0, -20 + 22 * math.sin(tau * (2 * t + phase))),
            "upperArm.L": lambda t: (0, 0, 0),
            "head": lambda t: (0, 8 * math.sin(tau * (t + phase)), 0),
        }
    if template == "bow":
        return {
            "spine": lambda t: (38 * math.sin(math.pi * t), 0, 0),
            "head": lambda t: (14 * math.sin(math.pi * t), 0, 0),
            "upperArm.L": lambda t: (12 * math.sin(math.pi * t), 0, 0),
            "upperArm.R": lambda t: (12 * math.sin(math.pi * t), 0, 0),
        }
    if template == "march":
        swing = lambda t, off: 26 * math.sin(tau * (2 * t + off))
        return {
            "thigh.L": lambda t: (swing(t, 0), 0, 0),
            "thigh.R": lambda t: (swing(t, 0.5), 0, 0),
            "shin.L": lambda t: (max(0, -18 * math.sin(tau * (2 * t + 0.25))), 0, 0),
            "shin.R": lambda t: (max(0, -18 * math.sin(tau * (2 * t + 0.75))), 0, 0),
            "upperArm.L": lambda t: (swing(t, 0.5) * 0.6, 0, 0),
            "upperArm.R": lambda t: (swing(t, 0) * 0.6, 0, 0),
            "spine": lambda t: (3 * math.sin(tau * (2 * t)), 0, 0),
        }
    # 武侠单发包络（与前端 procedural.ts 同构）
    if template == "sword":
        env = lambda t: math.sin(math.pi * t)
        return {
            "spine": lambda t: (6 * env(t), 28 * env(t), 0),
            "upperArm.R": lambda t: (-115 * env(t), 0, -35 * env(t)),
            "forearm.R": lambda t: (-25 * env(t), 0, 0),
            "upperArm.L": lambda t: (0, 0, 12 * env(t)),
            "head": lambda t: (0, -12 * env(t), 0),
        }
    if template == "block":
        env = lambda t: math.sin(math.pi * t)
        return {
            "spine": lambda t: (10 * env(t), 0, 0),
            "upperArm.L": lambda t: (-30 * env(t), 0, -25 * env(t)),
            "upperArm.R": lambda t: (-30 * env(t), 0, 25 * env(t)),
            "forearm.L": lambda t: (-75 * env(t), 0, 0),
            "forearm.R": lambda t: (-75 * env(t), 0, 0),
            "head": lambda t: (6 * env(t), 0, 0),
        }
    if template == "kick":
        env = lambda t: math.sin(math.pi * t)
        return {
            "thigh.R": lambda t: (-70 * env(t), 0, 0),
            "shin.R": lambda t: (35 * env(t) * env(t), 0, 0),
            "thigh.L": lambda t: (0, 0, 0),
            "upperArm.L": lambda t: (-25 * env(t), 0, 0),
            "upperArm.R": lambda t: (25 * env(t), 0, 0),
            "spine": lambda t: (0, 12 * env(t), 0),
        }
    return {
        "spine": lambda t: (0, 0, 5 * math.sin(tau * (t + phase))),
        "upperArm.L": lambda t: (0, 0, 6 * math.sin(tau * (t + phase))),
        "upperArm.R": lambda t: (0, 0, -6 * math.sin(tau * (t + phase))),
        "head": lambda t: (0, 0, -4 * math.sin(tau * (t + phase))),
    }


def split_clauses(prompt: str) -> list[str]:
    """按标点切分动作子句（中英），去空保留顺序。"""
    parts = re.split(r"[，。！？、；\n,.!?;]+", prompt)
    return [p.strip() for p in parts if p.strip()]


def plan_prompt(prompt: str, duration: float) -> list[dict]:
    """启发式规划：每子句一模板，均分时长。返回 segments[{t0,t1,template,clause}]。"""
    clauses = split_clauses(prompt) or ["sway"]
    n = len(clauses)
    segs = []
    for i, clause in enumerate(clauses):
        t0 = duration * i / n
        t1 = duration * (i + 1) / n
        segs.append({"t0": round(t0, 3), "t1": round(t1, 3), "template": pick_template(clause), "clause": clause})
    return segs


def _sample_segment(sched: dict, t0: float, t1: float, seed: int, rest: dict[str, list] | None = None) -> dict[str, list]:
    """单段采样：局部 t∈[0,1] → 全局时间键。模板为偏移量，与各骨骼 rest 合成。"""
    rest = rest or {}
    span = max(t1 - t0, 1e-6)
    keys: dict[str, list] = {}
    n = max(2, int(span / STEP) + 1)
    for semantic, fn in sched.items():
        ks = []
        rq = rest.get(semantic)
        for i in range(n):
            time = min(t0 + i * STEP, t1)
            ks.append({"time": round(time, 3), "value": compose_rest_offset(rq, *fn((time - t0) / span)), "interp": "linear"})
        if ks[-1]["time"] < t1 - TIME_EPS:
            ks.append({"time": t1, "value": compose_rest_offset(rq, *fn(1.0)), "interp": "linear"})
        keys[semantic] = ks
    return keys


def _maybe_mirror_wave(sched: dict, bones: dict[str, str], warnings: list) -> dict:
    if "upperArm.R" not in bones and "upperArm.L" in bones and "upperArm.R" in sched:
        warnings.append("缺少右臂，wave 已镜像到左臂")
        sched = dict(sched)
        f_up = sched.get("upperArm.R")
        f_fo = sched.get("forearm.R")
        if f_up:
            sched["upperArm.L"] = lambda t, _f=f_up: (_e := _f(t)) and (_e[0], _e[1], -_e[2])
        if f_fo:
            sched["forearm.L"] = lambda t, _f=f_fo: (_e := _f(t)) and (_e[0], _e[1], -_e[2])
    return sched


def generate_tracks_planned(
    bones: dict[str, str], segments: list[dict], duration: float, seed: int = 0, rest: dict[str, list] | None = None
) -> tuple[list[str], list[dict], list[str]]:
    """多段合成：各段独立采样后按骨骼合并，边界重合时间去重（保留后者，保证衔接）。"""
    warnings: list[str] = []
    per_bone: dict[str, list] = {}
    templates: list[str] = []
    phase = (seed % 100) / 100
    for seg in segments:
        template = seg.get("template", "sway")
        if template not in KNOWN_TEMPLATES:
            warnings.append(f"未知模板 {template}，已按 sway 处理")
            template = "sway"
        templates.append(template)
        if template == "sway" and str(seg.get("clause", "")).strip():
            warnings.append(f"子句“{seg.get('clause')}”未识别关键词，已用站立摇摆占位")
        sched = _maybe_mirror_wave(_schedules(template, phase), bones, warnings)
        for semantic, ks in _sample_segment(sched, float(seg["t0"]), float(seg["t1"]), seed, rest).items():
            bone = bones.get(semantic)
            if not bone:
                warnings.append(f"缺少 {semantic}，已跳过")
                continue
            per_bone.setdefault(bone, []).extend(ks)

    tracks = []
    for bone, ks in per_bone.items():
        ks.sort(key=lambda k: k["time"])
        merged: list = []
        for k in ks:
            if merged and abs(k["time"] - merged[-1]["time"]) < TIME_EPS:
                merged[-1] = k  # 段边界：后段衔接优先
            else:
                merged.append(k)
        tracks.append({"boneName": bone, "position": [], "rotation": merged, "scale": []})
    return templates, tracks, warnings


def generate_tracks(bones: dict[str, str], prompt: str, duration: float, seed: int = 0):
    segs = plan_prompt(prompt, duration)
    return generate_tracks_planned(bones, segs, duration, seed)
