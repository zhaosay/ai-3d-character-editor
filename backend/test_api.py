"""后端冒烟测试（标准库断言，直接 python 运行，无需 pytest）。

运行：backend/.venv/bin/python backend/test_api.py
"""

import base64
import binascii
import os
import struct
import zlib
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from main import app
from media_integrations import build_previs_image_workflow, decode_previs_reference

client = TestClient(app)
BONES = {"upperArm.R": "ArmR", "forearm.R": "ForeR", "head": "Head"}


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)


def png_image(width: int, height: int) -> bytes:
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    row = b"\x00" + bytes(width * 4)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", zlib.compress(row * height)) + png_chunk(b"IEND", b"")


def test_health():
    r = client.get("/health")
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


def test_previs_comfy_graph_uses_a_fixed_safe_node_set():
    workflow = build_previs_image_workflow("adult East Asian woman, standing", "text, watermark", 768, 1024, 42)
    assert {node["class_type"] for node in workflow.values()} == {
        "CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage",
    }
    assert workflow["2"]["inputs"]["text"] == "adult East Asian woman, standing"
    assert workflow["3"]["inputs"]["text"] == "text, watermark"
    assert workflow["4"]["inputs"] == {"width": 768, "height": 1024, "batch_size": 1}
    assert workflow["5"]["inputs"]["seed"] == 42


def test_previs_reference_uses_low_denoise_img2img_graph():
    name = "AI3D_previs_reference_0123456789abcdef0123456789abcdef.png"
    workflow = build_previs_image_workflow("person on a bed", "text", 1024, 576, 42, name)
    assert workflow["8"] == {"class_type": "LoadImage", "inputs": {"image": name}}
    assert workflow["9"] == {"class_type": "VAEEncode", "inputs": {"pixels": ["8", 0], "vae": ["1", 2]}}
    assert workflow["5"]["inputs"]["latent_image"] == ["9", 0]
    assert workflow["5"]["inputs"]["denoise"] == 0.38


def test_previs_reference_rejects_non_png_and_oversized_dimensions():
    try:
        decode_previs_reference(base64.b64encode(b"not an image").decode())
    except HTTPException as exc:
        assert "必须是有效" in exc.detail
    else:
        raise AssertionError("non-PNG reference was accepted")
    png_header = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 4096, 4096, 8, 6, 0, 0, 0))
    try:
        decode_previs_reference(base64.b64encode(png_header).decode())
    except HTTPException as exc:
        assert "尺寸超出" in exc.detail
    else:
        raise AssertionError("oversized reference was accepted")
    corrupt = bytearray(png_image(64, 64))
    corrupt[-10] ^= 1
    try:
        decode_previs_reference(base64.b64encode(corrupt).decode())
    except HTTPException as exc:
        assert "PNG 数据损坏" in exc.detail
    else:
        raise AssertionError("PNG with an invalid chunk CRC was accepted")


def test_comfy_job_uploads_and_uses_reference_image():
    name = "AI3D_previs_reference_0123456789abcdef0123456789abcdef.png"
    png_header = png_image(640, 360)
    with patch("main.comfy_readiness", new=AsyncMock(return_value={"available": True})), \
         patch("media_integrations.upload_comfy_reference", new=AsyncMock(return_value=name)), \
         patch("media_integrations._json_request", new=AsyncMock(return_value={"prompt_id": "job-reference"})) as submit:
        response = client.post("/integrations/comfy/jobs", json={
            "prompt": "person lying supine on bed",
            "width": 1024,
            "height": 576,
            "reference_image_base64": base64.b64encode(png_header).decode(),
        })

    assert response.status_code == 200, response.text
    workflow = submit.await_args.kwargs["json"]["prompt"]
    assert workflow["8"]["inputs"]["image"] == name
    assert workflow["5"]["inputs"]["denoise"] == 0.38


def test_comfy_status_reports_connected_but_unavailable_when_scheduler_state_is_unknown():
    with patch("main.comfy_readiness", new=AsyncMock(side_effect=RuntimeError("scheduler offline"))), \
         patch("media_integrations._json_request", new=AsyncMock(return_value={})):
        response = client.get("/integrations/comfy/status")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "connected": True,
        "available": False,
        "reason": "无法确认 GPU 排程或 ComfyUI 队列状态；为避免任务争抢，暂不提交新生成任务",
    }


