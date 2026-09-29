import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { executeAction, executeActions, clearIdempotencyCache, parseAction } from '../src/services/agent/toolRegistry';
import { planMock } from '../src/services/agent/mockAgent';
import { planHttp } from '../src/services/agent/httpAgent';
import { buildSkeletonTree } from '../src/core/skeleton/buildSkeletonTree';
import { detectIKChains } from '../src/core/ik/chains';
import { ambiguousScenePropIds, findStagePropOverlaps, findStagePropRoomOverflows, resolvePropInteractionFrame, sampleDoorOpenAngle, type StageProp } from '../src/core/previs/world';
import { validateScenePlan } from '../src/core/previs/scenePlan';
import { useAnimationStore } from '../src/stores/animationStore';
import { useCharacterStore } from '../src/stores/characterStore';
import { useHistoryStore } from '../src/stores/historyStore';
import { useIKStore } from '../src/stores/ikStore';
import { useSelectionStore } from '../src/stores/selectionStore';
import { useSkeletonStore } from '../src/stores/skeletonStore';
import { usePrevisStore } from '../src/stores/previsStore';
import { useWorldStore } from '../src/stores/worldStore';
import { useCameraStore } from '../src/stores/cameraStore';
import { useEffectsStore } from '../src/stores/effectsStore';
import { useMotionStore } from '../src/stores/motionStore';
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

function addFaceTarget(scene: THREE.Group) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const position = geometry.attributes['position'] as THREE.BufferAttribute;
  const target = position.clone();
  for (let index = 0; index < target.count; index++) target.setY(index, target.getY(index) + 0.1);
  geometry.morphAttributes.position = [target];
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = 'Face';
  mesh.updateMorphTargets();
  mesh.morphTargetDictionary = { eyeBlinkLeft: 0 };
  scene.add(mesh);
  return { meshPath: String(scene.children.indexOf(mesh)), targetName: 'eyeBlinkLeft' };
}

