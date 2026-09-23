"""后端冒烟测试（标准库断言，直接 python 运行，无需 pytest）。

运行：backend/.venv/bin/python backend/test_api.py
"""

import os

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)
BONES = {"upperArm.R": "ArmR", "forearm.R": "ForeR", "head": "Head"}


def test_health():
    r = client.get("/health")
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


def test_generate_wave():
    r = client.post(
        "/motion/generate",
        json={"prompt": "挥手", "duration": 2, "fps": 30, "bones": BONES},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["source"] == "mock"
    assert body["meta"]["template"] == "wave"
    names = {t["boneName"] for t in body["animation"]["tracks"]}
    assert {"ArmR", "ForeR", "Head"} <= names
    assert body["animation"]["duration"] == 2


def test_generate_unknown_prompt_falls_back():
    r = client.post("/motion/generate", json={"prompt": "qwerty", "duration": 1, "fps": 30, "bones": BONES})
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["template"] == "sway"


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


def test_plan_wuxia_combo():
    r = client.post("/motion/plan", json={"prompt": "拔剑，然后格挡，最后踢腿", "duration": 6})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [s["template"] for s in body["segments"]] == ["sword", "block", "kick"]


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
    test_generate_wave()
    test_generate_unknown_prompt_falls_back()
    test_empty_bones_422()
    test_bad_fps_422()
    test_plan_multi_clause()
    test_generate_multi_segment_merges()
    test_generate_wuxia_templates()
    test_plan_wuxia_combo()
    test_quat_mul_known_value()
    test_generate_with_rest_offsets()
    test_llm_unreachable_falls_back_with_warning()
    print("backend tests: 12 passed")
