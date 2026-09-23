import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { executeAction, executeActions, clearIdempotencyCache, parseAction } from '../src/services/agent/toolRegistry';
import { planMock } from '../src/services/agent/mockAgent';
import { planHttp } from '../src/services/agent/httpAgent';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { useAnimationStore } from '../src/stores/animationStore';
import { useCharacterStore } from '../src/stores/characterStore';
import { useHistoryStore } from '../src/stores/historyStore';
import { useIKStore } from '../src/stores/ikStore';
import { useSelectionStore } from '../src/stores/selectionStore';
import { useSkeletonStore } from '../src/stores/skeletonStore';
import type { CharacterMeta } from '../src/types/global';

function bone(parent: THREE.Object3D, name: string, x: number, y: number, z = 0): THREE.Bone {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(x, y, z);
  parent.add(b);
  return b;
}

const META = { id: 'c', fileName: 't.glb', fileSize: 1, gltfInfo: { meshes: 1, materials: 1, bones: 5, hasSkin: true, hasAnimations: 0 } } as CharacterMeta;

function setupScene() {
  const g = new THREE.Group();
  const hips = bone(g, 'Hips', 0, 1, 0);
  bone(hips, 'Spine', 0, 0.2, 0);
  const ua = bone(hips, 'UpperArm_L', 0.2, 0.4, 0);
  const fa = bone(ua, 'Forearm_L', 0, -0.3, 0);
  bone(fa, 'Hand_L', 0, -0.25, 0);
  g.updateWorldMatrix(true, true);
  useCharacterStore.getState().setCharacter(META, g);
  useSkeletonStore.getState().setSnapshot(buildSkeletonTree(g));
  return g;
}

beforeEach(() => {
  useCharacterStore.getState().clear();
  useSkeletonStore.getState().setSnapshot(null);
  useSelectionStore.getState().select(null);
  useAnimationStore.setState({ animations: [], activeId: null, currentTime: 0, playing: false, loop: true });
  useHistoryStore.getState().clear();
  useIKStore.getState().clear();
  clearIdempotencyCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseAction', () => {
  it('未知 tool / 缺 args / 缺 key 均拒绝', () => {
    expect(parseAction({ tool: 'rm_rf', args: {}, idempotencyKey: 'k' }).error).toMatch(/未知 tool/);
    expect(parseAction({ tool: 'select_bone', idempotencyKey: 'k' }).error).toMatch(/args/);
    expect(parseAction({ tool: 'select_bone', args: {} }).error).toMatch(/idempotencyKey/);
  });
});

describe('toolRegistry 需要角色的工具在空场景报错', () => {
  it('select/modify/keyframe/check 返回 NO_CHARACTER 而非崩溃', async () => {
    expect((await executeAction({ tool: 'select_bone', args: { bone: 'Hips' }, idempotencyKey: 'a1' })).error?.code).toBe('NO_CHARACTER');
    expect((await executeAction({ tool: 'modify_bone', args: { bone: 'Hips', rotationDeltaDeg: [0, 0, 10] }, idempotencyKey: 'a2' })).error?.code).toBe('NO_CHARACTER');
    expect((await executeAction({ tool: 'check_physics', args: {}, idempotencyKey: 'a3' })).error?.code).toBe('NO_CHARACTER');
    expect((await executeAction({ tool: 'load_character', args: {}, idempotencyKey: 'a4' })).error?.code).toBe('NEEDS_USER_FILE');
    expect((await executeAction({ tool: 'retarget_motion', args: {}, idempotencyKey: 'a5' })).error?.code).toBe('RESERVED');
  });
});