beforeEach(() => {
  useCharacterStore.getState().clear();
  useSkeletonStore.getState().setSnapshot(null);
  useSelectionStore.getState().select(null);
  useAnimationStore.setState({ animations: [], activeId: null, currentTime: 0, playing: false, loop: true });
  useHistoryStore.getState().clear();
  useIKStore.getState().clear();
  usePrevisStore.getState().clear();
  useWorldStore.getState().clear();
  useCameraStore.getState().clear();
  useEffectsStore.getState().clear();
  useMotionStore.getState().setProvider('mock');
  useMotionStore.getState().setBaseUrl('http://127.0.0.1:8123');
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
    expect(parseAction({ tool: 'set_previs_event', args: { operation: 'add' }, idempotencyKey: 'event-tool' }).action?.tool).toBe('set_previs_event');
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

  it('Agent 可对真实存在的表情目标写入并删除动画关键帧', async () => {
    const scene = setupScene();
    const target = addFaceTarget(scene);
    await executeAction({ tool: 'create_animation', args: { name: '表情' }, idempotencyKey: 'face-anim' });
    const set = await executeAction({ tool: 'set_face_keyframe', args: { operation: 'upsert', ...target, time: 1, value: 0.9 }, idempotencyKey: 'face-key' });
    expect(set.ok).toBe(true);
    expect(useAnimationStore.getState().active()?.faceTracks?.[0].keys[0]).toMatchObject({ time: 1, value: 0.9 });
    const invalid = await executeAction({ tool: 'set_face_keyframe', args: { operation: 'upsert', meshPath: target.meshPath, targetName: 'imaginarySmile', time: 1, value: 0.5 }, idempotencyKey: 'face-invalid' });
    expect(invalid.error?.code).toBe('MORPH_NOT_FOUND');
    const remove = await executeAction({ tool: 'set_face_keyframe', args: { operation: 'remove', ...target, time: 1 }, idempotencyKey: 'face-remove' });
    expect(remove.ok).toBe(true);
    expect(useAnimationStore.getState().active()?.faceTracks).toEqual([]);
  });

  it('一句话开门会生成带门扇时间动画和把手接触的可播放预演', async () => {
    setupScene();
    const door: StageProp = { id: 'door-agent', kind: 'door', position: [1, 0, 0], rotationY: 0, size: { width: 0.9, height: 2.05, length: 0.08 } };
    useWorldStore.getState().replaceProps([door]);
    const generated = await executeAction({ tool: 'generate_motion', args: { prompt: '人物走到门口开门', duration: 4 }, idempotencyKey: 'generate-open-door' });
    expect(generated.ok).toBe(true);
    const active = useAnimationStore.getState().active()!;
    const plan = usePrevisStore.getState().byAnimationId[active.id].scenePlan!;
    expect(plan.actions.map((action) => action.template)).toEqual(['march', 'orient', 'reach']);
    expect(plan.contacts).toContainEqual(expect.objectContaining({ actionIndex: 2, bodyPart: 'hand', propId: door.id, surface: 'handle' }));
    expect(sampleDoorOpenAngle(plan.actions, door.id, 0)).toBe(0);
    expect(sampleDoorOpenAngle(plan.actions, door.id, 4)).toBeCloseTo(Math.PI / 2);
    expect(active.tracks.length).toBeGreaterThan(0);

    const sequence = await executeAction({ tool: 'generate_motion', args: { prompt: '开门后走进去再关门', duration: 8 }, idempotencyKey: 'generate-pass-through-door' });
    expect(sequence.ok).toBe(true);
    const nextAnimation = useAnimationStore.getState().active()!;
    const nextPlan = usePrevisStore.getState().byAnimationId[nextAnimation.id].scenePlan!;
    expect(nextPlan.actions.map((action) => action.template)).toEqual(['march', 'orient', 'reach', 'march', 'reach']);
    expect(sampleDoorOpenAngle(nextPlan.actions, door.id, nextPlan.actions[3].t0)).toBeCloseTo(Math.PI / 2);
    expect(sampleDoorOpenAngle(nextPlan.actions, door.id, 8)).toBeCloseTo(0);
  });

  it('AI 关节限幅修复只改指定骨骼且可撤销', async () => {
    const scene = new THREE.Group();
    const hips = bone(scene, 'Hips', 0, 1, 0);
    bone(hips, 'Head', 0, 0.5, 0);
    scene.updateWorldMatrix(true, true);
    useCharacterStore.getState().setCharacter(META, scene);
    useSkeletonStore.getState().setSnapshot(buildSkeletonTree(scene));
    const animationId = useAnimationStore.getState().createAnimation('关节限幅');
    const overLimit = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(120));
    useAnimationStore.getState().upsertRotationKey('Head', 0, [overLimit.x, overLimit.y, overLimit.z, overLimit.w]);
    useAnimationStore.getState().upsertRotationKey('Head', 1, [overLimit.x, overLimit.y, overLimit.z, overLimit.w]);
    useAnimationStore.getState().selectAnimation(animationId);

    const checked = await executeAction({ tool: 'check_physics', args: {}, idempotencyKey: 'physics-check-head' });
    expect(checked.ok).toBe(true);
    expect((checked.data as { issues: Array<{ kind: string; boneName?: string }> }).issues).toContainEqual(expect.objectContaining({ kind: 'jointLimit', boneName: 'Head' }));
    const fixed = await executeAction({ tool: 'repair_joint_limit', args: { boneName: 'Head', time: 0.5 }, idempotencyKey: 'physics-fix-head' });
    expect(fixed).toMatchObject({ ok: true, data: { boneName: 'Head', undoable: true } });
    const repaired = useAnimationStore.getState().active()!.tracks.find((track) => track.boneName === 'Head')!.rotation;
    expect(Math.max(...repaired.map((key) => THREE.MathUtils.radToDeg(2 * Math.acos(Math.abs(key.value[3])))))).toBeLessThan(66);

    useAnimationStore.getState().undo();
    const undone = useAnimationStore.getState().active()!.tracks.find((track) => track.boneName === 'Head')!.rotation;
    expect(undone).toHaveLength(2);
    expect(Math.max(...undone.map((key) => THREE.MathUtils.radToDeg(2 * Math.acos(Math.abs(key.value[3])))))).toBeGreaterThan(119);
  });

  it('AI 物理检查返回场景道具碰撞与支撑诊断', async () => {
    const scene = setupScene();
    const animationId = useAnimationStore.getState().createAnimation('道具碰撞检查');
    useAnimationStore.getState().selectAnimation(animationId);
    useWorldStore.getState().replaceProps([{
      id: 'desk-near-hand', kind: 'table', position: [0.2, 0.1, 0], rotationY: 0,
      size: { width: 0.8, height: 0.75, length: 0.8 },
    }]);

    const result = await executeAction({ tool: 'check_physics', args: {}, idempotencyKey: 'physics-check-prop-collision' });
    const data = result.data as { collisionFindings: Array<{ propId: string }>; collisionWarnings: string[]; supportWarnings: string[] };

    expect(result.ok).toBe(true);
    expect(data.collisionFindings).toContainEqual(expect.objectContaining({ propId: 'desk-near-hand' }));
    expect(data.collisionWarnings.some((warning) => warning.includes('desk-near-hand'))).toBe(true);
    expect(Array.isArray(data.supportWarnings)).toBe(true);
    expect(scene.children.length).toBeGreaterThan(0);
  });

  it('AI 穿透修复要求消歧脚侧，修复髋部并可撤销', async () => {
    const scene = new THREE.Group();
    const hips = bone(scene, 'Hips', 0, 1, 0);
    bone(hips, 'Foot_L', -0.1, -1.2, 0);
    bone(hips, 'Foot_R', 0.1, -1.2, 0);
    scene.updateWorldMatrix(true, true);
    useCharacterStore.getState().setCharacter(META, scene);
    useSkeletonStore.getState().setSnapshot(buildSkeletonTree(scene));
    const animationId = useAnimationStore.getState().createAnimation('穿透修复');
    useAnimationStore.getState().selectAnimation(animationId);

    const checked = await executeAction({ tool: 'check_physics', args: {}, idempotencyKey: 'physics-check-feet' });
    expect((checked.data as { issues: Array<{ kind: string; foot?: string }> }).issues.filter((issue) => issue.kind === 'penetration')).toHaveLength(2);
    const ambiguous = await executeAction({ tool: 'repair_physics', args: { kind: 'penetration', time: 0.5 }, idempotencyKey: 'physics-fix-ambiguous' });
    expect(ambiguous.error?.code).toBe('AMBIGUOUS_ISSUE');
    const fixed = await executeAction({ tool: 'repair_physics', args: { kind: 'penetration', time: 0.5, foot: 'L' }, idempotencyKey: 'physics-fix-left-foot' });
    expect(fixed).toMatchObject({ ok: true, data: { kind: 'penetration', foot: 'L', undoable: true } });
    const checkedAfter = await executeAction({ tool: 'check_physics', args: {}, idempotencyKey: 'physics-check-fixed-feet' });
    expect((checkedAfter.data as { issues: Array<{ kind: string }> }).issues.filter((issue) => issue.kind === 'penetration')).toHaveLength(0);

    useAnimationStore.getState().undo();
    expect(useAnimationStore.getState().active()!.tracks.find((track) => track.boneName === 'Hips')?.position ?? []).toHaveLength(0);
  });

  it('AI 脚滑修复要求可用腿 IK 链、写入整链轨道且不污染现场骨架', async () => {
    const scene = new THREE.Group();
    const hips = bone(scene, 'Hips', 0, 1, 0);
    const thigh = bone(hips, 'Thigh_L', 0, 0, 0);
    const shin = bone(thigh, 'Shin_L', 0, -0.5, 0.25);
    bone(shin, 'Foot_L', 0, -0.5, -0.25);
    scene.updateWorldMatrix(true, true);
    useCharacterStore.getState().setCharacter(META, scene);
    const snapshot = buildSkeletonTree(scene);
    useSkeletonStore.getState().setSnapshot(snapshot);
    const animationId = useAnimationStore.getState().createAnimation('脚滑修复');
    useAnimationStore.getState().selectAnimation(animationId);
    useAnimationStore.getState().bakePoseKeys([], [
      { boneName: 'Hips', time: 0, value: [0, 1, 0] },
      { boneName: 'Hips', time: 1, value: [0.5, 1, 0] },
    ]);
    const issue = (await executeAction({ tool: 'check_physics', args: {}, idempotencyKey: 'physics-check-slide' })).data as { issues: Array<{ kind: string; foot?: string; t0: number }> };
    const slide = issue.issues.find((item) => item.kind === 'footSlide' && item.foot === 'L');
    expect(slide).toBeDefined();

    const unavailable = await executeAction({ tool: 'repair_physics', args: { kind: 'footSlide', foot: 'L', time: slide!.t0 }, idempotencyKey: 'physics-slide-no-chain' });
    expect(unavailable.error?.code).toBe('IK_CHAIN_MISSING');
    useIKStore.getState().initChains(detectIKChains(snapshot));
    const before = scene.children.flatMap((root) => {
      const values: number[][] = [];
      root.traverse((object) => {
        values.push([...object.position.toArray(), ...object.quaternion.toArray()]);
      });
      return values;
    });
    const fixed = await executeAction({ tool: 'repair_physics', args: { kind: 'footSlide', foot: 'L', time: slide!.t0 }, idempotencyKey: 'physics-slide-with-chain' });
    expect(fixed).toMatchObject({ ok: true, data: { kind: 'footSlide', foot: 'L', undoable: true } });
    expect((fixed.data as { rotationKeysWritten: number }).rotationKeysWritten).toBeGreaterThan(0);
    const afterCheck = await executeAction({ tool: 'check_physics', args: {}, idempotencyKey: 'physics-check-slide-fixed' });
    expect((afterCheck.data as { issues: Array<{ kind: string; foot?: string }> }).issues.filter((item) => item.kind === 'footSlide' && item.foot === 'L')).toHaveLength(0);
    const after = scene.children.flatMap((root) => {
      const values: number[][] = [];
      root.traverse((object) => {
        values.push([...object.position.toArray(), ...object.quaternion.toArray()]);
      });
      return values;
    });
    expect(after).toEqual(before);
  });

  it('AI 落地缓冲修复围绕诊断到的加速度突变写入平滑位置键并可撤销', async () => {
    const scene = new THREE.Group();
    bone(scene, 'Hips', 0, 1, 0);
    scene.updateWorldMatrix(true, true);
    useCharacterStore.getState().setCharacter(META, scene);
    useSkeletonStore.getState().setSnapshot(buildSkeletonTree(scene));
    const animationId = useAnimationStore.getState().createAnimation('落地缓冲');
    useAnimationStore.getState().selectAnimation(animationId);
    const original = [
      { boneName: 'Hips', time: 0, value: [0, 1, 0] as [number, number, number] },
      { boneName: 'Hips', time: 1, value: [0, 1, 0] as [number, number, number] },
      { boneName: 'Hips', time: 1.033, value: [0, 1.3, 0] as [number, number, number] },
      { boneName: 'Hips', time: 1.066, value: [0, 1, 0] as [number, number, number] },
      { boneName: 'Hips', time: 4, value: [0, 1, 0] as [number, number, number] },
    ];
    useAnimationStore.getState().bakePoseKeys([], original);
    const checked = (await executeAction({ tool: 'check_physics', args: {}, idempotencyKey: 'physics-check-impact' })).data as { issues: Array<{ kind: string; t0: number }> };
    const spike = checked.issues.find((item) => item.kind === 'accelSpike');
    expect(spike).toBeDefined();
    const fixed = await executeAction({ tool: 'repair_physics', args: { kind: 'accelSpike', time: spike!.t0 }, idempotencyKey: 'physics-fix-impact' });
    expect(fixed).toMatchObject({ ok: true, data: { kind: 'accelSpike', undoable: true } });
    expect((fixed.data as { positionKeysWritten: number }).positionKeysWritten).toBeGreaterThan(0);
    expect(useAnimationStore.getState().active()!.tracks.find((track) => track.boneName === 'Hips')!.position.length).toBeGreaterThan(original.length);
    const checkedAfter = await executeAction({ tool: 'check_physics', args: {}, idempotencyKey: 'physics-check-impact-fixed' });
    const remainingSpikes = (checkedAfter.data as { issues: Array<{ kind: string; value: number }> }).issues.filter((item) => item.kind === 'accelSpike');
    expect(Math.max(...remainingSpikes.map((item) => item.value))).toBeLessThan(Math.max(...checked.issues.filter((item) => item.kind === 'accelSpike').map((item) => item.value)));
    useAnimationStore.getState().undo();
    expect(useAnimationStore.getState().active()!.tracks.find((track) => track.boneName === 'Hips')!.position).toHaveLength(original.length);
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

  it('接受模型常见 walk 别名，并从分段终点推导未指定的动画时长', async () => {
    setupScene();
    const r = await executeAction({ tool: 'generate_motion', args: {
      prompt: '人物走到桌前，拿起手机，然后回头看门口',
      segments: [
        { t0: 0, t1: 2.5, template: 'walk', clause: '走到桌前' },
        { t0: 2.5, t1: 4, template: 'reach', clause: '拿起手机' },
        { t0: 4, t1: 6, template: 'turn', clause: '回头看门口' },
      ],
    }, idempotencyKey: 'llm-walk-alias-duration' });

    expect(r.ok).toBe(true);
    expect(useAnimationStore.getState().active()).toMatchObject({ duration: 6 });
    const animationId = useAnimationStore.getState().activeId!;
    expect(usePrevisStore.getState().byAnimationId[animationId].segments.map((segment) => segment.template)).toEqual(['march', 'reach', 'turn']);
  });

  it('LLM 漏掉组合描述中的明确阶段时补入规则阶段并说明回退', async () => {
    setupScene();
    const table: StageProp = { id: 'table-llm-completion', kind: 'table', position: [1, 0, 0], rotationY: 0, size: { width: 1.1, height: 0.75, length: 0.7 } };
    const phone: StageProp = { id: 'phone-llm-completion', kind: 'phone', position: [1, 0.76, 0], rotationY: 0, size: { width: 0.075, height: 0.018, length: 0.15 } };
    useWorldStore.getState().replaceProps([table, phone]);
    const result = await executeAction({ tool: 'generate_motion', args: {
      prompt: '人物走到桌前，拿起手机，回头看门口', duration: 4, _planner: 'llm', _plannerModel: 'qwen2.5:3b',
      segments: [
        { t0: 0, t1: 2, template: 'march', clause: '人物走到桌前' },
        { t0: 2, t1: 4, template: 'reach', clause: '人物拿起手机' },
      ],
    }, idempotencyKey: 'llm-restore-omitted-stage' });

    expect(result.ok).toBe(true);
    const previs = usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!]!;
    expect(previs.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'reach', 'look']);
    expect(previs.segments.at(-1)?.clause).toMatch(/回头看向门口/);
    expect(previs.warnings?.join(' ')).toMatch(/模型漏掉了明确动作阶段.*回头看向门口/);
    expect(previs.segments[2].targetPropId).toBe(phone.id);
  });

  it('动作 Provider 的轨道全部无法映射时拒绝创建假预演', async () => {
    setupScene();
    useMotionStore.getState().setProvider('http');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        animation: { id: 'foreign-rig', name: 'foreign motion', duration: 2, fps: 30, tracks: [
          { boneName: 'Armature|Unknown', position: [], rotation: [{ time: 0, value: [0, 0, 0, 1], interp: 'linear' }], scale: [] },
        ] },
        meta: { provider: 'motion-api', source: 'real' },
      }),
    }));

    const result = await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 2 }, idempotencyKey: 'foreign-rig-only' });

    expect(result.error?.code).toBe('SKELETON_MISMATCH');
    expect(result.error?.message).toMatch(/Armature\|Unknown/);
    expect(useAnimationStore.getState().animations).toHaveLength(0);
  });

  it('仅残留骨架快照而角色实例已卸载时拒绝生成', async () => {
    setupScene();
    useCharacterStore.getState().clear();

    const result = await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 2 }, idempotencyKey: 'orphan-skeleton-snapshot' });

    expect(result.error?.code).toBe('NO_CHARACTER');
    expect(result.error?.message).toMatch(/当前角色模型未载入/);
    expect(useAnimationStore.getState().animations).toHaveLength(0);
  });

  it('动作 Provider 部分骨架映射保留可用轨道并在方案中警告未绑定骨骼', async () => {
    setupScene();
    useMotionStore.getState().setProvider('http');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        animation: { id: 'partial-rig', name: 'partial motion', duration: 2, fps: 30, tracks: [
          { boneName: 'Hips', position: [], rotation: [{ time: 0, value: [0, 0, 0, 1], interp: 'linear' }], scale: [] },
          { boneName: 'Armature|Unknown', position: [], rotation: [{ time: 0, value: [0, 0, 0, 1], interp: 'linear' }], scale: [] },
        ] },
        meta: { provider: 'motion-api', source: 'real' },
      }),
    }));

    const result = await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 2 }, idempotencyKey: 'foreign-rig-partial' });

    expect(result.ok).toBe(true);
    expect((result.data as { unbound: string[] }).unbound).toEqual(['Armature|Unknown']);
    const animationId = useAnimationStore.getState().activeId!;
    expect(usePrevisStore.getState().byAnimationId[animationId].warnings.join()).toMatch(/未匹配当前角色/);
  });

  it('远程动作也会继承基于当前骨架估算的超臂展警告', async () => {
    setupScene();
    useMotionStore.getState().setProvider('http');
    const phone: StageProp = { id: 'high-phone', kind: 'phone', position: [0, 4, 0], rotationY: 0, size: { width: 0.075, height: 0.018, length: 0.15 } };
    useWorldStore.getState().replaceProps([phone]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        animation: { id: 'real-reach', name: 'real reach', duration: 4, fps: 30, tracks: [
          { boneName: 'Hips', position: [], rotation: [{ time: 0, value: [0, 0, 0, 1], interp: 'linear' }], scale: [] },
        ] },
        meta: { provider: 'motion-api', source: 'real' },
      }),
    }));

    const result = await executeAction({ tool: 'generate_motion', args: { prompt: '左手拿起手机', duration: 4 }, idempotencyKey: 'remote-overreach' });

    expect(result.ok).toBe(true);
    const animationId = useAnimationStore.getState().activeId!;
    const previs = usePrevisStore.getState().byAnimationId[animationId];
    expect(previs.segments.some((segment) => segment.template === 'reach' && /左手/.test(segment.clause))).toBe(true);
    expect(previs.warnings.join()).toMatch(/左肩.*超过估算臂展/);
  });

  it('Agent generate_motion 将左手挥手意图保留到生成的骨骼轨道', async () => {
    setupScene();
    const result = await executeAction({
      tool: 'generate_motion',
      args: { prompt: '左手挥手', duration: 2 },
      idempotencyKey: 'left-wave-agent-chain',
    });
    expect(result.ok).toBe(true);
    const animation = useAnimationStore.getState().active()!;
    const previs = usePrevisStore.getState().byAnimationId[animation.id];
    expect(previs.segments[0]).toMatchObject({ template: 'wave', clause: '左手挥手' });
    const armTrack = animation.tracks.find((track) => track.boneName === 'UpperArm_L');
    expect(armTrack?.rotation.length).toBeGreaterThan(0);
    expect(armTrack?.rotation.some((key) => Math.abs(key.value[2]) > 0.1)).toBe(true);
  });

  it.each(['左手挥手', '生成左手挥手动作'])('自然语言“%s”经 Agent 分流到动作生成并输出左臂轨道', async (prompt) => {
    setupScene();
    const planned = planMock(prompt);
    expect(planned.actions[0]?.tool).toBe('generate_motion');
    const results = await executeActions(planned.actions);
    expect(results.every((result) => result.ok)).toBe(true);
    const animation = useAnimationStore.getState().active()!;
    expect(animation.tracks.find((track) => track.boneName === 'UpperArm_L')?.rotation.some((key) => Math.abs(key.value[2]) > 0.1)).toBe(true);
  });

  it('LLM 分段不能在同类场景物体歧义时静默绑定某一个目标', async () => {
    setupScene();
    await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'phone', id: 'phone-a' }, idempotencyKey: 'ambiguous-phone-a' });
    const phoneBResult = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'phone', id: 'phone-b' }, idempotencyKey: 'ambiguous-phone-b' });
    expect(phoneBResult.ok).toBe(true);
    expect(useWorldStore.getState().props.filter((prop) => prop.kind === 'phone').map((prop) => prop.id)).toEqual(['phone-a', 'phone-b']);
    expect(ambiguousScenePropIds('拿起手机', useWorldStore.getState().props)).toEqual(['phone-a', 'phone-b']);
    const result = await executeAction({
      tool: 'generate_motion',
      args: {
        prompt: '拿起手机', duration: 4, _planner: 'llm',
        segments: [{ t0: 0, t1: 4, template: 'reach', clause: '拿起手机', targetPropId: 'phone-a' }],
      },
      idempotencyKey: 'ambiguous-phone-llm-plan',
    });
    expect(result.ok).toBe(true);
    const activeId = useAnimationStore.getState().activeId!;
    const previs = usePrevisStore.getState().byAnimationId[activeId];
    expect(previs.segments[0].targetPropId).toBeUndefined();
    expect(previs.scenePlan?.interpretation.questions.join()).toMatch(/目标不明确/);
    expect(previs.warnings?.join()).toMatch(/多个手机/);
  });

  it('Agent 本地模板规划不会把被否定的武打指令生成成正向动作', async () => {
    setupScene();
    const result = await executeAction({ tool: 'generate_motion', args: { prompt: '不要挥剑，也不要踢人', duration: 4 }, idempotencyKey: 'negated-motion' });
    expect(result.ok).toBe(true);
    const id = useAnimationStore.getState().activeId!;
    expect(usePrevisStore.getState().byAnimationId[id].segments.map((segment) => segment.template)).toEqual(['stand']);
  });

  it('预演拿起手机再放桌上时，根位移会依次到达两个物体的交互点', async () => {
    const character = setupScene();
    const table: StageProp = { id: 'table-seq', kind: 'table', position: [2, 0, 1], rotationY: 0, size: { width: 1.1, height: 0.75, length: 0.7 } };
    const phone: StageProp = { id: 'phone-seq', kind: 'phone', position: [-1, 0.75, 0], rotationY: 0, size: { width: 0.075, height: 0.018, length: 0.15 } };
    useWorldStore.getState().replaceProps([table, phone]);
    const phoneFrame = resolvePropInteractionFrame(phone, character, useSkeletonStore.getState().snapshot!, [table, phone])!;
    const tableFrame = resolvePropInteractionFrame(table, character, useSkeletonStore.getState().snapshot!, [table, phone])!;
    const result = await executeAction({ tool: 'generate_motion', args: { prompt: '拿起手机后把手机放到桌上', duration: 8 }, idempotencyKey: 'move-phone-to-table' });
    expect(result.ok).toBe(true);
    const id = useAnimationStore.getState().activeId!;
    const previs = usePrevisStore.getState().byAnimationId[id];
    expect(previs.segments.map((segment) => segment.targetPropId)).toEqual(['phone-seq', 'phone-seq', 'phone-seq', 'table-seq', 'table-seq', 'table-seq']);
    const hipsTrack = useAnimationStore.getState().active()?.tracks.find((track) => track.boneName === 'Hips');
    expect(hipsTrack).toBeDefined();
    if (!hipsTrack) throw new Error('generated preview has no hips track');
    const firstApproachEnd = hipsTrack.position.find((key) => Math.abs(key.time - previs.segments[0].t1) < 1e-4);
    expect(firstApproachEnd).toBeDefined();
    if (!firstApproachEnd) throw new Error('first interaction frame is missing');
    expect(firstApproachEnd.value).toEqual(phoneFrame.interactionPosition);
    expect(hipsTrack.position.at(-1)?.value).toEqual(tableFrame.interactionPosition);
  });

  it('AI 只改一段的交互目标时，其他动作段保持不变并重新绑定轨道', async () => {
    const character = setupScene();
    const table: StageProp = { id: 'table-edit', kind: 'table', position: [2, 0, 1], rotationY: 0, size: { width: 1.1, height: 0.75, length: 0.7 } };
    const phone: StageProp = { id: 'phone-edit', kind: 'phone', position: [-1, 0.75, 0], rotationY: 0, size: { width: 0.075, height: 0.018, length: 0.15 } };
    useWorldStore.getState().replaceProps([table, phone]);
    await executeAction({ tool: 'generate_motion', args: { prompt: '拿起手机', duration: 4 }, idempotencyKey: 'target-edit-gen' });
    const id = useAnimationStore.getState().activeId!;
    const before = structuredClone(usePrevisStore.getState().byAnimationId[id].segments);
    expect(before[0].targetPropId).toBe('phone-edit');
    const result = await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, clause: '走到桌边', template: 'march', targetPropId: 'table-edit' }, idempotencyKey: 'target-edit-revise' });
    expect(result.ok).toBe(true);
    const after = usePrevisStore.getState().byAnimationId[id].segments;
    expect(after[0].targetPropId).toBe('table-edit');
    expect(after[0].t0).toBe(before[0].t0);
    expect(after[0].t1).toBe(before[0].t1);
    expect(after[1]).toEqual(before[1]);
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan?.contacts.some((contact) => contact.actionIndex === 0)).toBe(false);
    const tableFrame = resolvePropInteractionFrame(table, character, useSkeletonStore.getState().snapshot!, [table, phone])!;
    const phoneFrame = resolvePropInteractionFrame(phone, character, useSkeletonStore.getState().snapshot!, [table, phone])!;
    const hipsTrack = useAnimationStore.getState().active()?.tracks.find((track) => track.boneName === 'Hips');
    expect(hipsTrack?.position.find((key) => Math.abs(key.time - after[0].t1) < 1e-4)?.value).toEqual(tableFrame.interactionPosition);
    expect(hipsTrack?.position.at(-1)?.value).toEqual(phoneFrame.interactionPosition);
  });

  it('生成工具使用并校验 LLM 给出的分段，而不是重新用启发式覆盖', async () => {
    setupScene();
    const result = await executeAction({ tool: 'generate_motion', args: {
      prompt: '从门口快步走到桌边，拿起手机，再慢慢回头看门口', duration: 6,
      _planner: 'llm', _plannerModel: 'qwen3:8b',
      segments: [
        { t0: 0, t1: 2, template: 'march', clause: '从门口快步走到桌边', intensity: 1.1, speed: 1.3 },
        { t0: 2, t1: 4, template: 'reach', clause: '拿起桌上的手机', intensity: 0.8, speed: 0.8 },
        { t0: 4, t1: 6, template: 'look', clause: '慢慢回头看门口', intensity: 0.75, speed: 0.65 },
      ],
    }, idempotencyKey: 'llm-segmented-gen' });
    expect(result.ok).toBe(true);
    const plan = usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].scenePlan!;
    expect(plan.interpretation).toMatchObject({ source: 'model', model: 'qwen3:8b' });
    expect(plan.actions.map((segment) => segment.template)).toEqual(['march', 'reach', 'look']);
    expect(plan.actions.map((segment) => segment.clause)).toEqual(['从门口快步走到桌边', '拿起桌上的手机', '慢慢回头看门口']);
    expect(plan.actions[1].t0).toBe(2);
    expect(plan.actions[2].t1).toBe(6);
  });

  it('LLM 插入额外动作阶段时仍把场景目标和接触绑定到正确阶段', async () => {
    setupScene();
    const phone: StageProp = { id: 'llm-phone-target', kind: 'phone', position: [1, 0.8, 0], rotationY: 0, size: { width: 0.075, height: 0.018, length: 0.15 } };
    useWorldStore.getState().replaceProps([phone]);
    const result = await executeAction({
      tool: 'generate_motion',
      args: {
        prompt: '拿起手机', duration: 6, _planner: 'llm',
        segments: [
          { t0: 0, t1: 2, template: 'march', clause: '走到手机前' },
          { t0: 2, t1: 3, template: 'orient', clause: '调整站姿' },
          { t0: 3, t1: 6, template: 'reach', clause: '伸手拿起手机' },
        ],
      },
      idempotencyKey: 'llm-inserted-orient-target-alignment',
    });

    expect(result.ok).toBe(true);
    const plan = usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].scenePlan!;
    expect(plan.actions.map((action) => action.targetPropId)).toEqual([phone.id, phone.id, phone.id]);
    expect(plan.contacts).toContainEqual(expect.objectContaining({ actionIndex: 2, phase: 'reach', propId: phone.id }));
    expect(validateScenePlan(plan).filter((issue) => issue.path.startsWith('contacts.'))).toEqual([]);
    const frame = resolvePropInteractionFrame(phone, useCharacterStore.getState().sceneObject!, useSkeletonStore.getState().snapshot!, [phone])!;
    const hipsTrack = useAnimationStore.getState().active()?.tracks.find((track) => track.boneName === 'Hips');
    expect(hipsTrack?.position.find((key) => Math.abs(key.time - 2) < 1e-4)?.value).toEqual(frame.interactionPosition);
    expect(hipsTrack?.position.at(-1)?.value).toEqual(frame.interactionPosition);
  });

  it('将澄清选择应用到场景后重规划，同时保留原始描述', async () => {
    setupScene();
    const results = await executeActions([
      { tool: 'set_scene_prop', args: { operation: 'add', kind: 'bed', position: [1.2, 0, 0], size: { width: 1.3, height: 0.58, length: 2.1 } }, idempotencyKey: 'clarify-add-bed' },
      { tool: 'generate_motion', args: { prompt: '躺下睡觉', clarification: '在场景添加床并躺到床面', duration: 8 }, idempotencyKey: 'clarify-plan-bed' },
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const plan = usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].scenePlan!;
    expect(plan.prompt).toBe('躺下睡觉');
    expect(plan.environment.props.some((prop) => prop.kind === 'bed')).toBe(true);
    expect(plan.contacts.some((contact) => contact.surface === 'mattress')).toBe(true);
    expect(plan.actions.map((action) => action.template)).toEqual(['march', 'orient', 'sit', 'lie', 'sleep']);
  });

  it('Agent 会把模型分段交给所选 HTTP Motion Provider 并如实保留动作来源', async () => {
    setupScene();
    useMotionStore.getState().setProvider('http');
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        animation: { id: 'remote', name: 'server', duration: 2, fps: 30, tracks: [] },
        meta: { provider: 'backend-mock', source: 'mock', planner: 'external', segments: [] },
      }),
    });
    vi.stubGlobal('fetch', fetch);
    const result = await executeAction({ tool: 'generate_motion', args: {
      prompt: '挥手', duration: 2, _planner: 'llm', _plannerModel: 'qwen3:8b',
      segments: [{ t0: 0, t1: 2, template: 'wave', clause: '挥手招呼', intensity: 1, speed: 1 }],
    }, idempotencyKey: 'http-motion-provider' });
    expect(result.ok).toBe(true);
    const [, requestInit] = fetch.mock.calls[0] as [string, RequestInit];
    const request = JSON.parse(requestInit.body as string) as { plan?: Array<{ template: string; clause: string }> };
    expect(request.plan).toEqual([expect.objectContaining({ template: 'wave', clause: '挥手招呼' })]);
    expect((result.data as { motion: { source: string; provider: string } }).motion).toMatchObject({ source: 'mock', provider: 'backend-mock' });
    const active = useAnimationStore.getState().active()!;
    expect(usePrevisStore.getState().byAnimationId[active.id].segments[0].clause).toBe('挥手招呼');
  });

  it('HTTP 动作生成期间切换动画后，迟到响应不能抢回当前选中动画', async () => {
    setupScene();
    useMotionStore.getState().setProvider('http');
    let resolveResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => {
      markFetchStarted();
      return responsePromise;
    }));
    const pending = executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 2 }, idempotencyKey: 'stale-motion-response' });
    await fetchStarted;
    const manualAnimationId = useAnimationStore.getState().createAnimation('用户正在编辑的动画');
    resolveResponse({
      ok: true,
      json: () => Promise.resolve({ animation: { id: 'remote', name: 'server', duration: 2, fps: 30, tracks: [] }, meta: { source: 'mock' } }),
    } as Response);

    const result = await pending;

    expect(result.error?.code).toBe('STALE_CONTEXT');
    expect(useAnimationStore.getState().activeId).toBe(manualAnimationId);
    expect(useAnimationStore.getState().animations).toHaveLength(1);
  });

  it('HTTP 动作生成期间场景道具被修改后，拒绝套用旧场景的结果', async () => {
    setupScene();
    useMotionStore.getState().setProvider('http');
    let resolveResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => {
      markFetchStarted();
      return responsePromise;
    }));
    const pending = executeAction({ tool: 'generate_motion', args: { prompt: '走到桌前', duration: 2 }, idempotencyKey: 'stale-scene-response' });
    await fetchStarted;
    useWorldStore.getState().replaceProps([{ id: 'new-table', kind: 'table', position: [2, 0, 0], rotationY: 0, size: { width: 1, height: 0.75, length: 0.7 } }]);
    resolveResponse({
      ok: true,
      json: () => Promise.resolve({ animation: { id: 'remote', name: 'server', duration: 2, fps: 30, tracks: [] }, meta: { source: 'mock' } }),
    } as Response);

    const result = await pending;

    expect(result.error?.code).toBe('STALE_CONTEXT');
    expect(useAnimationStore.getState().animations).toHaveLength(0);
    expect(useWorldStore.getState().props[0].id).toBe('new-table');
  });

  it('HTTP 动作生成期间角色根节点被移动后，拒绝套用旧位置规划的结果', async () => {
    setupScene();
    useMotionStore.getState().setProvider('http');
    let resolveResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => {
      markFetchStarted();
      return responsePromise;
    }));
    const pending = executeAction({ tool: 'generate_motion', args: { prompt: '走到桌前', duration: 2 }, idempotencyKey: 'stale-character-transform' });
    await fetchStarted;
    useCharacterStore.getState().sceneObject!.position.x += 0.5;
    resolveResponse({
      ok: true,
      json: () => Promise.resolve({ animation: { id: 'remote', name: 'server', duration: 2, fps: 30, tracks: [] }, meta: { source: 'mock' } }),
    } as Response);

    const result = await pending;

    expect(result.error?.code).toBe('STALE_CONTEXT');
    expect(useAnimationStore.getState().animations).toHaveLength(0);
    expect(useCharacterStore.getState().sceneObject!.position.x).toBe(0.5);
  });

  it('HTTP 动作生成期间用户暂停并拖动时间轴后，拒绝套用旧时间点的结果', async () => {
    setupScene();
    useAnimationStore.getState().createAnimation('当前动画');
    useMotionStore.getState().setProvider('http');
    let resolveResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => {
      markFetchStarted();
      return responsePromise;
    }));
    const pending = executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 2 }, idempotencyKey: 'stale-paused-cursor' });
    await fetchStarted;
    useAnimationStore.getState().setTime(1.25);
    resolveResponse({
      ok: true,
      json: () => Promise.resolve({ animation: { id: 'remote', name: 'server', duration: 2, fps: 30, tracks: [] }, meta: { source: 'mock' } }),
    } as Response);

    const result = await pending;

    expect(result.error?.code).toBe('STALE_CONTEXT');
    expect(useAnimationStore.getState().active()?.name).toBe('当前动画');
    expect(useAnimationStore.getState().currentTime).toBe(1.25);
  });

  it('HTTP 动作生成期间当前角色骨架快照改变后，拒绝套用旧骨架结果', async () => {
    setupScene();
    useMotionStore.getState().setProvider('http');
    let resolveResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => {
      markFetchStarted();
      return responsePromise;
    }));
    const pending = executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 2 }, idempotencyKey: 'stale-skeleton-response' });
    await fetchStarted;
    const snapshot = useSkeletonStore.getState().snapshot!;
    const [nodeId, node] = Object.entries(snapshot.nodes)[0];
    useSkeletonStore.getState().setSnapshot({
      ...snapshot,
      nodes: {
        ...snapshot.nodes,
        [nodeId]: {
          ...node,
          restLocal: {
            ...node.restLocal,
            position: [node.restLocal.position[0] + 0.1, node.restLocal.position[1], node.restLocal.position[2]],
          },
        },
      },
    });
    resolveResponse({
      ok: true,
      json: () => Promise.resolve({ animation: { id: 'remote', name: 'server', duration: 2, fps: 30, tracks: [] }, meta: { source: 'mock' } }),
    } as Response);

    const result = await pending;

    expect(result.error?.code).toBe('STALE_CONTEXT');
    expect(useAnimationStore.getState().animations).toHaveLength(0);
  });

  it('HTTP 动作生成期间 Provider 配置改变后，拒绝应用旧服务响应', async () => {
    setupScene();
    useMotionStore.getState().setProvider('http');
    let resolveResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => {
      markFetchStarted();
      return responsePromise;
    }));
    const pending = executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 2 }, idempotencyKey: 'stale-provider-response' });
    await fetchStarted;
    useMotionStore.getState().setBaseUrl('http://127.0.0.1:9999');
    resolveResponse({
      ok: true,
      json: () => Promise.resolve({ animation: { id: 'remote', name: 'server', duration: 2, fps: 30, tracks: [] }, meta: { source: 'mock' } }),
    } as Response);

    const result = await pending;

    expect(result.error?.code).toBe('STALE_CONTEXT');
    expect(useAnimationStore.getState().animations).toHaveLength(0);
  });

  it('HTTP 动作生成期间锁定现有动作方案后，迟到结果不会绕过用户锁', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 2 }, idempotencyKey: 'seed-plan-for-stale-lock' });
    useMotionStore.getState().setProvider('http');
    let resolveResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => {
      markFetchStarted();
      return responsePromise;
    }));
    const pending = executeAction({ tool: 'generate_motion', args: { prompt: '鞠躬', duration: 2 }, idempotencyKey: 'stale-locked-plan-response' });
    await fetchStarted;
    const activeId = useAnimationStore.getState().activeId!;
    usePrevisStore.getState().togglePlanLock(activeId, 'actions');
    resolveResponse({
      ok: true,
      json: () => Promise.resolve({ animation: { id: 'remote', name: 'server', duration: 2, fps: 30, tracks: [] }, meta: { source: 'mock' } }),
    } as Response);

    const result = await pending;

    expect(result.error?.code).toBe('STALE_CONTEXT');
    expect(useAnimationStore.getState().activeId).toBe(activeId);
    expect(useAnimationStore.getState().animations).toHaveLength(1);
    expect(usePrevisStore.getState().byAnimationId[activeId].scenePlan?.lockedFields).toContain('actions');
  });

  it('保留模型指出的缺失场景信息与澄清问题，并压低不可靠预演的置信度', async () => {
    setupScene();
    const result = await executeAction({ tool: 'generate_motion', args: {
      prompt: '躺下睡觉', duration: 8, _planner: 'llm', _plannerModel: 'qwen3:8b',
      segments: [{ t0: 0, t1: 8, template: 'lie', clause: '仰卧并闭眼休息' }],
      interpretation: { certainty: 'high', missingInfo: ['床的位置'], questions: ['要添加床吗？'], reasons: ['当前场景没有床'] },
    }, idempotencyKey: 'llm-interpretation' });
    expect(result.ok).toBe(true);
    const plan = usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].scenePlan!;
    expect(plan.interpretation.certainty).toBe('low');
    expect(plan.interpretation.missingInfo).toContain('床的位置');
    expect(plan.interpretation.questions).toContain('要添加床吗？');
    expect(plan.interpretation.fieldEvidence?.actions.source).toBe('model');
    expect(plan.interpretation.fieldEvidence?.environment.source).toBe('editor');
  });

  it('拒绝无效的 AI 动作计划而不悄悄回退成其他动作', async () => {
    setupScene();
    const result = await executeAction({ tool: 'generate_motion', args: { prompt: '做一个复杂动作', duration: 4, segments: [{ t0: 0, t1: 3, template: 'fly', clause: '飞走' }] }, idempotencyKey: 'bad-segment' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('BAD_ARGS');
    expect(useAnimationStore.getState().animations).toHaveLength(0);
  });

  it('动作段参数无效时指出具体字段，不返回笼统 BAD_ARGS', async () => {
    setupScene();
    const result = await executeAction({ tool: 'generate_motion', args: {
      prompt: '左手抬高，然后头向右转', duration: 4,
      segments: [
        { t0: 0, t1: 2, template: 'raise_left', clause: '左手抬高', intensity: 1, speed: 1 },
        { t0: 2, t1: 4, template: 'look_right', clause: '头向右转', intensity: 1, speed: 2.4 },
      ],
    }, idempotencyKey: 'specific-segment-validation' });

    expect(result.error?.message).toBe('动作段 2 的速度须为 0.5–2');
  });

  it('把模型常见的右转头模板别名规范为可执行模板', async () => {
    const scene = setupScene();
    const spine = scene.getObjectByName('Spine')!;
    bone(spine, 'Head', 0, 0.2, 0);
    scene.updateWorldMatrix(true, true);
    useSkeletonStore.getState().setSnapshot(buildSkeletonTree(scene));
    const result = await executeAction({ tool: 'generate_motion', args: {
      prompt: '左手抬高，然后头向右转', duration: 4, _planner: 'llm',
      segments: [
        { t0: 0, t1: 2, template: 'raise_left', clause: '左手抬高' },
        { t0: 2, t1: 4, template: 'turn_right_head', clause: '头向右转' },
      ],
    }, idempotencyKey: 'llm-head-turn-alias' });

    expect(result.ok).toBe(true);
    const activeId = useAnimationStore.getState().activeId!;
    expect(usePrevisStore.getState().byAnimationId[activeId]?.segments[1]?.template).toBe('look_right');
    expect(useAnimationStore.getState().active()?.tracks.map((track) => track.boneName)).toContain('UpperArm_L');
    expect(useAnimationStore.getState().active()?.tracks.map((track) => track.boneName)).toContain('Head');
  });

  it('保留模型误输出为字符串的澄清字段', async () => {
    setupScene();
    const result = await executeAction({ tool: 'generate_motion', args: {
      prompt: '左手抬高', duration: 4, _planner: 'llm',
      segments: [{ t0: 0, t1: 4, template: 'raise_left', clause: '左手抬高' }],
      interpretation: { certainty: 'medium', reasons: '动作方向明确', missingInfo: '未指定速度', questions: '需要调整幅度吗？' },
    }, idempotencyKey: 'llm-string-interpretation' });

    expect(result.ok).toBe(true);
    const activeId = useAnimationStore.getState().activeId!;
    const interpretation = usePrevisStore.getState().byAnimationId[activeId]?.scenePlan?.interpretation;
    expect(interpretation?.reasons).toContain('动作方向明确');
    expect(interpretation?.missingInfo).toContain('未指定速度');
    expect(interpretation?.questions).toContain('需要调整幅度吗？');
  });

  it('AI 单独重做指定动作段，保留其他动作段的内容与时间', async () => {
    setupScene();
    const generated = await executeAction({ tool: 'generate_motion', args: { prompt: '挥手，然后鞠躬，再回头看', duration: 6 }, idempotencyKey: 'gmulti' });
    expect(generated.ok).toBe(true);
    const before = structuredClone(usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].segments);
    expect(before.length).toBeGreaterThan(1);
    const result = await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 1, clause: '双手自然下垂并鞠躬', template: 'bow', intensity: 0.8, speed: 0.9 }, idempotencyKey: 'revise1' });
    expect(result.ok).toBe(true);
    const after = usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].segments;
    expect(after[1]).toMatchObject({ clause: '双手自然下垂并鞠躬', template: 'bow', intensity: 0.8, speed: 0.9 });
    expect(after[1].t0).toBe(before[1].t0);
    expect(after[1].t1).toBe(before[1].t1);
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
  });

  it('AI 单独修改动作段时保留其他段、镜头路径和未关联事件', async () => {
    setupScene();
    const generated = await executeAction({ tool: 'generate_motion', args: { prompt: '挥手，然后鞠躬', duration: 6 }, idempotencyKey: 'revise-preserve-context-gen' });
    expect(generated.ok).toBe(true);
    const animationId = useAnimationStore.getState().activeId!;
    const before = structuredClone(usePrevisStore.getState().byAnimationId[animationId]);
    const laterAction = before.segments[1];
    const camera = await executeAction({
      tool: 'set_camera_keyframe',
      args: { operation: 'upsert', time: 5, position: [3, 2, 4], target: [0, 1, 0], fov: 42 },
      idempotencyKey: 'revise-preserve-context-camera',
    });
    expect(camera.ok).toBe(true);
    const event = await executeAction({
      tool: 'set_previs_event',
      args: { operation: 'add', actionIndex: 1, time: (laterAction.t0 + laterAction.t1) / 2, label: '鞠躬最低点' },
      idempotencyKey: 'revise-preserve-context-event',
    });
    expect(event.ok).toBe(true);
    const beforeCamera = structuredClone(useCameraStore.getState().keyframes);
    const beforeEvents = structuredClone(usePrevisStore.getState().byAnimationId[animationId].scenePlan!.events);

    const revised = await executeAction({
      tool: 'revise_action_segment',
      args: { segmentIndex: 0, intensity: 1.2 },
      idempotencyKey: 'revise-preserve-context-action',
    });

    expect(revised.ok).toBe(true);
    const after = usePrevisStore.getState().byAnimationId[animationId];
    expect(after.segments[0].intensity).toBe(1.2);
    expect(after.segments[1]).toEqual(before.segments[1]);
    expect(useCameraStore.getState().keyframes).toEqual(beforeCamera);
    expect(after.scenePlan?.camera.keyframes).toEqual(beforeCamera);
    expect(after.scenePlan?.events).toEqual(beforeEvents);
  });

  it('AI 只改指定动作段幅度时保留其余字段与其他动作段', async () => {
    setupScene();
    const generated = await executeAction({ tool: 'generate_motion', args: { prompt: '挥手，然后鞠躬', duration: 6 }, idempotencyKey: 'gintensity' });
    expect(generated.ok).toBe(true);
    const animationId = useAnimationStore.getState().activeId!;
    const before = structuredClone(usePrevisStore.getState().byAnimationId[animationId].segments);
    const result = await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, intensity: 1.4 }, idempotencyKey: 'revise-intensity-only' });
    expect(result.ok).toBe(true);
    const after = usePrevisStore.getState().byAnimationId[animationId].segments;
    expect(after[0]).toMatchObject({ ...before[0], intensity: 1.4 });
    expect(after[1]).toEqual(before[1]);
  });

  it('AI 单段修复作为单个撤销操作同步恢复动画轨道与预演分段', async () => {
    setupScene();
    const generated = await executeAction({ tool: 'generate_motion', args: { prompt: '挥手，然后鞠躬', duration: 6 }, idempotencyKey: 'revise-undo-gen' });
    expect(generated.ok).toBe(true);
    const animationId = useAnimationStore.getState().activeId!;
    const beforeAnimation = structuredClone(useAnimationStore.getState().active()!);
    const beforePlan = structuredClone(usePrevisStore.getState().byAnimationId[animationId]!);
    const historyCount = useHistoryStore.getState().past.length;

    const revised = await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, intensity: 0.8 }, idempotencyKey: 'revise-undo-action' });
    expect(revised.ok).toBe(true);
    expect(useHistoryStore.getState().past.length).toBe(historyCount + 1);
    expect(usePrevisStore.getState().byAnimationId[animationId]?.segments[0].intensity).toBe(0.8);
    const afterTracks = structuredClone(useAnimationStore.getState().active()!.tracks);

    useAnimationStore.getState().undo();
    expect(useAnimationStore.getState().active()?.tracks).toEqual(beforeAnimation.tracks);
    expect(usePrevisStore.getState().byAnimationId[animationId]?.segments).toEqual(beforePlan.segments);

    useAnimationStore.getState().redo();
    expect(useAnimationStore.getState().active()?.tracks).toEqual(afterTracks);
    expect(usePrevisStore.getState().byAnimationId[animationId]?.segments[0].intensity).toBe(0.8);
  });

  it('AI 重建单段动作后重新运行人物与场景物体碰撞检查', async () => {
    setupScene();
    const generated = await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 4 }, idempotencyKey: 'collision-revise-base' });
    expect(generated.ok).toBe(true);
    const animationId = useAnimationStore.getState().activeId!;
    const latest = usePrevisStore.getState().byAnimationId[animationId]!;
    usePrevisStore.setState((state) => ({
      byAnimationId: {
        ...state.byAnimationId,
        [animationId]: { ...latest, warnings: [...(latest.warnings ?? []), '动作约 1.2 秒：hand扫掠碰撞检查达到采样上限；无法排除穿过薄物体'] },
      },
    }));
    useWorldStore.getState().replaceProps([{
      id: 'revision-obstacle', kind: 'table', position: [0.2, 0.5, 0], rotationY: 0,
      size: { width: 0.8, height: 0.8, length: 0.8 },
    }]);

    const revised = await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, intensity: 1.1 }, idempotencyKey: 'collision-revise-check' });

    expect(revised.ok).toBe(true);
    expect(usePrevisStore.getState().byAnimationId[animationId]?.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/动作约 .*可能与道具 revision-obstacle 相交/),
    ]));
    expect(usePrevisStore.getState().byAnimationId[animationId]?.warnings).not.toContain('动作约 1.2 秒：hand扫掠碰撞检查达到采样上限；无法排除穿过薄物体');
    expect((revised.data as { warnings: string[] }).warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/revision-obstacle/),
    ]));
  });

  it('AI 拒绝超出范围的动作幅度，不静默钳制成另一个值', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 4 }, idempotencyKey: 'gintensity-invalid' });
    const result = await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, intensity: 2 }, idempotencyKey: 'revise-intensity-invalid' });
    expect(result.error?.code).toBe('BAD_ARGS');
  });

  it('AI 可以增加并调整场景道具，统一预演方案跟随更新', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '走到桌前', duration: 3 }, idempotencyKey: 'scene-gen' });
    const add = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'table', position: [2, 0, 1], size: { width: 1.4, height: 0.8, length: 0.9 } }, idempotencyKey: 'prop-add' });
    expect(add.ok).toBe(true);
    const prop = (add.data as { prop: { id: string; position: number[]; size: { width: number } } }).prop;
    expect(prop.position).toEqual([2, 0, 1]);
    expect(prop.size.width).toBe(1.4);
    expect(usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].scenePlan?.environment.props).toHaveLength(1);
    const move = await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: prop.id, position: [3, 0, 1] }, idempotencyKey: 'prop-move' });
    expect(move.ok).toBe(true);
    expect(usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].scenePlan?.environment.props[0].position).toEqual([3, 0, 1]);
    useAnimationStore.getState().undo();
    expect(useWorldStore.getState().props[0].position).toEqual([2, 0, 1]);
    expect(usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].scenePlan?.environment.props[0].position).toEqual([2, 0, 1]);
    useAnimationStore.getState().redo();
    expect(useWorldStore.getState().props[0].position).toEqual([3, 0, 1]);
  });

  it('AI 拒绝不合理的门厚并说明范围，不静默改成另一种尺寸', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '走到门口', duration: 3 }, idempotencyKey: 'door-size-plan' });

    const result = await executeAction({
      tool: 'set_scene_prop',
      args: { operation: 'add', kind: 'door', position: [1, 0, 0], size: { width: 0.9, height: 2.05, length: 0.5 } },
      idempotencyKey: 'door-size-invalid',
    });

    expect(result.error).toMatchObject({ code: 'BAD_ARGS', message: expect.stringMatching(/door 的 length 必须在 0.02–0.3 米之间/) });
    expect(useWorldStore.getState().props).toEqual([]);
  });

  it('AI 拒绝把家具摆进已有家具的实体体积', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '走到桌前', duration: 3 }, idempotencyKey: 'prop-overlap-plan' });
    const first = await executeAction({
      tool: 'set_scene_prop', args: { operation: 'add', kind: 'table', position: [2, 0, 1] }, idempotencyKey: 'prop-overlap-table',
    });
    expect(first.ok).toBe(true);

    const second = await executeAction({
      tool: 'set_scene_prop', args: { operation: 'add', kind: 'chair', position: [2, 0, 1] }, idempotencyKey: 'prop-overlap-chair',
    });

    expect(second.error).toMatchObject({ code: 'BAD_ARGS', message: expect.stringMatching(/实体占位相交.*场景未修改/) });
    expect(useWorldStore.getState().props.map((prop) => prop.kind)).toEqual(['table']);
  });

  it('AI 拒绝把家具放在房间实体边界之外且不修改场景', async () => {
    setupScene();
    const room = await executeAction({
      tool: 'set_scene_prop', args: { operation: 'add', kind: 'room', id: 'room-bounds' }, idempotencyKey: 'room-bounds-add',
    });
    expect(room.ok).toBe(true);
    expect(useWorldStore.getState().props[0].position).toEqual([0, 0, 0]);
    const outside = await executeAction({
      tool: 'set_scene_prop', args: { operation: 'add', kind: 'table', id: 'outside-table', position: [3, 0, 0] }, idempotencyKey: 'room-bounds-reject',
    });

    expect(outside.error).toMatchObject({ code: 'BAD_ARGS', message: expect.stringMatching(/超出房间宽度.*场景未修改/) });
    expect(useWorldStore.getState().props.map((prop) => prop.id)).toEqual(['room-bounds']);
  });

  it('AI 常用场景道具默认布局可共存并正确支撑手机', async () => {
    setupScene();
    const props = [
      { kind: 'room', id: 'starter-room' }, { kind: 'bed', id: 'starter-bed' },
      { kind: 'table', id: 'starter-table' }, { kind: 'chair', id: 'starter-chair' },
      { kind: 'door', id: 'starter-door' }, { kind: 'phone', id: 'starter-phone' },
      { kind: 'opponent', id: 'starter-opponent' },
    ];
    for (const [index, prop] of props.entries()) {
      const result = await executeAction({
        tool: 'set_scene_prop', args: { operation: 'add', ...prop }, idempotencyKey: `starter-prop-${index}`,
      });
      expect(result.ok, `${prop.kind} should be placeable in the default layout`).toBe(true);
    }
    const sceneProps = useWorldStore.getState().props;
    expect(findStagePropOverlaps(sceneProps)).toEqual([]);
    expect(findStagePropRoomOverflows(sceneProps)).toEqual([]);
    expect(sceneProps.find((prop) => prop.kind === 'phone')?.position[1]).toBe(sceneProps.find((prop) => prop.kind === 'table')?.size.height);
  });

  it('AI 不指定位置时可添加多个不重叠的对手目标', async () => {
    setupScene();
    const first = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'opponent' }, idempotencyKey: 'auto-opponent-one' });
    const second = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'opponent' }, idempotencyKey: 'auto-opponent-two' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const opponents = useWorldStore.getState().props.filter((prop) => prop.kind === 'opponent');
    expect(opponents).toHaveLength(2);
    expect(opponents[0].id).not.toBe(opponents[1].id);
    expect(opponents[0].position).not.toEqual(opponents[1].position);
    expect(findStagePropOverlaps(opponents)).toEqual([]);
  });

  it('武打组合生成可播放的挥剑、格挡、出拳分段并绑定场景武器', async () => {
    setupScene();
    const weapon = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword', attachTo: 'hand.R' }, idempotencyKey: 'fight-add-sword' });
    const propId = (weapon.data as { prop: { id: string } }).prop.id;
    const generated = await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑后格挡再出拳', duration: 6 }, idempotencyKey: 'fight-generate' });
    expect(generated.ok).toBe(true);
    const id = useAnimationStore.getState().activeId!;
    const previs = usePrevisStore.getState().byAnimationId[id];
    expect(previs.segments.map((segment) => segment.template)).toEqual(['orient', 'sword', 'block', 'punch']);
    expect(previs.segments[1].targetPropId).toBe(propId);
    expect(useAnimationStore.getState().active()?.tracks.length).toBeGreaterThan(0);
    expect(previs.warnings?.join()).toMatch(/没有对手目标与碰撞判定/);
  });

  it('AI 可新增对手占位体并把武打阶段绑定到该目标', async () => {
    setupScene();
    const sword = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword' }, idempotencyKey: 'opponent-flow-sword' });
    const opponent = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'opponent' }, idempotencyKey: 'opponent-flow-target' });
    expect(sword.ok).toBe(true);
    expect(opponent.ok).toBe(true);
    const opponentId = (opponent.data as { prop: { id: string } }).prop.id;

    const generated = await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑攻击对手后格挡', duration: 5 }, idempotencyKey: 'opponent-flow-motion' });
    expect(generated.ok).toBe(true);
    const activeId = useAnimationStore.getState().activeId!;
    const entry = usePrevisStore.getState().byAnimationId[activeId];
    expect(entry.segments.map((segment) => segment.template)).toEqual(['march', 'orient', 'sword', 'block']);
    expect(entry.segments.slice(0, 3).every((segment) => segment.targetPropId === opponentId)).toBe(true);
    expect(entry.warnings?.join()).toMatch(/静态占位体/);
    expect(entry.scenePlan?.environment.props.map((prop) => prop.kind)).toContain('opponent');

    const animationBefore = useAnimationStore.getState().active()!;
    const hipsBefore = animationBefore.tracks.find((track) => track.boneName === 'Hips')!.position;
    const shoulderBefore = animationBefore.tracks.find((track) => track.boneName === 'Spine')!.rotation;
    usePrevisStore.getState().togglePlanLock(activeId, 'actions');
    const lockedMove = await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: opponentId, position: [0, 0, 2.6] }, idempotencyKey: 'opponent-flow-locked-move' });
    expect(lockedMove.error?.code).toBe('FIELD_LOCKED');
    expect(useWorldStore.getState().props.find((prop) => prop.id === opponentId)?.position).toEqual([0, 0, 1.6]);
    usePrevisStore.getState().togglePlanLock(activeId, 'actions');
    const moved = await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: opponentId, position: [0, 0, 2.6] }, idempotencyKey: 'opponent-flow-move' });
    expect(moved.ok).toBe(true);
    expect((moved.data as { replanned?: boolean }).replanned).toBe(true);
    const animationAfter = useAnimationStore.getState().active()!;
    expect(animationAfter.tracks.find((track) => track.boneName === 'Hips')!.position).not.toEqual(hipsBefore);
    expect(animationAfter.tracks.find((track) => track.boneName === 'Spine')!.rotation).toEqual(shoulderBefore);
    expect(usePrevisStore.getState().byAnimationId[activeId].warnings?.join()).toMatch(/已重算绑定该道具的髋部走位轨道/);

    useAnimationStore.getState().undo();
    expect(useWorldStore.getState().props.find((prop) => prop.id === opponentId)?.position).toEqual([0, 0, 1.6]);
    expect(useAnimationStore.getState().active()?.tracks.find((track) => track.boneName === 'Hips')?.position).toEqual(hipsBefore);
  });

  it('动作字段锁定时拒绝删除绑定对手，解锁后清理失效引用并提示重规划', async () => {
    setupScene();
    const opponent = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'opponent' }, idempotencyKey: 'remove-bound-opponent-add' });
    const opponentId = (opponent.data as { prop: { id: string } }).prop.id;
    await executeAction({ tool: 'generate_motion', args: { prompt: '攻击对手', duration: 4, segments: [
      { t0: 0, t1: 2, template: 'march', clause: '走近对手', targetPropId: opponentId },
      { t0: 2, t1: 4, template: 'punch', clause: '攻击对手', targetPropId: opponentId },
    ] }, idempotencyKey: 'remove-bound-opponent-motion' });
    const animationId = useAnimationStore.getState().activeId!;
    usePrevisStore.getState().togglePlanLock(animationId, 'actions');

    const blocked = await executeAction({ tool: 'set_scene_prop', args: { operation: 'remove', id: opponentId }, idempotencyKey: 'remove-bound-opponent-locked' });
    expect(blocked.error?.code).toBe('FIELD_LOCKED');
    expect(useWorldStore.getState().props.some((prop) => prop.id === opponentId)).toBe(true);

    usePrevisStore.getState().togglePlanLock(animationId, 'actions');
    const removed = await executeAction({ tool: 'set_scene_prop', args: { operation: 'remove', id: opponentId }, idempotencyKey: 'remove-bound-opponent-unlocked' });
    expect(removed.ok).toBe(true);
    const entry = usePrevisStore.getState().byAnimationId[animationId];
    expect(entry.segments.every((segment) => segment.targetPropId !== opponentId)).toBe(true);
    expect(entry.scenePlan?.actions.every((segment) => segment.targetPropId !== opponentId)).toBe(true);
    expect(entry.warnings?.join()).toMatch(/既有动作轨道未自动重生成/);
  });

  it('字段锁定会拒绝 AI 对动作段和场景的改动', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 3 }, idempotencyKey: 'lock-gen' });
    const activeId = useAnimationStore.getState().activeId!;
    usePrevisStore.getState().togglePlanLock(activeId, 'actions');
    usePrevisStore.getState().togglePlanLock(activeId, 'environment');
    usePrevisStore.getState().togglePlanLock(activeId, 'target');
    usePrevisStore.getState().togglePlanLock(activeId, 'events');
    const actionResult = await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, clause: '鞠躬', template: 'bow' }, idempotencyKey: 'lock-action' });
    const propResult = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'bed' }, idempotencyKey: 'lock-prop' });
    const targetResult = await executeAction({ tool: 'set_previs_target', args: { distanceMeters: 2.5 }, idempotencyKey: 'lock-target' });
    const eventResult = await executeAction({ tool: 'set_previs_event', args: { operation: 'add', actionIndex: 0, label: '被锁定的事件' }, idempotencyKey: 'lock-event' });
    expect(actionResult.error?.code).toBe('FIELD_LOCKED');
    expect(propResult.error?.code).toBe('FIELD_LOCKED');
    expect(targetResult.error?.code).toBe('FIELD_LOCKED');
    expect(eventResult.error?.code).toBe('FIELD_LOCKED');
    expect(useWorldStore.getState().props).toEqual([]);
  });

  it('武器锁与场景锁分离，并阻止 AI 通过道具工具变更已锁武器', async () => {
    setupScene();
    const added = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword' }, idempotencyKey: 'weapon-lock-add' });
    const swordId = (added.data as { prop: { id: string } }).prop.id;
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑', duration: 3 }, idempotencyKey: 'weapon-lock-gen' });
    const activeId = useAnimationStore.getState().activeId!;
    usePrevisStore.getState().togglePlanLock(activeId, 'weapons');
    expect((await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: swordId, position: [2, 1, 0] }, idempotencyKey: 'weapon-lock-update' })).error?.code).toBe('FIELD_LOCKED');
    expect((await executeAction({ tool: 'set_scene_prop', args: { operation: 'remove', id: swordId }, idempotencyKey: 'weapon-lock-remove' })).error?.code).toBe('FIELD_LOCKED');
    expect((await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword' }, idempotencyKey: 'weapon-lock-add-after' })).error?.code).toBe('FIELD_LOCKED');
    expect(useWorldStore.getState().props.map((prop) => prop.id)).toEqual([swordId]);
  });

  it('场景锁定时仍可单独修改未锁定的武器', async () => {
    setupScene();
    const swordResult = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword' }, idempotencyKey: 'env-lock-sword-add' });
    const tableResult = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'table' }, idempotencyKey: 'env-lock-table-add' });
    const swordId = (swordResult.data as { prop: { id: string } }).prop.id;
    const tableId = (tableResult.data as { prop: { id: string } }).prop.id;
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑', duration: 3 }, idempotencyKey: 'env-lock-generate' });
    const activeId = useAnimationStore.getState().activeId!;
    usePrevisStore.getState().togglePlanLock(activeId, 'environment');

    const weaponEdit = await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: swordId, attachTo: 'hand.L' }, idempotencyKey: 'env-lock-weapon-edit' });
    const sceneEdit = await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: tableId, position: [3, 0, 0] }, idempotencyKey: 'env-lock-prop-edit' });
    expect(weaponEdit.ok).toBe(true);
    expect(useWorldStore.getState().props.find((prop) => prop.id === swordId)?.attachTo).toBe('hand.L');
    expect(sceneEdit.error?.code).toBe('FIELD_LOCKED');

    usePrevisStore.getState().togglePlanLock(activeId, 'weapons');
    expect((await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: swordId, attachTo: 'hand.R' }, idempotencyKey: 'env-lock-weapon-lock-edit' })).error?.code).toBe('FIELD_LOCKED');
  });

  it('接触锁和武器锁也约束动作段的目标道具修改', async () => {
    setupScene();
    const table = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'table' }, idempotencyKey: 'contact-lock-table' });
    const phone = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'phone' }, idempotencyKey: 'contact-lock-phone' });
    const tableId = (table.data as { prop: { id: string } }).prop.id;
    const phoneId = (phone.data as { prop: { id: string } }).prop.id;
    await executeAction({ tool: 'generate_motion', args: { prompt: '走到桌前，拿起手机', duration: 4 }, idempotencyKey: 'contact-lock-plan' });
    let activeId = useAnimationStore.getState().activeId!;
    expect(usePrevisStore.getState().byAnimationId[activeId].contacts).toContainEqual(expect.objectContaining({ phase: 'reach', propId: phoneId }));
    usePrevisStore.getState().togglePlanLock(activeId, 'contacts');
    expect(usePrevisStore.getState().byAnimationId[activeId].scenePlan?.lockedFields).toContain('contacts');
    const pickup = usePrevisStore.getState().byAnimationId[activeId].segments.findIndex((segment) => segment.targetPropId === phoneId && segment.template === 'reach');
    expect(usePrevisStore.getState().byAnimationId[activeId].segments[pickup].template).toBe('reach');
    expect(usePrevisStore.getState().byAnimationId[activeId].scenePlan?.contacts).toContainEqual(expect.objectContaining({ phase: 'reach', propId: phoneId }));
    expect((await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: pickup, clause: '改为触碰桌面', template: 'reach', targetPropId: tableId }, idempotencyKey: 'contact-lock-revise' })).error?.code).toBe('FIELD_LOCKED');
    expect((await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: pickup, clause: '改成挥手', template: 'wave', targetPropId: phoneId }, idempotencyKey: 'contact-lock-template' })).error?.code).toBe('FIELD_LOCKED');
    expect((await executeAction({ tool: 'set_previs_target', args: { propId: tableId }, idempotencyKey: 'contact-lock-target' })).error?.code).toBe('FIELD_LOCKED');

    const swordA = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword' }, idempotencyKey: 'weapon-action-lock-a' });
    const swordB = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword', id: 'sword-second' }, idempotencyKey: 'weapon-action-lock-b' });
    const swordAId = (swordA.data as { prop: { id: string } }).prop.id;
    const swordBId = (swordB.data as { prop: { id: string } }).prop.id;
    await executeAction({ tool: 'generate_motion', args: { prompt: `挥剑 ${swordAId}`, duration: 3 }, idempotencyKey: 'weapon-action-lock-plan' });
    activeId = useAnimationStore.getState().activeId!;
    usePrevisStore.getState().togglePlanLock(activeId, 'weapons');
    expect((await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, clause: '挥动另一把剑', template: 'sword', targetPropId: swordBId }, idempotencyKey: 'weapon-action-lock-revise' })).error?.code).toBe('FIELD_LOCKED');
    expect((await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, clause: '改为剑刺', template: 'sword', targetPropId: swordAId }, idempotencyKey: 'weapon-action-lock-clause' })).error?.code).toBe('FIELD_LOCKED');
    expect(usePrevisStore.getState().byAnimationId[activeId].segments[0].targetPropId).toBe(swordAId);
  });

  it('接触锁阻止修改没有道具目标的地面支撑动作', async () => {
    setupScene();
    const generated = await executeAction({
      tool: 'generate_motion',
      args: { prompt: '躺到地上睡觉', duration: 6 },
      idempotencyKey: 'ground-contact-lock-plan',
    });
    expect(generated.ok).toBe(true);
    const animationId = useAnimationStore.getState().activeId!;
    const entry = usePrevisStore.getState().byAnimationId[animationId];
    const lieIndex = entry.segments.findIndex((segment) => segment.template === 'lie');
    expect(lieIndex).toBeGreaterThanOrEqual(0);
    expect(entry.contacts).toContainEqual(expect.objectContaining({
      phase: 'lie', propId: 'ground', surface: 'ground', actionIndex: lieIndex,
    }));
    expect(entry.segments[lieIndex].targetPropId).toBeUndefined();
    usePrevisStore.getState().togglePlanLock(animationId, 'contacts');

    const result = await executeAction({
      tool: 'revise_action_segment',
      args: { segmentIndex: lieIndex, template: 'stand', clause: '站立' },
      idempotencyKey: 'ground-contact-lock-revise',
    });

    expect(result.error?.code).toBe('FIELD_LOCKED');
    expect(usePrevisStore.getState().byAnimationId[animationId].segments[lieIndex].template).toBe('lie');
  });

  it('修改交互动作类型后清理旧接触，避免方案仍声称发生了拿取', async () => {
    setupScene();
    const phone = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'phone', id: 'phone-contact-reconcile' }, idempotencyKey: 'contact-reconcile-phone' });
    const phoneId = (phone.data as { prop: { id: string } }).prop.id;
    await executeAction({ tool: 'generate_motion', args: { prompt: '拿起手机', duration: 4 }, idempotencyKey: 'contact-reconcile-plan' });
    const animationId = useAnimationStore.getState().activeId!;
    const before = usePrevisStore.getState().byAnimationId[animationId];
    const reachIndex = before.segments.findIndex((segment) => segment.template === 'reach' && segment.targetPropId === phoneId);
    expect(reachIndex).toBeGreaterThanOrEqual(0);
    expect(before.scenePlan?.contacts.some((contact) => contact.actionIndex === reachIndex)).toBe(true);

    const result = await executeAction({
      tool: 'revise_action_segment',
      args: { segmentIndex: reachIndex, template: 'wave', clause: '挥手' },
      idempotencyKey: 'contact-reconcile-revise',
    });

    expect(result.ok).toBe(true);
    expect((result.data as { warnings?: string[] }).warnings?.join()).toMatch(/清除 1 条不再匹配的接触关系/);
    const after = usePrevisStore.getState().byAnimationId[animationId];
    expect(after.scenePlan?.contacts.some((contact) => contact.actionIndex === reachIndex)).toBe(false);
    expect(after.contacts?.some((contact) => contact.phase === 'reach' && contact.propId === phoneId)).toBe(false);
  });

  it('事件锁定时拒绝通过动作改型间接删除关联事件', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 3 }, idempotencyKey: 'locked-event-indirect-gen' });
    const animationId = useAnimationStore.getState().activeId!;
    const before = usePrevisStore.getState().byAnimationId[animationId];
    const waveIndex = before.segments.findIndex((segment) => segment.template === 'wave');
    expect(waveIndex).toBeGreaterThanOrEqual(0);
    const event = await executeAction({
      tool: 'set_previs_event',
      args: { operation: 'add', actionIndex: waveIndex, label: '挥手最高点' },
      idempotencyKey: 'locked-event-indirect-add',
    });
    expect(event.ok).toBe(true);
    usePrevisStore.getState().togglePlanLock(animationId, 'events');

    const revised = await executeAction({
      tool: 'revise_action_segment',
      args: { segmentIndex: waveIndex, template: 'bow', clause: '鞠躬' },
      idempotencyKey: 'locked-event-indirect-revise',
    });

    expect(revised.error?.code).toBe('FIELD_LOCKED');
    expect(usePrevisStore.getState().byAnimationId[animationId].segments[waveIndex].template).toBe('wave');
    expect(usePrevisStore.getState().byAnimationId[animationId].scenePlan?.events.some((item) => item.label === '挥手最高点')).toBe(true);
    expect((await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: waveIndex, intensity: 1.2 }, idempotencyKey: 'locked-event-unrelated-intensity' })).ok).toBe(true);
  });

  it('特效锁定时拒绝通过动作改型间接删除关联特效', async () => {
    setupScene();
    const weapon = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword' }, idempotencyKey: 'locked-effect-indirect-sword' });
    const swordId = (weapon.data as { prop: { id: string } }).prop.id;
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑', duration: 4 }, idempotencyKey: 'locked-effect-indirect-gen' });
    const animationId = useAnimationStore.getState().activeId!;
    const before = usePrevisStore.getState().byAnimationId[animationId];
    const swordIndex = before.segments.findIndex((segment) => segment.template === 'sword');
    expect(swordIndex).toBeGreaterThanOrEqual(0);
    const action = before.segments[swordIndex];
    const added = await executeAction({
      tool: 'set_previs_effect',
      args: { operation: 'add', kind: 'slash', actionIndex: swordIndex, time: (action.t0 + action.t1) / 2, position: [0, 1, 0] },
      idempotencyKey: 'locked-effect-indirect-add',
    });
    expect(added.ok).toBe(true);
    const effectId = (added.data as { event: { id: string } }).event.id;
    usePrevisStore.getState().togglePlanLock(animationId, 'effects');

    const revised = await executeAction({
      tool: 'revise_action_segment',
      args: { segmentIndex: swordIndex, template: 'wave', clause: '挥手', targetPropId: null },
      idempotencyKey: 'locked-effect-indirect-revise',
    });

    expect(revised.error?.code).toBe('FIELD_LOCKED');
    expect(usePrevisStore.getState().byAnimationId[animationId].segments[swordIndex].template).toBe('sword');
    expect(useEffectsStore.getState().events.some((event) => event.id === effectId && event.animationId === animationId)).toBe(true);
    expect(useWorldStore.getState().props.some((prop) => prop.id === swordId)).toBe(true);
    expect((await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: swordIndex, intensity: 1.2 }, idempotencyKey: 'locked-effect-unrelated-intensity' })).ok).toBe(true);
  });

  it('特效随动作目标变化失效，且特效锁会阻止目标改绑', async () => {
    setupScene();
    const firstWeapon = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword', id: 'effect-target-a' }, idempotencyKey: 'effect-target-sword-a' });
    const secondWeapon = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword', id: 'effect-target-b' }, idempotencyKey: 'effect-target-sword-b' });
    const firstId = (firstWeapon.data as { prop: { id: string } }).prop.id;
    const secondId = (secondWeapon.data as { prop: { id: string } }).prop.id;
    await executeAction({ tool: 'generate_motion', args: { prompt: `挥剑 ${firstId}`, duration: 4 }, idempotencyKey: 'effect-target-gen' });
    const animationId = useAnimationStore.getState().activeId!;
    const before = usePrevisStore.getState().byAnimationId[animationId];
    const swordIndex = before.segments.findIndex((segment) => segment.template === 'sword');
    const action = before.segments[swordIndex];
    const effect = await executeAction({
      tool: 'set_previs_effect',
      args: { operation: 'add', kind: 'slash', actionIndex: swordIndex, time: (action.t0 + action.t1) / 2, position: [0, 1, 0] },
      idempotencyKey: 'effect-target-add',
    });
    const effectId = (effect.data as { event: { id: string } }).event.id;
    usePrevisStore.getState().togglePlanLock(animationId, 'effects');

    const refused = await executeAction({
      tool: 'revise_action_segment',
      args: { segmentIndex: swordIndex, template: 'sword', clause: '挥动另一把剑', targetPropId: secondId },
      idempotencyKey: 'effect-target-locked-revise',
    });
    expect(refused.error?.code).toBe('FIELD_LOCKED');
    expect(usePrevisStore.getState().byAnimationId[animationId].segments[swordIndex].targetPropId).toBe(firstId);
    expect(useEffectsStore.getState().events.some((event) => event.id === effectId)).toBe(true);

    usePrevisStore.getState().togglePlanLock(animationId, 'effects');
    const allowed = await executeAction({
      tool: 'revise_action_segment',
      args: { segmentIndex: swordIndex, template: 'sword', clause: '挥动另一把剑', targetPropId: secondId },
      idempotencyKey: 'effect-target-unlocked-revise',
    });
    expect(allowed.ok).toBe(true);
    expect(useEffectsStore.getState().events.filter((event) => event.id === effectId)).toEqual([]);
    expect((allowed.data as { warnings?: string[] }).warnings?.join()).toMatch(/已清除 \d+ 个不再匹配的特效/);
  });

  it('AI 可以把武器交给左手或解除挂接，修改同步到预演武器语义', async () => {
    setupScene();
    const added = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword' }, idempotencyKey: 'weapon-hand-add' });
    const swordId = (added.data as { prop: { id: string } }).prop.id;
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑', duration: 3 }, idempotencyKey: 'weapon-hand-gen' });
    const id = useAnimationStore.getState().activeId!;
    const left = await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: swordId, attachTo: 'hand.L' }, idempotencyKey: 'weapon-hand-left' });
    expect(left.ok).toBe(true);
    expect(useWorldStore.getState().props[0].attachTo).toBe('hand.L');
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan?.weapons[0].attachedTo).toBe('hand.L');
    const detached = await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: swordId, attachTo: null }, idempotencyKey: 'weapon-hand-detach' });
    expect(detached.ok).toBe(true);
    expect(useWorldStore.getState().props[0].attachTo).toBeNull();
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan?.weapons[0].attachedTo).toBeNull();
    const moved = await executeAction({ tool: 'set_scene_prop', args: { operation: 'update', id: swordId, position: [1, 1, 0] }, idempotencyKey: 'weapon-hand-move-detached' });
    expect(moved.ok).toBe(true);
    expect(useWorldStore.getState().props[0].attachTo).toBeNull();
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan?.weapons[0].attachedTo).toBeNull();
  });

  it('AI 可单独修改预演目标和距离，且校验目标引用与距离范围', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '走到桌前', duration: 3 }, idempotencyKey: 'target-plan-gen' });
    const propResult = await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'table' }, idempotencyKey: 'target-plan-table' });
    const propId = (propResult.data as { prop: { id: string } }).prop.id;
    const changed = await executeAction({ tool: 'set_previs_target', args: { propId, distanceMeters: 1.75 }, idempotencyKey: 'target-plan-set' });
    expect(changed.ok).toBe(true);
    const active = useAnimationStore.getState().active()!;
    const entry = usePrevisStore.getState().byAnimationId[active.id];
    expect(entry.scenePlan?.target).toEqual({ propId, distanceMeters: 1.75 });
    expect(entry.segments[0].targetPropId).toBe(propId);
    const frame = resolvePropInteractionFrame(useWorldStore.getState().props[0], useCharacterStore.getState().sceneObject!, useSkeletonStore.getState().snapshot!, useWorldStore.getState().props, 1.75)!;
    expect(active.tracks.find((track) => track.boneName === 'Hips')?.position.at(-1)?.value).toEqual(frame.interactionPosition);
    useAnimationStore.getState().undo();
    expect(usePrevisStore.getState().byAnimationId[active.id].scenePlan?.target).toEqual({});
    expect(usePrevisStore.getState().byAnimationId[active.id].segments[0].targetPropId).toBeUndefined();
    useAnimationStore.getState().redo();
    expect(usePrevisStore.getState().byAnimationId[active.id].scenePlan?.target).toEqual({ propId, distanceMeters: 1.75 });
    expect(usePrevisStore.getState().byAnimationId[active.id].segments[0].targetPropId).toBe(propId);
    const lockedTracks = structuredClone(useAnimationStore.getState().active()!.tracks);
    usePrevisStore.getState().togglePlanLock(active.id, 'actions');
    const lockedDistance = await executeAction({ tool: 'set_previs_target', args: { distanceMeters: 1.2 }, idempotencyKey: 'target-plan-locked-distance' });
    const lockedTargetClear = await executeAction({ tool: 'set_previs_target', args: { propId: null }, idempotencyKey: 'target-plan-locked-clear' });
    expect(lockedDistance.error?.code).toBe('FIELD_LOCKED');
    expect(lockedTargetClear.error?.code).toBe('FIELD_LOCKED');
    expect(usePrevisStore.getState().byAnimationId[active.id].scenePlan?.target).toEqual({ propId, distanceMeters: 1.75 });
    expect(useAnimationStore.getState().active()!.tracks).toEqual(lockedTracks);
    usePrevisStore.getState().togglePlanLock(active.id, 'actions');
    const revised = await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, clause: '走到指定停靠距离', template: 'march' }, idempotencyKey: 'target-plan-revise' });
    expect(revised.ok).toBe(true);
    expect(useAnimationStore.getState().active()?.tracks.find((track) => track.boneName === 'Hips')?.position.at(-1)?.value).toEqual(frame.interactionPosition);
    expect((await executeAction({ tool: 'set_previs_target', args: { propId: 'missing' }, idempotencyKey: 'target-plan-invalid-prop' })).error?.code).toBe('BAD_ARGS');
    expect((await executeAction({ tool: 'set_previs_target', args: { distanceMeters: 31 }, idempotencyKey: 'target-plan-invalid-distance' })).error?.code).toBe('BAD_ARGS');
    const cleared = await executeAction({ tool: 'set_previs_target', args: { propId: null }, idempotencyKey: 'target-plan-clear-prop' });
    expect(cleared.ok).toBe(true);
    expect(usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].scenePlan?.target).toEqual({});
    expect(usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].segments[0].targetPropId).toBeUndefined();
  });

  it('AI 可以按索引添加、修改、移除关联动作段的预演事件', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥手', duration: 4 }, idempotencyKey: 'event-plan-gen' });
    const id = useAnimationStore.getState().activeId!;
    const added = await executeAction({ tool: 'set_previs_event', args: { operation: 'add', actionIndex: 0, time: 2, label: '挥手到达最高点' }, idempotencyKey: 'event-add' });
    expect(added.ok).toBe(true);
    let events = usePrevisStore.getState().byAnimationId[id].scenePlan!.events;
    expect(events.find((event) => event.label === '挥手到达最高点')).toMatchObject({ actionIndex: 0, time: 2 });
    const eventIndex = events.findIndex((event) => event.label === '挥手到达最高点');
    const updated = await executeAction({ tool: 'set_previs_event', args: { operation: 'update', eventIndex, time: 3, label: '挥手结束' }, idempotencyKey: 'event-update' });
    expect(updated.ok).toBe(true);
    events = usePrevisStore.getState().byAnimationId[id].scenePlan!.events;
    expect(events.some((event) => event.time === 3 && event.label === '挥手结束')).toBe(true);
    await executeAction({ tool: 'revise_action_segment', args: { segmentIndex: 0, clause: '慢速挥手', template: 'wave', speed: 0.7 }, idempotencyKey: 'event-action-revise' });
    events = usePrevisStore.getState().byAnimationId[id].scenePlan!.events;
    expect(events.some((event) => event.time === 3 && event.label === '挥手结束')).toBe(true);
    expect((await executeAction({ tool: 'set_previs_event', args: { operation: 'update', eventIndex: 0, time: 4.1 }, idempotencyKey: 'event-outside-action' })).error?.code).toBe('BAD_ARGS');
    const removed = await executeAction({ tool: 'set_previs_event', args: { operation: 'remove', eventIndex: events.findIndex((event) => event.label === '挥手结束') }, idempotencyKey: 'event-remove' });
    expect(removed.ok).toBe(true);
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan!.events).toHaveLength(1);
    useAnimationStore.getState().undo();
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan!.events).toHaveLength(2);
    useAnimationStore.getState().redo();
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan!.events).toHaveLength(1);
  });

  it('AI 可以为当前预演建立镜头路径并增删特效事件', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑，然后格挡', duration: 4 }, idempotencyKey: 'cam-fx-gen' });
    const camera = await executeAction({ tool: 'set_camera_keyframe', args: { operation: 'upsert', time: 2, position: [3, 2, 4], target: [0, 1, 0], fov: 40 }, idempotencyKey: 'cam-add' });
    expect(camera.ok).toBe(true);
    useAnimationStore.getState().undo();
    expect(useCameraStore.getState().keyframes.some((key) => key.time === 2)).toBe(false);
    expect(usePrevisStore.getState().byAnimationId[useAnimationStore.getState().activeId!].scenePlan?.camera.keyframes.some((key) => key.time === 2)).toBe(false);
    useAnimationStore.getState().redo();
    expect(useCameraStore.getState().keyframes.some((key) => key.time === 2)).toBe(true);
    const effect = await executeAction({ tool: 'set_previs_effect', args: { operation: 'add', kind: 'impact', time: 2.5, position: [0, 1, 0], scale: 0.8 }, idempotencyKey: 'fx-add' });
    expect(effect.ok).toBe(true);
    const id = useAnimationStore.getState().activeId!;
    const plan = usePrevisStore.getState().byAnimationId[id].scenePlan!;
    expect(plan.camera.keyframes.some((key) => key.time === 2)).toBe(true);
    expect(plan.effects).toHaveLength(1);
    const effectId = (effect.data as { event: { id: string } }).event.id;
    expect((await executeAction({ tool: 'set_previs_effect', args: { operation: 'remove', id: effectId }, idempotencyKey: 'fx-remove' })).ok).toBe(true);
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan?.effects).toHaveLength(0);
    useAnimationStore.getState().undo();
    expect(useEffectsStore.getState().events).toHaveLength(1);
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan?.effects).toHaveLength(1);
    useAnimationStore.getState().redo();
    expect(useEffectsStore.getState().events).toHaveLength(0);
    expect((await executeAction({ tool: 'set_camera_keyframe', args: { operation: 'upsert', time: 8, position: [3, 2, 4], target: [0, 1, 0], fov: 40 }, idempotencyKey: 'cam-out-of-bounds' })).error?.code).toBe('BAD_ARGS');
  });

  it('镜头和特效分别锁定后拒绝 AI 更新对应数据', async () => {
    setupScene();
    await executeAction({ tool: 'set_scene_prop', args: { operation: 'add', kind: 'sword' }, idempotencyKey: 'locked-camera-effect-sword' });
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑并命中', duration: 4 }, idempotencyKey: 'locked-camera-effect-gen' });
    const animationId = useAnimationStore.getState().activeId!;
    const initialKeys = useCameraStore.getState().keyframes;
    const initialEffects = useEffectsStore.getState().events.filter((event) => event.animationId === animationId);
    expect(initialEffects.length).toBeGreaterThan(0);
    usePrevisStore.getState().togglePlanLock(animationId, 'camera');
    usePrevisStore.getState().togglePlanLock(animationId, 'effects');

    const camera = await executeAction({
      tool: 'set_camera_keyframe', args: { operation: 'upsert', time: 2, position: [4, 3, 2], target: [0, 1, 0], fov: 40 },
      idempotencyKey: 'locked-camera-edit',
    });
    const effect = await executeAction({
      tool: 'set_previs_effect', args: { operation: 'update', id: initialEffects[0].id, position: [2, 2, 2] },
      idempotencyKey: 'locked-effect-edit',
    });

    expect(camera.error?.code).toBe('FIELD_LOCKED');
    expect(effect.error?.code).toBe('FIELD_LOCKED');
    expect(useCameraStore.getState().keyframes).toEqual(initialKeys);
    expect(useEffectsStore.getState().events.filter((event) => event.animationId === animationId)).toEqual(initialEffects);
  });

  it('AI can add spark, smoke, and energy previs events and synchronize the scene plan', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑', duration: 4 }, idempotencyKey: 'effect-library-gen' });
    for (const kind of ['spark', 'smoke', 'energy']) {
      const result = await executeAction({ tool: 'set_previs_effect', args: { operation: 'add', kind, time: 2, position: [0, 1, 0] }, idempotencyKey: `effect-${kind}` });
      expect(result.ok).toBe(true);
    }
    const id = useAnimationStore.getState().activeId!;
    expect(useEffectsStore.getState().events.map((event) => event.kind)).toEqual(['spark', 'smoke', 'energy']);
    expect(usePrevisStore.getState().byAnimationId[id].scenePlan?.effects.map((event) => event.kind)).toEqual(['spark', 'smoke', 'energy']);
  });

  it('AI can edit a slash sweep path without changing its timing or neighboring effect events', async () => {
    setupScene();
    await executeAction({ tool: 'generate_motion', args: { prompt: '挥剑，然后格挡', duration: 4 }, idempotencyKey: 'slash-path-gen' });
    const animationId = useAnimationStore.getState().activeId!;
    const initialPath = [[0, 1, 0], [0.2, 1.4, 0.1]];
    const initialSweep = [{ base: [0, 1, 0], tip: [0, 1.8, 0] }, { base: [0.2, 1, 0], tip: [0.4, 1.8, 0.1] }];
    const added = await executeAction({
      tool: 'set_previs_effect', args: { operation: 'add', kind: 'slash', time: 1, position: [0, 1, 0], path: initialPath, bladeSweep: initialSweep },
      idempotencyKey: 'slash-path-add',
    });
    expect(added.ok).toBe(true);
    const slashId = (added.data as { event: { id: string } }).event.id;
    await executeAction({ tool: 'set_previs_effect', args: { operation: 'add', kind: 'impact', time: 3, position: [1, 1, 0] }, idempotencyKey: 'slash-path-neighbor' });
    const neighborBefore = useEffectsStore.getState().events.find((event) => event.kind === 'impact')!;
    const before = useEffectsStore.getState().events.find((event) => event.id === slashId)!;
    const nextPath = [[0, 1, 0], [0.5, 1.6, -0.2], [0.8, 1.2, 0.4]];
    const nextSweep = [{ base: [0, 1, 0], tip: [0, 1.6, 0] }, { base: [0.5, 1.1, 0], tip: [0.8, 1.8, 0.4] }];
    const updated = await executeAction({
      tool: 'set_previs_effect', args: { operation: 'update', id: slashId, path: nextPath, bladeSweep: nextSweep },
      idempotencyKey: 'slash-path-update',
    });
    expect(updated.ok).toBe(true);
    expect(useEffectsStore.getState().events.find((event) => event.id === slashId)).toMatchObject({ time: before.time, path: nextPath, bladeSweep: nextSweep });
    expect(useEffectsStore.getState().events.find((event) => event.id === neighborBefore.id)).toEqual(neighborBefore);
    expect(usePrevisStore.getState().byAnimationId[animationId].scenePlan?.effects.find((event) => event.id === slashId)?.path).toEqual(nextPath);
    expect(usePrevisStore.getState().byAnimationId[animationId].scenePlan?.effects.find((event) => event.id === slashId)?.bladeSweep).toEqual(nextSweep);
    expect((await executeAction({
      tool: 'set_previs_effect', args: { operation: 'update', id: slashId, path: [[0, Number.NaN, 0], [1, 0, 0]] },
      idempotencyKey: 'slash-path-invalid',
    })).error?.code).toBe('BAD_ARGS');
    useAnimationStore.getState().undo();
    expect(useEffectsStore.getState().events.find((event) => event.id === slashId)?.path).toEqual(initialPath);
    expect((await executeAction({
      tool: 'set_previs_effect', args: { operation: 'update', id: slashId, path: null },
      idempotencyKey: 'slash-path-clear',
    })).ok).toBe(true);
    expect(useEffectsStore.getState().events.find((event) => event.id === slashId)?.path).toBeUndefined();
    expect((await executeAction({
      tool: 'set_previs_effect', args: { operation: 'update', id: slashId, bladeSweep: [{ base: [0, 0, 0], tip: [Number.NaN, 0, 0] }, { base: [0, 0, 0], tip: [1, 0, 0] }] },
      idempotencyKey: 'slash-blade-sweep-invalid',
    })).error?.code).toBe('BAD_ARGS');
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
    expect(planMock('躺倒床上').actions[0]).toMatchObject({ tool: 'generate_motion', args: { prompt: '躺倒床上' } });
    expect(planMock('躺下睡觉').actions[0]).toMatchObject({ tool: 'generate_motion', args: { prompt: '躺下睡觉' } });
    const unknown = planMock('今天天气怎么样');
    expect(unknown.actions).toEqual([]);
    expect(unknown.reply).toMatch(/没理解/);
  });

  it('一句自然语言的行为描述生成可播放预演草案', async () => {
    setupScene();
    const p = planMock('人物从窗边走到桌前，拿起手机，然后回头看向门口');
    expect(p.reply).toMatch(/预演草案/);
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({
      tool: 'generate_motion',
      args: { prompt: '人物从窗边走到桌前，拿起手机，然后回头看向门口', duration: 4 },
    });

    const results = await executeActions(p.actions);
    expect(results[0].ok).toBe(true);
    expect(useAnimationStore.getState().active()?.tracks.length).toBeGreaterThan(0);
    expect(useAnimationStore.getState().playing).toBe(true);
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
