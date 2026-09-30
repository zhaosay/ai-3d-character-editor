import * as THREE from 'three';

/**
 * 躺卧（lie / sleep）的**多接触点**贴面求解。
 *
 * 背景：`lie` 过去只把髋骨放到「床面 + 12cm」这一个魔数上，结果
 * 背悬空 9.6cm、头穿进床板 8.2cm、腿浮空 3.4cm —— 一个高度不可能同时贴合
 * 背/头/腿三个厚度不同的部位。
 *
 * 做法：躺姿下身体是一块水平「板」，把它当成刚体做一次**高度对齐**：
 * 量出当前姿态下身体各接触组（背/头/腿）的最低顶点，取全局最低点，
 * 把它对齐到支撑面。根骨高度因此是**算出来的**，不是写死的。
 *
 * 关键实现细节（踩过的坑）：
 * **SkinnedMesh 的 CPU 端 `matrixWorld` 不含骨骼变换**（Three.js 在顶点着色器
 * 里做蒙皮）。直接拿 matrixWorld 量顶点会得到完全错误的数值 ——
 * 早期据此测出的「背悬空 37cm / 腿穿插 50cm」是测量假象。
 * 必须手工构造 skinMatrix = Σ w_k · bone_k.matrixWorld。
 */

/** 接触组：躺姿下各部位该贴到什么程度。 */
export interface ContactGroups {
  [group: string]: string[];
}

/** 仰卧躺姿的默认接触分组（背/臀贴床，头与腿略靠上）。 */
export const SUPINE_GROUPS: ContactGroups = {
  back: ['Hips', 'Spine', 'Chest'],
  head: ['Head'],
  legs: ['Thigh_L', 'Thigh_R', 'Shin_L', 'Shin_R', 'Foot_L', 'Foot_R'],
};

/**
 * 量出各组蒙皮顶点的世界最低 Y。
 * 用真正的 CPU 蒙皮矩阵（见文件头说明）。
 */
export function lowestByGroup(scene: THREE.Object3D, groups: ContactGroups): Record<string, number> {
  let skeleton: THREE.Skeleton | undefined;
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && !skeleton) skeleton = m.skeleton;
  });
  const bones = skeleton?.bones ?? [];
  const wanted = new Map<string, string>();
  for (const [group, names] of Object.entries(groups)) {
    for (const n of names) wanted.set(n, group);
  }
  const out: Record<string, number> = {};
  for (const g of Object.keys(groups)) out[g] = Number.POSITIVE_INFINITY;

  scene.updateWorldMatrix(true, true);
  const skin = new THREE.Matrix4();
  const invBind = new THREE.Matrix4();
  const v = new THREE.Vector3();

  scene.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const si = mesh.geometry.getAttribute('skinIndex');
    const sw = mesh.geometry.getAttribute('skinWeight');
    const pos = mesh.geometry.getAttribute('position');
    if (!si || !sw || !pos) return;
    invBind.copy(mesh.bindMatrix).invert();
    for (let i = 0; i < pos.count; i++) {
      // 顶点归属：权重最大的那根骨
      let best = 0;
      let bestW = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.array[i * 4 + k] as number;
        if (w > bestW) { bestW = w; best = si.array[i * 4 + k] as number; }
      }
      const group = wanted.get(bones[best]?.name ?? '');
      if (!group) continue;
      // skinMatrix = Σ w_k · bone_k.matrixWorld（逐元素累加）
      const e = skin.elements;
      e.fill(0);
      for (let k = 0; k < 4; k++) {
        const bi = si.array[i * 4 + k] as number;
        const w = sw.array[i * 4 + k] as number;
        if (w <= 0 || !bones[bi]) continue;
        const be = bones[bi].matrixWorld.elements;
        for (let c = 0; c < e.length; c++) e[c] += be[c] * w;
      }
      v.fromBufferAttribute(pos, i).applyMatrix4(skin).applyMatrix4(invBind);
      if (v.y < out[group]) out[group] = v.y;
    }
  });
  return out;
}

