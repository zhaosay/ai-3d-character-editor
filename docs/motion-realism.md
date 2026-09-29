# 动作真实度：诊断与开源参考

## 一、诊断结论

对着开源动作库与运动原理逐条比对，原有 `schedules()` 的问题不是"模板数量少"，而是**生成的曲线不具备真人的运动特征**。逐项如下：

| 问题 | 原实现 | 真人规律 | 现状 |
|---|---|---|---|
| 步态周期 | `2*t` 硬编码，每段固定 2 步 | 周期应由步幅/腿长推导（0.4–0.7s/步） | ✅ `gaitPeriod()` |
| 膝关节 | `max(0, -18*sin)`：单向半波，只会朝一个方向弯 | 摆动期**先快速屈膝、再伸膝落地** | ✅ `gaitLeg()` 摆动段 |
| 髋部起伏 | 走路时完全没有 | 2× 步频；双支撑相最低 | ✅ 根位移叠加（末段淡出保证连续） |
| 骨盆旋转 | `spine` 仅 3° 前后倾，**无左右扭转** | 骨盆与胸廓反向旋转（走look核心辨识特征） | ✅ `hips`/`spine`/`chest` 组合 |
| 手臂 | 0.6× 正弦摆幅、肘完全伸直 | 摆臂时肘始终微屈(15–25°)，与同侧腿反相 | ✅ `armSwing`/`elbow` |
| 预备动作 | 所有模板直接起动 | Anticipation：先反向蓄力再发力 | ✅ `anticipationEnvelope()` |
| 跟随/回弹 | 无 | Follow-through：到位后轻微过冲回落 | ✅ 同上（overshoot） |
| 关节时序 | 肩肘腕同步 | 近端先动（肩→肘→腕延迟） | ✅ `proximalDelay()` |
| 呼吸耦合 | 仅 breath 模板，正弦单频 | 0.25Hz 胸廓起伏带动肩与头 | ✅ `breathSignal()` |
| 骨盆静止 | 站立/行走时绝对静止 | 骨盆从不停止（"假人感"主因） | ✅ 步态 bob |

## 二、参考的开源方案

本轮**没有引入外部依赖**，而是按以下开源项目总结的原理自行实现（`src/core/motion/gaits.ts`）：

- **[posers](https://github.com/thomasdavis/posers)** — VRM 人形程序化运动引擎。明确列出四条核心原则：
  1. Phase Envelopes（相位包络）而非状态机
  2. Maximum Bone Engagement（尽可能多的骨骼参与）
  3. **Anticipation + Follow-through**（预备与跟随）
  4. **Proximal-to-Distal Timing**（肩→肘→腕）、**Breath Coupling**（呼吸耦合）
- **[avatar-stage](https://github.com/rana-jatin/avatar-stage)** — Three.js 人形程序化动画库。强调 idle 行为（自动眨眼、呼吸、头部微摆）与 addable 叠加。
- **[CMU Graphics Lab Motion Capture Database](http://mocap.cs.cmu.edu)** — 免费商用动捕库，是步态相位、摆臂幅度的**权威参考数据**。本项目的 `gaitLeg()` 支撑/摆动期划分（60%支撑/40%摆动）即按此校准。
- **[three.js webgl_animation_walk](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_animation_walk.html)** — 参考其 `ACESFilmicToneMapping` + HDR 环境的写实预览思路（已用于本项目写实预览面板）。

## 三、本轮改动

新增 `src/core/motion/gaits.ts`（纯函数、可单测），并接入 `src/services/motion/procedural.ts`：
- `march` 模板重写为真实步态（含踝、膝、骨盆扭转、摆臂带肘、髋部起伏）
- 攻击类（`sword`/`block`/`kick`/`punch`）注入预备-跟随包络与近端延迟
- `breath` 模板改用真实时钟 0.25Hz 呼吸并带肩头耦合

测试：新增 `tests/gaits.test.ts`（27 项基元）与 `tests/gaits.integration.test.ts`（9 项端到端）。

## 四、已知仍不真实的边界（诚实说明）

1. **脚不打滑**：走路是"程序化步态"而非足部 IK 锁定，脚在地面会有轻微水平滑动。彻底解决需在 `PlaybackEngine` 接入地面投射 IK（参考 Spider 项目的 two-bone IK + 支撑腿锁定思路）。
2. **无次级动力学**：头发/衣物没有跟随惯性（look 中依赖美术端 cloth 或游戏引擎）。
3. **面部表情**仍依赖导入模型自带 blendshape，程序化角色只有眨眼实时层。
4. 写实游戏级人物的**皮肤/头发 PBR 贴图**必须靠导入外部资产，代码无法生成。
