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


KNOWN_TEMPLATES = ("wave", "bow", "march", "reach", "look", "look_left", "look_right", "raise_left", "raise_right", "turn", "orient", "sit", "squat", "kneel", "lie", "sleep", "stand", "sword", "handoff", "block", "kick", "punch", "breath", "sway")


def pick_template(prompt: str) -> str:
    p = prompt.lower()
    if any(k in prompt for k in ("换手", "换到左手", "换到右手", "交给左手", "交给右手", "递给左手", "递给右手", "左手接过", "右手接过")):
        return "handoff"
    if "raise left hand" in p or any(k in prompt for k in ("左手抬高", "左手举高", "左手抬起", "左手举起")):
        return "raise_left"
    if "raise right hand" in p or any(k in prompt for k in ("右手抬高", "右手举高", "右手抬起", "右手举起")):
        return "raise_right"
    if "turn head left" in p or any(k in prompt for k in ("头向左", "头往左", "头左转", "脑袋向左", "脑袋往左")):
        return "look_left"
    if "turn head right" in p or any(k in prompt for k in ("头向右", "头往右", "头右转", "脑袋向右", "脑袋往右")):
        return "look_right"
    if any(k in prompt for k in ("下蹲", "蹲下", "蹲起")) or any(k in p for k in ("squat", "crouch")):
        return "squat"
    if any(k in prompt for k in ("跪下", "下跪", "跪地", "跪倒")):
        return "kneel"
    if any(k in p for k in ("sleep",)) or any(k in prompt for k in ("睡觉", "入睡", "睡着")):
        return "sleep"
    if any(k in p for k in ("lie down", "lying")) or any(k in prompt for k in ("躺倒", "躺下", "躺平", "仰卧", "卧倒")):
        return "lie"
    if any(k in p for k in ("reach", "grab", "pick up")) or any(k in prompt for k in ("拿起", "抓取", "伸手", "递给", "接住")):
        return "reach"
    if any(k in p for k in ("look", "gaze")) or any(k in prompt for k in ("回头", "看向", "望向", "注视", "回眸")):
        return "look"
    if any(k in p for k in ("turn",)) or any(k in prompt for k in ("转身", "转向", "转过来")):
        return "turn"
    if any(k in prompt for k in ("坐下", "坐到", "坐在")):
        return "sit"
    if any(k in prompt for k in ("站起", "起身", "站直")):
        return "stand"
    # 武侠优先：避免“挥剑”被 wave 的“挥”截胡（“挥手”不含“剑”，不受影响）
    if any(k in p for k in ("sword", "slash", "draw", "stab")) or any(k in prompt for k in ("拔剑", "挥剑", "刺剑", "劈剑", "舞剑", "剑")):
        return "sword"
    if any(k in p for k in ("block", "parry", "guard", "defend")) or any(k in prompt for k in ("格挡", "防御", "抵挡", "招架")):
        return "block"
    if any(k in p for k in ("kick",)) or any(k in prompt for k in ("踢", "扫腿", "鞭腿")):
        return "kick"
    if any(k in p for k in ("punch", "jab", "hook")) or any(k in prompt for k in ("出拳", "挥拳", "直拳", "勾拳")):
        return "punch"
    if any(k in p for k in ("idle", "breath")) or any(k in prompt for k in ("呼吸", "待机")):
        return "breath"
    if any(k in p for k in ("wave", "hello")) or any(k in prompt for k in ("挥", "抬手", "招手")):
        return "wave"
    if any(k in p for k in ("bow", "nod")) or any(k in prompt for k in ("鞠", "躬", "点头")):
        return "bow"
    if any(k in p for k in ("march", "walk", "run")) or any(k in prompt for k in ("踏步", "走", "跑")):
        return "march"
    return "sway"