def test_comfy_status_reports_disconnected_when_system_stats_is_unreachable():
    with patch("main.comfy_readiness", new=AsyncMock(side_effect=RuntimeError("scheduler offline"))), \
         patch("media_integrations._json_request", new=AsyncMock(side_effect=RuntimeError("ComfyUI offline"))):
        response = client.get("/integrations/comfy/status")

    assert response.status_code == 200, response.text
    assert response.json() == {"connected": False, "available": False, "reason": "ComfyUI 未连接"}


def test_vpipe_submission_respects_shared_gpu_readiness():
    with patch("main.comfy_readiness", new=AsyncMock(return_value={
        "available": False, "comfyQueued": False, "reason": "GPU 繁忙，等待当前生成任务结束",
    })), patch("main.vpipe_request", new=AsyncMock()) as submit:
        response = client.post("/integrations/vpipe/jobs", json={"prompt": "wide shot of a person walking"})

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "GPU 繁忙，等待当前生成任务结束"
    submit.assert_not_awaited()


def test_generate_wave():
    r = client.post(
        "/motion/generate",
        json={"prompt": "挥手", "duration": 2, "fps": 30, "bones": BONES},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["source"] == "mock"
    assert body["meta"]["motion_space"] == {"length_unit": "m", "up_axis": "Y", "handedness": "right"}
    assert body["meta"]["template"] == "wave"
    names = {t["boneName"] for t in body["animation"]["tracks"]}
    assert {"ArmR", "ForeR", "Head"} <= names
    assert body["animation"]["duration"] == 2


def test_left_hand_wave_and_reach_drive_left_arm():
    bones = {
        "upperArm.L": "ArmL", "forearm.L": "ForeL", "hand.L": "HandL",
        "upperArm.R": "ArmR", "forearm.R": "ForeR", "hand.R": "HandR",
    }
    for template, clause, active in (
        ("wave", "左手挥手", {"ArmL", "ForeL"}),
        ("reach", "左手伸手拿起手机", {"ArmL", "ForeL", "HandL"}),
    ):
        result = client.post("/motion/generate", json={
            "prompt": clause, "duration": 2, "fps": 30, "bones": bones,
            "plan": [{"t0": 0, "t1": 2, "template": template, "clause": clause}],
        })
        assert result.status_code == 200, result.text
        tracks = {track["boneName"]: track["rotation"] for track in result.json()["animation"]["tracks"]}
        assert active <= tracks.keys()
        assert not ({"ArmR", "ForeR", "HandR"} & tracks.keys())
        assert any(sum(component * component for component in key["value"][:3]) > 0.01
                   for bone in active for key in tracks[bone])


def test_generate_unknown_prompt_falls_back():
    r = client.post("/motion/generate", json={"prompt": "qwerty", "duration": 1, "fps": 30, "bones": BONES})
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["template"] == "sway"


def test_generate_scene_aware_look_template():
    r = client.post(
        "/motion/generate",
        json={"prompt": "回头看门口", "scene_context": "door@0,0,-2 size=0.9x2.0x0.1m", "duration": 2, "fps": 30, "bones": BONES},
    )
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["template"] == "look"


def test_plan_directional_and_squat_templates():
    r = client.post("/motion/plan", json={"prompt": "左手抬高，然后头向左转，再下蹲", "duration": 6})
    assert r.status_code == 200, r.text
    assert [segment["template"] for segment in r.json()["segments"]] == ["raise_left", "look_left", "squat"]

    bones = {"upperArm.L": "ArmL", "upperArm.R": "ArmR", "head": "Head", "thigh.L": "LegL"}
    generated = client.post("/motion/generate", json={
        "prompt": "左手抬高", "duration": 2, "fps": 30, "bones": bones,
    })
    assert generated.status_code == 200, generated.text
    assert generated.json()["meta"]["template"] == "raise_left"
    assert {track["boneName"] for track in generated.json()["animation"]["tracks"]} == {"ArmL"}


def test_weapon_handoff_template_generates_both_arm_tracks():
    prompt = "挥剑后把剑换到左手再格挡"
    planned = client.post("/motion/plan", json={"prompt": prompt, "duration": 6})
    assert planned.status_code == 200, planned.text
    assert [segment["template"] for segment in planned.json()["segments"]] == ["sword", "handoff", "block"]

    bones = {"spine": "Spine", "upperArm.L": "ArmL", "forearm.L": "ForeL", "upperArm.R": "ArmR", "forearm.R": "ForeR"}
    generated = client.post("/motion/generate", json={"prompt": prompt, "duration": 6, "fps": 30, "bones": bones, "plan": planned.json()["segments"]})
    assert generated.status_code == 200, generated.text
    assert generated.json()["meta"]["templates"] == ["sword", "handoff", "block"]
    assert {track["boneName"] for track in generated.json()["animation"]["tracks"]} == {"ArmL", "ForeL", "ArmR", "ForeR", "Spine"}


def test_empty_bones_422():
    r = client.post("/motion/generate", json={"prompt": "wave", "duration": 1, "fps": 30, "bones": {}})
    assert r.status_code == 422, r.text


def test_bad_fps_422():
    r = client.post("/motion/generate", json={"prompt": "wave", "duration": 1, "fps": 77, "bones": BONES})
    assert r.status_code == 422, r.text


def test_plan_multi_clause():
    r = client.post("/motion/plan", json={"prompt": "先挥手，再鞠躬", "duration": 4})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["planner"] == "heuristic"  # 无 key 时明确启发式
    assert [s["template"] for s in body["segments"]] == ["wave", "bow"]
    assert body["segments"][0]["t0"] == 0
    assert body["segments"][-1]["t1"] == 4


def test_generate_multi_segment_merges():
    r = client.post(
        "/motion/generate",
        json={"prompt": "挥手，然后踏步", "duration": 4, "fps": 30, "bones": BONES},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["templates"] == ["wave", "march"]
    # 同骨骼多段时间键合并有序、无重合
    for t in body["animation"]["tracks"]:
        times = [k["time"] for k in t["rotation"]]
        assert times == sorted(times), t["boneName"]
        for a, b in zip(times, times[1:]):
            assert b - a > 1e-5, (t["boneName"], a, b)


def test_generate_wuxia_templates():
    bones = {
        "spine": "Spine", "head": "Head",
        "upperArm.R": "ArmR", "forearm.R": "ForeR",
        "upperArm.L": "ArmL", "forearm.L": "ForeL",
        "thigh.R": "LegR", "thigh.L": "LegL", "shin.R": "ShinR",
    }
    for prompt, template, expect_bone in (
        ("拔剑", "sword", "ArmR"),
        ("格挡", "block", "ForeL"),
        ("踢腿", "kick", "LegR"),
        ("出拳", "punch", "ArmR"),
        ("呼吸", "breath", "Spine"),
    ):
        r = client.post(
            "/motion/generate",
            json={"prompt": prompt, "duration": 2, "fps": 30, "bones": bones},
        )
        assert r.status_code == 200, (prompt, r.text)
        body = r.json()
        assert body["meta"]["template"] == template, (prompt, body["meta"])
        assert body["meta"]["source"] == "mock"
        names = {t["boneName"] for t in body["animation"]["tracks"]}
        assert expect_bone in names, (prompt, names)
        for t in body["animation"]["tracks"]:
            for k in t["rotation"]:
                n = sum(x * x for x in k["value"]) ** 0.5
                assert abs(n - 1.0) < 1e-5, (prompt, t["boneName"], k)

    left_bones = {"upperArm.L": "ArmL", "forearm.L": "ForeL", "upperArm.R": "ArmR", "forearm.R": "ForeR"}
    result = client.post("/motion/generate", json={
        "prompt": "左手出拳", "duration": 2, "fps": 30, "bones": left_bones,
        "plan": [{"t0": 0, "t1": 2, "template": "punch", "clause": "左手出拳"}],
    })
    assert result.status_code == 200, result.text
    tracks = {track["boneName"]: track["rotation"] for track in result.json()["animation"]["tracks"]}
    assert "ArmL" in tracks and "ForeL" in tracks
    lead = tracks["ArmL"][len(tracks["ArmL"]) // 2]["value"]
    guard = tracks["ArmR"][len(tracks["ArmR"]) // 2]["value"]
    assert sum(value * value for value in lead[:3]) > sum(value * value for value in guard[:3])

    leg_bones = {"thigh.L": "LegL", "shin.L": "ShinL", "thigh.R": "LegR", "shin.R": "ShinR"}
    result = client.post("/motion/generate", json={
        "prompt": "左腿踢击", "duration": 2, "fps": 30, "bones": leg_bones,
        "plan": [{"t0": 0, "t1": 2, "template": "kick", "clause": "左腿踢击"}],
    })
    assert result.status_code == 200, result.text
    tracks = {track["boneName"]: track["rotation"] for track in result.json()["animation"]["tracks"]}
    assert "LegL" in tracks and "ShinL" in tracks
    lead = tracks["LegL"][len(tracks["LegL"]) // 2]["value"]
    guard = tracks["LegR"][len(tracks["LegR"]) // 2]["value"]
    assert sum(value * value for value in lead[:3]) > sum(value * value for value in guard[:3])


def test_plan_wuxia_combo():
    r = client.post("/motion/plan", json={"prompt": "拔剑，然后格挡，最后踢腿", "duration": 6})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [s["template"] for s in body["segments"]] == ["sword", "block", "kick"]


def test_plan_ground_sleep_uses_supported_ordered_phases():
    r = client.post("/motion/plan", json={"prompt": "躺下睡觉", "duration": 8})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [s["template"] for s in body["segments"]] == ["kneel", "lie", "sleep"]
    assert body["segments"][0]["t0"] == 0
    assert body["segments"][-1]["t1"] == 8


def test_quat_mul_known_value():
    from motion_mock import compose_rest_offset, quat_mul

    s = 2**0.5 / 2
    # qx90 ⊗ qy90 = (0.5, 0.5, 0.5, 0.5)
    q = quat_mul([s, 0, 0, s], [0, s, 0, s])
    assert all(abs(a - 0.5) < 1e-9 for a in q), q
    # 无 rest 退化为绝对欧拉
    assert compose_rest_offset(None, 90, 0, 0)[0] > 0.7


def test_generate_with_rest_offsets():
    rest = {"upperArm.R": [0, 0, -0.642788, 0.766044]}  # T-pose 近似：绕 Z -80°
    r = client.post(
        "/motion/generate",
        json={"prompt": "挥手", "duration": 2, "fps": 30, "bones": BONES, "rest": rest},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    track = next(t for t in body["animation"]["tracks"] if t["boneName"] == "ArmR")
    first = track["rotation"][0]["value"]
    # 首键 ≈ rest ⊗ (-55° Z 偏移)，而非旧绝对 -150°
    from motion_mock import compose_rest_offset as comp

    expected = comp(rest["upperArm.R"], 0, 0, -55)
    assert all(abs(a - b) < 1e-6 for a, b in zip(first, expected)), (first, expected)


def test_llm_unreachable_falls_back_with_warning():
    os.environ["LLM_BASE_URL"] = "http://127.0.0.1:9"
    os.environ["LLM_API_KEY"] = "fake"
    os.environ["LLM_MODEL"] = "fake-model"
    try:
        r = client.post("/motion/plan", json={"prompt": "挥手", "duration": 2})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["planner"] == "heuristic"
        assert any("LLM" in w for w in body["warnings"]), body["warnings"]
    finally:
        for k in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"):
            os.environ.pop(k, None)


if __name__ == "__main__":
    test_health()
    test_previs_comfy_graph_uses_a_fixed_safe_node_set()
    test_previs_reference_uses_low_denoise_img2img_graph()
    test_previs_reference_rejects_non_png_and_oversized_dimensions()
    test_comfy_job_uploads_and_uses_reference_image()
    test_generate_wave()
    test_generate_unknown_prompt_falls_back()
    test_generate_scene_aware_look_template()
    test_plan_directional_and_squat_templates()
    test_weapon_handoff_template_generates_both_arm_tracks()
    test_empty_bones_422()
    test_bad_fps_422()
    test_plan_multi_clause()
    test_generate_multi_segment_merges()
    test_generate_wuxia_templates()
    test_plan_wuxia_combo()
    test_plan_ground_sleep_uses_supported_ordered_phases()
    test_quat_mul_known_value()
    test_generate_with_rest_offsets()
    test_llm_unreachable_falls_back_with_warning()
    print("backend tests: 20 passed")
