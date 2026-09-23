import * as THREE from 'three';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useIKStore } from '../../stores/ikStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { captureBoneLocal, indexBonesByName } from '../../core/animation/applyPose';
import { solvePinsLive } from '../../core/ik/applyPoseWithIK';
import type { IKChainId } from '../../core/ik/types';
import { MockMotionProvider } from '../motion/MockMotionProvider';
import { MathInbetweenProvider } from '../inbetween/MathInbetweenProvider';
import { analyzeTrajectory } from '../../core/physics/analyze';
import { collectTrajectory } from '../../core/physics/trajectory';
import { exportGltf } from '../export/exportGltf';
import type { QuatTuple, Vec3Tuple } from '../../types/global';
import type { AgentAction, ToolName, ToolResult } from './toolTypes';
import { isToolName } from './toolTypes';

const mockMotion = new MockMotionProvider();
const mathInbetween = new MathInbetweenProvider();

/* ---------- 参数校验（手写严格校验，不引入 zod 依赖） ---------- */

function err(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

function reqStr(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function reqNum(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function optNum(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function reqVec3(args: Record<string, unknown>, key: string): Vec3Tuple | null {
  const v = args[key];
  if (!Array.isArray(v) || v.length !== 3) return null;
  const n = (v as unknown[]).map(Number);
  if (n.some((x) => !Number.isFinite(x) || Math.abs(x) > 100)) return null;
  return [n[0], n[1], n[2]];
}

function optVec3(args: Record<string, unknown>, key: string): Vec3Tuple | undefined {
  if (args[key] === undefined) return undefined;
  return reqVec3(args, key) ?? undefined;
}

/** 骨骼引用：精确名 → 语义（大小写不敏感，如 upperarm.l）→ null */
function resolveBone(scene: THREE.Object3D, ref: string): THREE.Bone | null {
  const bones = indexBonesByName(scene);
  if (bones.has(ref)) return bones.get(ref)!;
  const snap = useSkeletonStore.getState().snapshot;
  if (snap) {
    const lower = ref.toLowerCase();
    const node = Object.values(snap.nodes).find(
      (n) => n.name === ref || (n.semantic && n.semantic.toLowerCase() === lower),
    );
    if (node) {
      const b = bones.get(node.name);
      if (b) return b;
    }
  }
  return null;
}

function boneIdOf(name: string): string | null {
  const snap = useSkeletonStore.getState().snapshot;
  if (!snap) return null;
  const node = Object.values(snap.nodes).find((n) => n.name === name);
  return node ? node.id : null;
}

function needScene(): THREE.Group | ToolResult {
  const so = useCharacterStore.getState().sceneObject;
  return so ?? err('NO_CHARACTER', '未加载角色，请先拖入 GLB');
}

function needAnim() {
  const st = useAnimationStore.getState();
  const a = st.active();
  return a ?? null;
}

/* ---------- 工具实现 ---------- */

async function inspectSkeleton(args: Record<string, unknown>): Promise<ToolResult> {
  const snap = useSkeletonStore.getState().snapshot;
  if (!snap) return err('NO_CHARACTER', '未加载角色');
  const q = optStr(args, 'query')?.toLowerCase();
  const bones = Object.values(snap.nodes)
    .filter((n) => (!q || n.name.toLowerCase().includes(q)) && true)
    .map((n) => ({ name: n.name, semantic: n.semantic, parent: n.parent ? snap.nodes[n.parent]?.name ?? null : null }));
  return { ok: true, data: { boneCount: snap.boneCount, matched: bones.length, bones: bones.slice(0, 120) } };
}

async function selectBone(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = reqStr(args, 'bone');
  if (!ref) return err('BAD_ARGS', 'select_bone 需要 bone（名或语义）');
  const scene = needScene();
  if (!(scene instanceof THREE.Group)) return scene as ToolResult;
  const b = resolveBone(scene, ref);
  if (!b) return err('BONE_NOT_FOUND', `找不到骨骼 ${ref}`);
  const id = boneIdOf(b.name);
  useSelectionStore.getState().select(id);
  return { ok: true, data: { name: b.name, id } };
}

async function modifyBone(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = reqStr(args, 'bone');
  if (!ref) return err('BAD_ARGS', 'modify_bone 需要 bone');
  const scene = needScene();
  if (!(scene instanceof THREE.Group)) return scene as ToolResult;
  const b = resolveBone(scene, ref);
  if (!b) return err('BONE_NOT_FOUND', `找不到骨骼 ${ref}`);

  const absE = reqVec3(args, 'rotationEulerDeg');
  const deltaE = reqVec3(args, 'rotationDeltaDeg');
  const absP = reqVec3(args, 'position');
  const deltaP = reqVec3(args, 'positionDelta');
  if (!absE && !deltaE && !absP && !deltaP) {
    return err('BAD_ARGS', 'modify_bone 需要 rotationEulerDeg / rotationDeltaDeg / position / positionDelta 之一');
  }
  if (absE) {
    b.quaternion.setFromEuler(
      new THREE.Euler(THREE.MathUtils.degToRad(absE[0]), THREE.MathUtils.degToRad(absE[1]), THREE.MathUtils.degToRad(absE[2]), 'XYZ'),
    );
  }
  if (deltaE) {
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(THREE.MathUtils.degToRad(deltaE[0]), THREE.MathUtils.degToRad(deltaE[1]), THREE.MathUtils.degToRad(deltaE[2]), 'XYZ'),
    );
    b.quaternion.multiply(q);
  }
  if (absP) b.position.fromArray(absP);
  if (deltaP) b.position.set(b.position.x + deltaP[0], b.position.y + deltaP[1], b.position.z + deltaP[2]);
  scene.updateWorldMatrix(true, true);
  return { ok: true, data: { bone: b.name, quaternion: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w] as QuatTuple } };
}

async function createKeyframe(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = reqStr(args, 'bone');
  if (!ref) return err('BAD_ARGS', 'create_keyframe 需要 bone');
  const scene = needScene();
  if (!(scene instanceof THREE.Group)) return scene as ToolResult;
  const b = resolveBone(scene, ref);
  if (!b) return err('BONE_NOT_FOUND', `找不到骨骼 ${ref}`);
  const anim = needAnim();
  if (!anim) return err('NO_ANIMATION', '无活动动画，先 create_animation');
  const interp = optStr(args, 'interp');
  if (interp !== undefined && interp !== 'linear' && interp !== 'step') {
    return err('BAD_ARGS', 'interp 仅支持 linear/step');
  }
  const cap = captureBoneLocal(scene, b.name);
  if (!cap) return err('BONE_NOT_FOUND', `读取 ${b.name} 失败`);
  const time = optNum(args, 'time', useAnimationStore.getState().currentTime);
  const includePosition = args['includePosition'] === true;
  useAnimationStore.getState().bakePoseKeys(
    [{ boneName: b.name, time, value: cap.quaternion, interp: (interp ?? 'linear') as 'linear' | 'step' }],
    includePosition ? [{ boneName: b.name, time, value: cap.position }] : [],
  );
  return { ok: true, data: { bone: b.name, time } };
}

async function deleteKeyframe(args: Record<string, unknown>): Promise<ToolResult> {
  const ref = reqStr(args, 'bone');
  const time = reqNum(args, 'time');
  if (!ref || time === null) return err('BAD_ARGS', 'delete_keyframe 需要 bone + time');
  const scene = needScene();
  if (!(scene instanceof THREE.Group)) return scene as ToolResult;
  const b = resolveBone(scene, ref);
  if (!b) return err('BONE_NOT_FOUND', `找不到骨骼 ${ref}`);
  const ok = useAnimationStore.getState().deleteRotationKey(b.name, time);
  if (!ok) return err('KEY_NOT_FOUND', `${b.name} @${time}s 无关键帧`);
  return { ok: true, data: { bone: b.name, time } };
}

async function createAnimation(args: Record<string, unknown>): Promise<ToolResult> {
  const name = optStr(args, 'name') ?? 'Take';
  const id = useAnimationStore.getState().createAnimation(name.slice(0, 64));
  return { ok: true, data: { id, name } };
}

async function generateMotion(args: Record<string, unknown>): Promise<ToolResult> {
  const prompt = reqStr(args, 'prompt');
  if (!prompt) return err('BAD_ARGS', 'generate_motion 需要 prompt');
  const snap = useSkeletonStore.getState().snapshot;
  if (!snap) return err('NO_CHARACTER', '未加载角色');
  const duration = Math.min(Math.max(optNum(args, 'duration', 4), 0.5), 30);
  try {
    const r = await mockMotion.generateMotion({ prompt, skeleton: snap, duration, fps: 30 });
    const id = useAnimationStore.getState().createAnimation(r.animation.name);
    useAnimationStore.setState((s) => {
      const anims = structuredClone(s.animations);
      const a = anims.find((x) => x.id === id);
      if (a) {
        a.duration = r.animation.duration;
        a.fps = r.animation.fps;
        a.tracks = structuredClone(r.animation.tracks);
      }
      return { animations: anims, activeId: id, currentTime: 0 };
    });
    return { ok: true, data: { animationId: id, tracks: r.animation.tracks.length, template: r.meta.template, warnings: r.meta.warnings } };
  } catch (e) {
    return err('GENERATE_FAILED', e instanceof Error ? e.message : '生成失败');
  }
}

async function applyIk(args: Record<string, unknown>): Promise<ToolResult> {
  const chain = reqStr(args, 'chain');
  if (chain !== 'arm.L' && chain !== 'arm.R' && chain !== 'leg.L' && chain !== 'leg.R') {
    return err('BAD_ARGS', 'apply_ik 的 chain 须为 arm.L/arm.R/leg.L/leg.R');
  }
  const id = chain as IKChainId;
  const st = useIKStore.getState();
  const c = st.chains[id];
  if (!c) return err('CHAIN_MISSING', `${chain} 未检测到（检查语义映射）`);
  const wantEnable = typeof args['enable'] === 'boolean' ? (args['enable'] as boolean) : !c.enabled;
  if (wantEnable !== c.enabled) st.toggleChain(id);
  const target = optVec3(args, 'target');
  if (target) st.setTarget(id, target);
  const delta = optVec3(args, 'targetDelta');
  if (delta) {
    const t = st.chains[id]?.target ?? c.target;
    st.setTarget(id, [t[0] + delta[0], t[1] + delta[1], t[2] + delta[2]]);
  }
  const pole = optVec3(args, 'polePoint');
  if (pole) st.setPolePoint(id, pole);
  const cur = useIKStore.getState().chains[id]!;
  // 同步求解（自检）：不等下一帧，立即把骨骼拉到目标，避免后续 keyframe 抓到旧姿势导致闪烁
  let solve: { reached: boolean; hingeDeg: number; clamped: boolean } | null = null;
  if (cur.enabled) {
    const scene = useCharacterStore.getState().sceneObject;
    if (scene) {
      try {
        const solved = solvePinsLive(scene, [{ def: cur.def, target: [...cur.target], polePoint: [...cur.polePoint] }]);
        const s = solved[0];
        if (s) {
          solve = { reached: s.reached, hingeDeg: s.hingeDeg, clamped: s.clamped };
          st.setLastSolve(id, { reached: s.reached, hingeDeg: s.hingeDeg, clamped: s.clamped });
        }
      } catch (e) {
        return err('IK_FAILED', e instanceof Error ? e.message : 'IK 求解失败');
      }
    }
  }
  return {
    ok: true,
    data: {
      chain,
      enabled: cur.enabled,
      target: cur.target,
      reached: solve?.reached ?? null,
      hingeDeg: solve ? Math.round(solve.hingeDeg * 10) / 10 : null,
      clamped: solve?.clamped ?? false,
    },
  };
}

async function applyInbetween(args: Record<string, unknown>): Promise<ToolResult> {
  const anim = needAnim();
  if (!anim) return err('NO_ANIMATION', '无活动动画');
  const density = Math.min(Math.max(optNum(args, 'density', 12), 2), 120);
  const ease = optStr(args, 'ease');
  if (ease !== undefined && !['linear', 'easeIn', 'easeOut', 'easeInOut', 'easeOutIn'].includes(ease)) {
    return err('BAD_ARGS', 'ease 非法');
  }
  const r = await mathInbetween.runInbetween({
    animation: anim,
    minTime: 0,
    maxTime: anim.duration,
    density,
    ease: (ease ?? 'linear') as 'linear',
  });
  const st = useAnimationStore.getState();
  st.replaceAll([r.animation, ...st.animations.filter((a) => a.id !== anim.id)], anim.id);
  return { ok: true, data: { addedKeys: r.meta.addedKeys } };
}

async function checkPhysics(): Promise<ToolResult> {
  const scene = needScene();
  if (!(scene instanceof THREE.Group)) return scene as ToolResult;
  const anim = needAnim();
  if (!anim) return err('NO_ANIMATION', '无活动动画');
  const snap = useSkeletonStore.getState().snapshot;
  if (!snap) return err('NO_CHARACTER', '无骨骼快照');
  const bySem = new Map(Object.values(snap.nodes).map((n) => [n.semantic, n.name]));
  const hips = bySem.get('hips');
  if (!hips) return err('NO_HIPS', '未找到 hips 骨骼');
  const { samples, warnings } = collectTrajectory(
    scene,
    anim,
    { hips, footL: bySem.get('foot.L') ?? null, footR: bySem.get('foot.R') ?? null },
    30,
  );
  const issues = analyzeTrajectory(samples);
  return { ok: true, data: { issues, warnings } };
}

async function exportAnimation(args: Record<string, unknown>): Promise<ToolResult> {
  const scene = needScene();
  if (!(scene instanceof THREE.Group)) return scene as ToolResult;
  const meta = useCharacterStore.getState().meta;
  if (!meta) return err('NO_CHARACTER', '无角色元信息');
  const anims = useAnimationStore.getState().animations;
  const onlyId = optStr(args, 'animationId');
  const list = onlyId ? anims.filter((a) => a.id === onlyId) : anims;
  if (list.length === 0) return err('NO_ANIMATION', '无可导出动画');
  try {
    const r = await exportGltf(scene, list, meta.fileName);
    return { ok: true, data: { fileName: r.fileName, clipCount: r.clipCount, warnings: r.warnings } };
  } catch (e) {
    return err('EXPORT_FAILED', e instanceof Error ? e.message : '导出失败');
  }
}

/* ---------- 分发 + 幂等 ---------- */

const seen = new Map<string, ToolResult>();

const HANDLERS: Record<ToolName, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  load_character: () => Promise.resolve(err('NEEDS_USER_FILE', 'load_character 需用户拖入 GLB 文件，Agent 无法代传文件')),
  inspect_skeleton: inspectSkeleton,
  select_bone: selectBone,
  modify_bone: modifyBone,
  create_keyframe: createKeyframe,
  delete_keyframe: deleteKeyframe,
  create_animation: createAnimation,
  generate_motion: generateMotion,
  retarget_motion: () =>
    Promise.resolve(err('RESERVED', 'retarget 已内建于 generate_motion，独立 retarget 后续版本提供')),
  apply_ik: applyIk,
  apply_inbetween: applyInbetween,
  check_physics: checkPhysics,
  export_animation: exportAnimation,
};

export function parseAction(raw: unknown): { action?: AgentAction; error?: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'action 须为对象' };
  const r = raw as Record<string, unknown>;
  if (!isToolName(r['tool'])) return { error: `未知 tool: ${String(r['tool'])}` };
  if (typeof r['args'] !== 'object' || r['args'] === null) return { error: 'args 须为对象' };
  if (typeof r['idempotencyKey'] !== 'string' || (r['idempotencyKey'] as string).length === 0) {
    return { error: 'idempotencyKey 须为非空字符串' };
  }
  return { action: { tool: r['tool'], args: r['args'] as Record<string, unknown>, idempotencyKey: r['idempotencyKey'] as string } };
}

export async function executeAction(raw: unknown): Promise<ToolResult> {
  const { action, error } = parseAction(raw);
  if (!action) return err('BAD_ACTION', error ?? '非法 action');
  if (seen.has(action.idempotencyKey)) {
    const cached = seen.get(action.idempotencyKey)!;
    return { ...cached, data: { ...((cached.data as Record<string, unknown> | undefined) ?? {}), idempotentReplay: true } };
  }
  try {
    const result = await HANDLERS[action.tool](action.args);
    seen.set(action.idempotencyKey, result);
    return result;
  } catch (e) {
    const r = err('TOOL_CRASH', e instanceof Error ? e.message : String(e));
    seen.set(action.idempotencyKey, r);
    return r;
  }
}

export async function executeActions(actions: AgentAction[]): Promise<ToolResult[]> {
  const out: ToolResult[] = [];
  for (const a of actions) out.push(await executeAction(a));
  return out;
}

export function clearIdempotencyCache() {
  seen.clear();
}
