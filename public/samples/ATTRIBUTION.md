# 第三方示例模型署名（ATTRIBUTION）

## CesiumMan.glb（仓库内置，可离线一键加载）

- 来源：KhronosGroup `glTF-Sample-Assets` → `Models/CesiumMan`
- 许可：**CC-BY-4.0**（Cesium, 2017），另含 Cesium 商标声明（logo 部分不用作商标）
- 原文：`Models/CesiumMan/LICENSE.md`（上游仓库）
- 用途：编辑器内置演示角色；界面与文档保留 "Cesium Man by Cesium (CC-BY-4.0)" 署名
- 自带 1 段 57 通道动画（仅展示计数，编辑器时间轴使用自有关键帧，不直接导入）

## Soldier（在线一键加载，不进仓库）

- 来源：three.js 示例模型（Mixamo 骨架， royalty-free），经 jsDelivr CDN 运行时下载
- 用途：真人男演示；用户浏览器按需获取，本仓库不做分发
- 自带 Idle / Walk / Run / TPose 四段（同上，仅展示计数）

## Ready Player Me（用户粘贴链接，不进仓库）

- 用户在 demo.readyplayer.me 免费创建真人（男/女自选）后粘贴 `.glb` 链接加载
- 许可是用户与 RPM 之间的事；本项目不托管、不分发任何 RPM 资产

## 真人动作库（仓库内置，CC0-1.0）

- 来源：Quaternius *Universal Animation Library*, **Standard collection**（经 DirectorDesk 打包格式引入）
- 许可：**CC0-1.0 公有领域奉献** — 作者放弃全部著作权，**无署名义务、无商用限制**
  （CC0 无需署名，此处保留出处仅为溯源透明）
- 上游：https://quaternius.com/packs/universalanimationlibrary.html
- 许可全文：https://creativecommons.org/publicdomain/zero/1.0/
- 内容：10 个精选动捕 clip + 白模（站立待机/交谈手势/行走/慢跑/蹲姿待机/蹲着前进/坐下/坐姿待机/坐姿交谈/站起）
- 存储：`public/samples/motions/humanoid-v1.json`（2.7MB JSON，包裹 base64 GLB）+ 同目录 manifest
- 原始声明：见 `public/samples/motions/NOTICE-Quaternius-CC0.txt`
- 使用方式：重定向到当前角色骨架，仅骨骼旋转；根部位移仍由本项目髋部管线负责