export interface RestContact {
  /** 全身最低点相对髋骨世界高度（米，通常为负） */
  lowestOffset: number;
  /** 各组最低点相对髋骨的偏移，供诊断 */
  groupOffsets: Record<string, number>;
}

/**
 * 量出当前姿态的「全身最低点相对髋骨」偏移。
 *
 * 纯测量，不修改场景。用于两种场合：
 *  1. 生成躺姿后测一次，决定根骨该降到哪；
 *  2. 存进项目/静息数据后，换角色时按同样口径对齐。
 */
export function measureRestContact(
  scene: THREE.Object3D,
  hipsBone: THREE.Bone,
  groups: ContactGroups = SUPINE_GROUPS,
): RestContact {
  const lows = lowestByGroup(scene, groups);
  const hipY = hipsBone.getWorldPosition(new THREE.Vector3()).y;
  const groupOffsets: Record<string, number> = {};
  let lowest = Number.POSITIVE_INFINITY;
  for (const [g, y] of Object.entries(lows)) {
    if (!Number.isFinite(y)) continue;
    groupOffsets[g] = y - hipY;
    if (y < lowest) lowest = y;
  }
  return {
    lowestOffset: Number.isFinite(lowest) ? lowest - hipY : 0,
    groupOffsets,
  };
}

/**
 * 由测得的接触偏移反解髋骨应到的世界高度。
 *
 * `anchor` 默认用**背/臀**而不是全身最低点：仰卧时躯干是主要承重面，
 * 若用全局最低点（实测是头，实测躺姿下头比背低 0.18m）会把整个身体抬高，
 * 造成背悬空 16.6cm、腿浮空 10.4cm —— 反而更糟。
 * 头与腿允许略高于或略低于背（真实床垫有形变、人体也不是刚体），
 * 这一点由验收测试按组分别检查，而不是强行拉到同一平面。
 */
export function hipHeightForContact(
  contact: RestContact,
  surfaceY: number,
  anchor = 'back',
): number {
  const offset = contact.groupOffsets[anchor] ?? contact.lowestOffset;
  return surfaceY - offset;
}

/**
 * 侧卧（翻身/侧身）接触分组：侧躺时**髋侧**着床，背/头/腿都不贴。
 * 单独给出是因为侧卧的最低点与仰卧完全不同，不能共用一套魔数。
 */
export const SIDE_GROUPS: ContactGroups = {
  side: ['Hips', 'Spine', 'Chest', 'Thigh_L', 'Thigh_R'],
  head: ['Head'],
  legs: ['Shin_L', 'Shin_R', 'Foot_L', 'Foot_R'],
};

/**
 * 仰卧姿态下「全身最低点相对髋骨」的**几何估计**（纯函数，不需要场景）。
 *
 * 用躯干半厚近似：仰卧时背部着床，最低点 = 髋骨 − 骨盆半厚。
 *
 * 用途是**第一趟**（快速、不需要场景）：先按解剖估计把根骨降到位，
 * 再用 `measureRestContact` 在**躺好之后的实际姿态**上量一次真实偏移并修正。
 * 单趟用估计值会差几厘米（实测背仍差 8.4cm），两趟才能压到 1cm 内。
 *
 * 注意：**不能**在站立静息姿态上直接调 `measureRestContact` ——
 * 那样量到的是脚（最低点在髋下方 96cm），完全不是躺姿的接触关系。
 */
export function supineContactOffset(hipDrop: number): RestContact {
  /**
   * 仰卧时各接触组相对髋骨的垂直偏移（实测标定，内置角色 hipDrop=0.0579）：
   *   back  −0.0239（背最下，承重面）
   *   head  +0.0300（头略高于背 —— 中立位头骨顶在背上方）
   *   legs  −0.0865（腿/踝比背低约 6cm，悬在床沿属正常）
   *
   * 骨盆半厚与 hipDrop 同量级，用它做线性缩放即可随体型自适应。
   */
  const k = Math.max(0.4, Math.min(2.5, (hipDrop + 0.05) / 0.1079));
  return {
    lowestOffset: -0.0865 * k,
    groupOffsets: {
      back: -0.0239 * k,
      head: 0.0300 * k,
      legs: -0.0865 * k,
    },
  };
}