describe('toolRegistry 真实执行链', () => {
  it('select → modify → keyframe → delete 一轮', async () => {
    setupScene();
    const sel = await executeAction({ tool: 'select_bone', args: { bone: 'upperArm.L' }, idempotencyKey: 'b1' });
    expect(sel.ok).toBe(true);
    expect(sel.data).toMatchObject({ name: 'UpperArm_L' });

    const mod = await executeAction({ tool: 'modify_bone', args: { bone: 'UpperArm_L', rotationDeltaDeg: [0, 0, 25] }, idempotencyKey: 'b2' });
    expect(mod.ok).toBe(true);

    const anim = await executeAction({ tool: 'create_animation', args: { name: 'AgentTake' }, idempotencyKey: 'b3' });
    expect(anim.ok).toBe(true);

    const key = await executeAction({ tool: 'create_keyframe', args: { bone: 'UpperArm_L', time: 1 }, idempotencyKey: 'b4' });
    expect(key.ok).toBe(true);
    expect(useAnimationStore.getState().active()?.tracks[0].rotation.length).toBe(1);

    const del = await executeAction({ tool: 'delete_keyframe', args: { bone: 'UpperArm_L', time: 1 }, idempotencyKey: 'b5' });
    expect(del.ok).toBe(true);
    const del2 = await executeAction({ tool: 'delete_keyframe', args: { bone: 'UpperArm_L', time: 1 }, idempotencyKey: 'b6' });
    expect(del2.ok).toBe(false);
    expect(del2.error?.code).toBe('KEY_NOT_FOUND');
  });

  it('非法参数被拒绝（向量长度/插值/链名）', async () => {
    setupScene();
    const bad = await executeAction({ tool: 'modify_bone', args: { bone: 'Hips' }, idempotencyKey: 'c1' });
    expect(bad.error?.code).toBe('BAD_ARGS');
    const badV = await executeAction({ tool: 'modify_bone', args: { bone: 'Hips', rotationDeltaDeg: [0, 0] }, idempotencyKey: 'c2' });
    expect(badV.error?.code).toBe('BAD_ARGS');
    const badC = await executeAction({ tool: 'apply_ik', args: { chain: 'arm.X' }, idempotencyKey: 'c3' });
    expect(badC.error?.code).toBe('BAD_ARGS');
    const noBone = await executeAction({ tool: 'modify_bone', args: { bone: 'Nope', rotationDeltaDeg: [1, 0, 0] }, idempotencyKey: 'c4' });
    expect(noBone.error?.code).toBe('BONE_NOT_FOUND');
  });

  it('幂等：同 key 第二次回放不重复写', async () => {
    setupScene();
    await executeAction({ tool: 'create_animation', args: { name: 'X' }, idempotencyKey: 'dup' });
    const n1 = useAnimationStore.getState().animations.length;
    const replay = await executeAction({ tool: 'create_animation', args: { name: 'X' }, idempotencyKey: 'dup' });
    expect(useAnimationStore.getState().animations.length).toBe(n1);
    expect((replay.data as { idempotentReplay?: boolean }).idempotentReplay).toBe(true);
  });

  it('generate_motion 写出新动画（含模板与警告透传）', async () => {
    setupScene();
    const r = await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 2 }, idempotencyKey: 'g1' });
    expect(r.ok).toBe(true);
    expect((r.data as { tracks?: number }).tracks).toBeGreaterThan(0);
    expect(useAnimationStore.getState().animations.length).toBe(1);
  });

  it('inspect_skeleton 返回骨骼清单，支持 query', async () => {
    setupScene();
    const all = await executeAction({ tool: 'inspect_skeleton', args: {}, idempotencyKey: 's1' });
    expect((all.data as { boneCount?: number }).boneCount).toBe(5);
    const q = await executeAction({ tool: 'inspect_skeleton', args: { query: 'hand' }, idempotencyKey: 's2' });
    expect((q.data as { matched?: number }).matched).toBe(1);
  });
});

describe('mockAgent 规划', () => {
  it('左手抬高 → apply_ik + 整链 keyframes（全链路成功）', async () => {
    const { useIKStore: ik } = await import('../src/stores/ikStore');
    const { detectIKChains } = await import('../src/core/ik/chains');
    setupScene();
    const snap = useSkeletonStore.getState().snapshot!;
    ik.getState().initChains(detectIKChains(snap));
    await executeAction({ tool: 'create_animation', args: { name: 'T' }, idempotencyKey: 'arm0' });
    const before = ik.getState().chains['arm.L']?.target[1] ?? 0;
    const p = planMock('左手抬高');
    expect(p.actions.length).toBe(4);
    expect(p.actions[0]).toMatchObject({ tool: 'apply_ik' });
    expect(p.actions[0].args).toMatchObject({ chain: 'arm.L', enable: true });
    const results = await executeActions(p.actions);
    expect(results.every((r) => r.ok)).toBe(true);
    // IK 目标被抬高 + 整链落 key
    expect((ik.getState().chains['arm.L']?.target[1] ?? 0)).toBeGreaterThan(before);
    const tracks = useAnimationStore.getState().active()?.tracks ?? [];
    expect(tracks.map((t) => t.boneName).sort()).toEqual(['Forearm_L', 'Hand_L', 'UpperArm_L']);
  });

  it('下蹲 → 双腿IK + 髋部位移（无链也诚实说明）', () => {
    setupScene();
    const p = planMock('下蹲');
    expect(p.actions.map((a) => a.tool)).toEqual(['apply_ik', 'apply_ik', 'modify_bone', 'create_keyframe']);
    expect(p.reply).toMatch(/无腿 IK 链/);
  });

  it('新建动画 / 检查物理 / 补帧 / 未理解', () => {
    expect(planMock('新建动画 连招').actions[0]).toMatchObject({ tool: 'create_animation' });
    expect(planMock('检查脚滑').actions[0]).toMatchObject({ tool: 'check_physics' });
    expect(planMock('补帧').actions[0]).toMatchObject({ tool: 'apply_inbetween' });
    expect(planMock('生成挥手动作').actions[0]).toMatchObject({ tool: 'generate_motion' });
    const unknown = planMock('今天天气怎么样');
    expect(unknown.actions).toEqual([]);
    expect(unknown.reply).toMatch(/没理解/);
  });

  it('打关键帧无选中时给指引而不执行', () => {
    setupScene();
    const p = planMock('打关键帧');
    expect(p.actions).toEqual([]);
    expect(p.reply).toMatch(/先在左侧选中/);
  });
});

describe('httpAgent 规划解析', () => {
  it('合法 LLM 响应解析为 actions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"reply":"ok","actions":[{"tool":"check_physics","args":{}}]}' } }],
      }),
    }));
    const r = await planHttp('检查一下', { baseUrl: 'http://x', model: 'm', apiKey: 'k' });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].tool).toBe('check_physics');
    expect(r.actions[0].idempotencyKey.length).toBeGreaterThan(0);
  });

  it('非法 action 被丢弃并警告，断网抛友好错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"reply":"x","actions":[{"tool":"rm","args":{}}]}' } }],
      }),
    }));
    const r = await planHttp('x', { baseUrl: 'http://x', model: 'm', apiKey: 'k' });
    expect(r.actions).toEqual([]);
    expect(r.warnings.join()).toMatch(/非法 action/);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(planHttp('x', { baseUrl: 'http://x', model: 'm', apiKey: 'k' })).rejects.toThrow(/连不上/);
  });
});
