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

## 三、动作真实度改动

新增 `src/core/motion/gaits.ts`（纯函数、可单测），并接入 `src/services/motion/procedural.ts`：
- `march` 模板重写为真实步态（含踝、膝、骨盆扭转、摆臂带肘、髋部起伏）
- 攻击类（`sword`/`block`/`kick`/`punch`）注入预备-跟随包络与近端延迟
- `breath` 模板改用真实时钟 0.25Hz 呼吸并带肩头耦合

测试：新增 `tests/gaits.test.ts`（27 项基元）与 `tests/gaits.integration.test.ts`（9 项端到端）。

## 四、足部锁定（Foot Lock）

程序化步态的固有缺陷是**脚打滑**：支撑腿的脚本应钉在地面，但骨骼只是按曲线旋转，脚会随身体平移。

实现见 `src/core/ik/footLock.ts`（纯状态机）+ `src/services/motion/footLockRuntime.ts`（运行时）：

- **状态机**：触地 → 记录世界落点（plant）；持续触地 → 保持落点；离地 → 释放
- **每帧**用现成的两骨 IK（`applyIKChain`）把支撑脚拉回落点
- **实测脚底偏移**：脚骨原点≠脚底，且刚性蒙皮下网格是骨骼的兄弟节点而非子节点，
  故用 `skeleton.bones.indexOf(foot)` 定位绑定网格后扫描顶点实测，**不能硬编码常数**
- **安全降级**：漂移超过 `maxCorrection`（IK 追不上）时放弃本落点重记，避免腿被拉变形；
  时间回退（拖时间轴）自动重置状态；速度异常（时间跳变）重置落点
- **Scrub 从 0 重放**：落点状态是时间累积量，直接在目标时间求解会与播放不一致，
  故暂停拖动时从动画起点逐步重放

实测效果（程序化男角色走 3 秒，见 `tests/footLock.integration.test.ts`）：
**支撑脚水平漂移从 ~70cm 降到 ~1.7cm（约 40 倍）**。

UI：右侧「写实预览」面板底部，默认**关闭** —— 手工摆过脚部关键帧的动画会被它覆盖。

## 五、台阶/斜坡地面投射

足部锁定原本只有水平方向，落在平台上会浮空或入地。新增 `src/core/world/ground.ts`：

- **解析高度场**（不做 raycast）：基准平面 + 若干可站立盒（台阶/平台/床/桌椅）
- 采样 `(x, z, originY)` → `{height, normal, source}`，用**探测窗口**限制搜索范围
  （`[originY − probeDown, originY + probeUp]`），避免把远处高台"吸"上来
- 重叠盒取最高顶面；支持 yaw 旋转的水平投影判定
- `groundFieldFromProps()` 可直接从场景道具构造（只有床/椅/沙发/桌/房间可站立，剑等不构成地面）
- UI：写实预览面板里可增删台阶、调高度与 Z 位置

## 六、动作体检：用项目自己的物理分析器找问题

项目已有完整的物理分析器（`core/physics/analyze.ts`：穿地 / 脚滑 / 加速度尖峰 / 平衡 / 关节极限）。
用它在**真实骨骼**上跑了全部动作模板，基线结果：

| 动作 | 问题 |
|---|---|
| 下蹲 squat | **两脚穿透 7.5cm** |
| 躺下 lie | 两脚穿透 42.5cm + 脚滑 |
| 踢腿 kick | 支撑腿脚滑（足部锁定未开时的基线） |
| 其余 11 个模板 | 无问题 |

### 修掉的下蹲穿地（真实 bug）

**根因**：足部锁定的触发条件只看**水平**距离（`correction`）。
但下蹲时髋部垂直下沉，脚是**垂直入地**的 —— 水平偏差恰好为 0，锁定从不触发。

**修法**：引入 `deviation`（三维偏差 = hypot(水平, 垂直)），用它判定触发。
下蹲脚底从 **−8.8cm 改善到 −1.9cm（4.6 倍）**。

这也是为什么不能只看"水平打滑"——**垂直方向同样是支撑约束**。

## 七、已知仍不真实的边界（诚实说明）

1. **次级动力学**：头发/衣物没有跟随惯性（look 中依赖美术端 cloth 或游戏引擎）。
2. **躺下仍会穿地 42cm**：躺姿下人体本就应低于地面参照（背贴地），但当前脚部几何没被
   正确带到床上高度。彻底解决需为躺/坐专门设计 IK 目标（床面/椅面），不是通用 foot lock。
3. **面部表情**仍依赖导入模型自带 blendshape，程序化角色只有眨眼实时层。
4. 写实游戏级人物的**皮肤/头发 PBR 贴图**必须靠导入外部资产，代码无法生成。
5. 台阶只支持**轴对齐盒体**，斜坡需自行近似为阶梯。