def _schedules(template: str, phase: float, clause: str = ""):
    tau = math.pi * 2
    if template in ("raise_left", "raise_right"):
        side = "L" if template == "raise_left" else "R"
        env = lambda t: max(0.0, min(1.0, t)) ** 2 * (3 - 2 * max(0.0, min(1.0, t)))
        return {f"upperArm.{side}": lambda t: (-115 * env(t), 0, (22 if side == "L" else -22) * env(t)),
                f"forearm.{side}": lambda t: (-12 * env(t), 0, 0),
                "spine": lambda t: (-3 * env(t), 0, 0)}
    if template in ("look_left", "look_right"):
        yaw = -1 if template == "look_left" else 1
        env = lambda t: max(0.0, min(1.0, t)) ** 2 * (3 - 2 * max(0.0, min(1.0, t)))
        return {"head": lambda t: (0, 38 * yaw * env(t), 0),
                "neck": lambda t: (0, 16 * yaw * env(t), 0),
                "chest": lambda t: (0, 8 * yaw * env(t), 0)}
    if template == "wave":
        side = "L" if re.search(r"左手|左臂", clause) else "R"
        sign = -1 if side == "L" else 1
        return {
            f"upperArm.{side}": lambda t: (0, 0, sign * (-55 + 20 * math.sin(tau * (t + phase)))),
            f"forearm.{side}": lambda t: (0, 0, sign * (-20 + 22 * math.sin(tau * (2 * t + phase)))),
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
    if template == "reach":
        env = lambda t: math.sin(math.pi * t)
        side = "L" if re.search(r"左手|左臂", clause) else "R"
        sign = 1 if side == "L" else -1
        return {"spine": lambda t: (5 * env(t), 0, 0), f"upperArm.{side}": lambda t: (-45 * env(t), 0, sign * 20 * env(t)), f"forearm.{side}": lambda t: (-55 * env(t), 0, 0), f"hand.{side}": lambda t: (-10 * env(t), 0, 0)}
    if template in ("look", "turn", "orient"):
        env = lambda t: math.sin(math.pi * 0.5 * t)
        return {"hips": lambda t: (0, (25 if template == "turn" else 0) * env(t), 0), "chest": lambda t: (0, 10 * env(t), 0), "head": lambda t: (0, 30 * env(t), 0)}
    if template == "sit":
        env = lambda t: t * t * (3 - 2 * t)
        return {"hips": lambda t: (38 * env(t), 0, 0), "thigh.L": lambda t: (-72 * env(t), 0, 0), "thigh.R": lambda t: (-72 * env(t), 0, 0), "shin.L": lambda t: (68 * env(t), 0, 0), "shin.R": lambda t: (68 * env(t), 0, 0)}
    if template == "squat":
        env = lambda t: t * t * (3 - 2 * t)
        return {"hips": lambda t: (28 * env(t), 0, 0), "spine": lambda t: (15 * env(t), 0, 0),
                "thigh.L": lambda t: (-78 * env(t), 0, 0), "thigh.R": lambda t: (-78 * env(t), 0, 0),
                "shin.L": lambda t: (92 * env(t), 0, 0), "shin.R": lambda t: (92 * env(t), 0, 0),
                "upperArm.L": lambda t: (-18 * env(t), 0, 15 * env(t)), "upperArm.R": lambda t: (-18 * env(t), 0, -15 * env(t))}
    if template == "kneel":
        env = lambda t: t * t * (3 - 2 * t)
        return {"hips": lambda t: (28 * env(t), 0, 0), "spine": lambda t: (24 * env(t), 0, 0),
                "head": lambda t: (-10 * env(t), 0, 0),
                "thigh.L": lambda t: (-92 * env(t), 0, 0), "thigh.R": lambda t: (-92 * env(t), 0, 0),
                "shin.L": lambda t: (108 * env(t), 0, 0), "shin.R": lambda t: (108 * env(t), 0, 0),
                "upperArm.L": lambda t: (-38 * env(t), 0, 24 * env(t)), "upperArm.R": lambda t: (-38 * env(t), 0, -24 * env(t)),
                "forearm.L": lambda t: (-78 * env(t), 0, 0), "forearm.R": lambda t: (-78 * env(t), 0, 0)}
    if template in ("lie", "sleep"):
        return {"hips": lambda t: (-82 * t, 0, 0), "spine": lambda t: (-5 * t, 0, 0), "head": lambda t: (-8 * t, 0, 0), "thigh.L": lambda t: (12 * t, 0, 0), "thigh.R": lambda t: (12 * t, 0, 0)}
    if template == "stand":
        return {"hips": lambda t: (0, 0, 0), "spine": lambda t: (0, 0, 0), "head": lambda t: (0, 0, 0)}
    if template == "handoff":
        env = lambda t: math.sin(math.pi * max(0.0, min(1.0, t)))
        return {
            "spine": lambda t: (0, 8 * env(t), 0),
            "upperArm.L": lambda t: (-28 * env(t), 0, 32 * env(t)),
            "forearm.L": lambda t: (-52 * env(t), 0, 0),
            "upperArm.R": lambda t: (-28 * env(t), 0, -32 * env(t)),
            "forearm.R": lambda t: (-52 * env(t), 0, 0),
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
    if template == "punch":
        env = lambda t: math.sin(math.pi * t)
        lead = "L" if "左手" in clause else "R"
        guard = "R" if lead == "L" else "L"
        lead_sign = -1 if lead == "R" else 1
        guard_sign = -1 if guard == "R" else 1
        return {
            "spine": lambda t: (0, 8 * env(t), 0),
            f"upperArm.{lead}": lambda t: (-78 * env(t), 0, 8 * lead_sign * env(t)),
            f"forearm.{lead}": lambda t: (-42 * env(t), 0, 0),
            f"upperArm.{guard}": lambda t: (-12 * env(t), 0, -8 * guard_sign * env(t)),
        }
    if template == "kick":
        env = lambda t: math.sin(math.pi * t)
        lead = "L" if ("左腿" in clause or "左脚" in clause) else "R"
        guard = "R" if lead == "L" else "L"
        left_arm_sign = -1 if lead == "R" else 1
        return {
            f"thigh.{lead}": lambda t: (-70 * env(t), 0, 0),
            f"shin.{lead}": lambda t: (35 * env(t) * env(t), 0, 0),
            f"thigh.{guard}": lambda t: (0, 0, 0),
            "upperArm.L": lambda t: (25 * left_arm_sign * env(t), 0, 0),
            "upperArm.R": lambda t: (-25 * left_arm_sign * env(t), 0, 0),
            "spine": lambda t: (0, 12 * env(t), 0),
        }
    if template == "breath":
        # 待机呼吸：每段一次缓慢起伏（4s 段 ≈ 15 次/分）
        b = lambda t: math.sin(tau * t)
        return {
            "spine": lambda t: (1.2 * b(t), 0, 0),
            "chest": lambda t: (2.0 * b(t), 0, 0),
            "upperArm.L": lambda t: (0.8 * b(t), 0, 0),
            "upperArm.R": lambda t: (0.8 * b(t), 0, 0),
        }
    return {
        "spine": lambda t: (0, 0, 5 * math.sin(tau * (t + phase))),
        "upperArm.L": lambda t: (0, 0, 6 * math.sin(tau * (t + phase))),
        "upperArm.R": lambda t: (0, 0, -6 * math.sin(tau * (t + phase))),
        "head": lambda t: (0, 0, -4 * math.sin(tau * (t + phase))),
    }


def split_clauses(prompt: str) -> list[str]:
    """按标点和动作连接词切分，保留方位词“门后/桌后”的原句。"""
    normalized = re.sub(r"(?:然后|接着|随后|之后|最后|再|并且|并)\s*", "，", prompt)
    normalized = re.sub(r"(?<![门墙床桌椅树])后(?=(?:把|回头|回眸|鞠躬|点头|看|望|注视|拿|拾|抓|走|跑|坐|躺|卧|睡|起身|站|挥|举|抬|踢|出拳|格挡|招架|转身|开门|推门|拉门|放下|放回|递给|接过|休息))", "，", normalized)
    parts = re.split(r"[，。！？、；\n,.!?;]+", normalized)
    return [p.strip() for p in parts if p.strip()]


def plan_prompt(prompt: str, duration: float) -> list[dict]:
    """启发式规划：每子句一模板，均分时长。返回 segments[{t0,t1,template,clause}]。"""
    if re.search(r"躺|卧", prompt) and re.search(r"睡|休息", prompt) and not re.search(r"床", prompt):
        phases = [
            ("kneel", "屈膝缓慢跪下，并伸手扶地降低重心", 0.3),
            ("lie", "以手臂支撑身体并转为仰卧，平稳落到地面", 0.4),
            ("sleep", "仰卧放松并安静呼吸", 0.3),
        ]
        total = sum(weight for _, _, weight in phases)
        t = 0.0
        result = []
        for index, (template, clause, weight) in enumerate(phases):
            t1 = duration if index == len(phases) - 1 else t + duration * weight / total
            result.append({"t0": round(t, 3), "t1": round(t1, 3), "template": template, "clause": clause})
            t = t1
        return result
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
    requested = "L" if "upperArm.L" in sched else "R"
    fallback = "R" if requested == "L" else "L"
    if f"upperArm.{requested}" not in bones and f"upperArm.{fallback}" in bones:
        warnings.append(f"缺少{'左' if requested == 'L' else '右'}臂，wave 已镜像到{'右' if fallback == 'R' else '左'}臂")
        sched = dict(sched)
        for part in ("upperArm", "forearm"):
            fn = sched.get(f"{part}.{requested}")
            if fn:
                sched[f"{part}.{fallback}"] = lambda t, _fn=fn: (_e := _fn(t)) and (_e[0], _e[1], -_e[2])
                sched.pop(f"{part}.{requested}", None)
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
        sched = _schedules(template, phase, seg.get("clause", ""))
        if template == "wave":
            sched = _maybe_mirror_wave(sched, bones, warnings)
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
