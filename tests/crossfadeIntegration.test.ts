import { beforeEach, describe, expect, it } from 'vitest';
import { useAnimationStore } from '../src/stores/animationStore';
import { createEmptyAnimation } from '../src/core/animation/types';

/**
 * 交叉淡化的**集成**测试（纯函数的单测见 crossfade.test.ts / stateMachine.test.ts）。
 *
 * 覆盖此前缺失的一环：淡化是否真的经由 store 产生混合姿态，
 * 以及淡化的生命周期（开始 → 推进 → 结束）。
 */

function makeAnim(name: string, duration: number, bone: string, rot: [number, number, number, number]) {
  const a = createEmptyAnimation(name, 30, duration);
  a.tracks = [{
    boneName: bone,
    position: [],
    rotation: [
      { time: 0, value: [0, 0, 0, 1], interp: 'linear' as const },
      { time: duration, value: rot, interp: 'linear' as const },
    ],
    scale: [],
  }];
  return a;
}

describe('交叉淡化（store 集成）', () => {
  beforeEach(() => {
    useAnimationStore.setState({
      animations: [], activeId: null, currentTime: 0, playing: false, loop: true,
      fadeFromId: null, fadeFromTime: 0, fadeElapsed: 0, fadeDuration: 0, transitionDuration: 0.2,
    });
  });

  it('未淡化时 blendWeight 为 null，直接返回当前动画姿态', () => {
    const a = makeAnim('A', 2, 'Hips', [0, 0, 0.7071, 0.7071]);
    useAnimationStore.setState({ animations: [a], activeId: a.id });
    expect(useAnimationStore.getState().fadeWeight()).toBeNull();
    const pose = useAnimationStore.getState().blendedPoseAt(0);
    expect(pose?.get('Hips')?.quaternion).toEqual([0, 0, 0, 1]);
  });

  it('transitionTo 建立淡化，权重从 0 起步', () => {
    const a = makeAnim('A', 2, 'Hips', [0, 0, 0, 1]);
    const b = makeAnim('B', 2, 'Hips', [0, 0, 0.7071, 0.7071]);
    useAnimationStore.setState({ animations: [a, b], activeId: a.id, playing: true, currentTime: 1 });
    useAnimationStore.getState().transitionTo(b.id, 0.4);

    const st = useAnimationStore.getState();
    expect(st.activeId).toBe(b.id);
    expect(st.fadeFromId).toBe(a.id);
    expect(st.fadeDuration).toBeCloseTo(0.4, 6);
    expect(st.fadeWeight()!).toBeLessThan(0.05);
  });

  it('淡化进行中确实产生中间姿态（不是硬切）', () => {
    const a = makeAnim('A', 2, 'Hips', [0, 0, 0, 1]);
    const b = makeAnim('B', 2, 'Hips', [0, 0, 0.7071, 0.7071]);
    useAnimationStore.setState({ animations: [a, b], activeId: a.id, playing: true });
    useAnimationStore.getState().transitionTo(b.id, 0.4);
    // 推进到一半
    useAnimationStore.getState().tickFade(0.2);
    expect(useAnimationStore.getState().fadeWeight()!).toBeCloseTo(0.5, 2);

    // 取 B 的**终点**姿态（t=2）而不是起点 —— 起点两个 clip 都是单位旋转，看不出混合
    const pose = useAnimationStore.getState().blendedPoseAt(2);
    const q = pose!.get('Hips')!.quaternion!;
    // 中间姿态应在两者之间（z 分量介于 0 与 0.7071）
    expect(q[2]).toBeGreaterThan(0.1);
    expect(q[2]).toBeLessThan(0.65);
    // 且仍是合法四元数（float32 累加误差，放宽到 1e-4）
    expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThan(1e-4);
  });

  it('淡化结束后自动丢弃来源（fadeWeight 回到 null）', () => {
    const a = makeAnim('A', 2, 'Hips', [0, 0, 0, 1]);
    const b = makeAnim('B', 2, 'Hips', [0, 0, 0.7071, 0.7071]);
    useAnimationStore.setState({ animations: [a, b], activeId: a.id, playing: true });
    useAnimationStore.getState().transitionTo(b.id, 0.3);
    useAnimationStore.getState().tickFade(0.5);
    const st = useAnimationStore.getState();
    expect(st.fadeFromId).toBeNull();
    expect(st.fadeWeight()).toBeNull();
  });

  it('未播放时切换 = 硬切（不该留一个永远不推进的淡化）', () => {
    const a = makeAnim('A', 2, 'Hips', [0, 0, 0, 1]);
    const b = makeAnim('B', 2, 'Hips', [0, 0, 0.7071, 0.7071]);
    useAnimationStore.setState({ animations: [a, b], activeId: a.id, playing: false });
    useAnimationStore.getState().transitionTo(b.id, 0.4);
    expect(useAnimationStore.getState().fadeFromId).toBeNull();
  });

  it('过渡时长 0 = 硬切', () => {
    const a = makeAnim('A', 2, 'Hips', [0, 0, 0, 1]);
    const b = makeAnim('B', 2, 'Hips', [0, 0, 0.7071, 0.7071]);
    useAnimationStore.setState({ animations: [a, b], activeId: a.id, playing: true });
    useAnimationStore.getState().transitionTo(b.id, 0);
    expect(useAnimationStore.getState().fadeFromId).toBeNull();
  });

  it('切到自身不产生淡化', () => {
    const a = makeAnim('A', 2, 'Hips', [0, 0, 0, 1]);
    useAnimationStore.setState({ animations: [a], activeId: a.id, playing: true });
    useAnimationStore.getState().transitionTo(a.id, 0.3);
    expect(useAnimationStore.getState().activeId).toBe(a.id);
    expect(useAnimationStore.getState().fadeFromId).toBeNull();
  });

  it('来源动画被删除后淡化安全降级为当前动画', () => {
    const a = makeAnim('A', 2, 'Hips', [0, 0, 0, 1]);
    const b = makeAnim('B', 2, 'Hips', [0, 0, 0.7071, 0.7071]);
    useAnimationStore.setState({ animations: [a, b], activeId: a.id, playing: true });
    useAnimationStore.getState().transitionTo(b.id, 0.4);
    // 硬删来源（绕过 deleteAnimation 的历史逻辑，只测健壮性）
    useAnimationStore.setState((s) => ({ animations: s.animations.filter((x) => x.id !== a.id) }));
    const pose = useAnimationStore.getState().blendedPoseAt(0);
    expect(pose?.get('Hips')).toBeTruthy();
  });

  it('cancelFade 立即结束淡化', () => {
    const a = makeAnim('A', 2, 'Hips', [0, 0, 0, 1]);
    const b = makeAnim('B', 2, 'Hips', [0, 0, 0.7071, 0.7071]);
    useAnimationStore.setState({ animations: [a, b], activeId: a.id, playing: true });
    useAnimationStore.getState().transitionTo(b.id, 0.4);
    useAnimationStore.getState().tickFade(0.1);
    useAnimationStore.getState().cancelFade();
    expect(useAnimationStore.getState().fadeFromId).toBeNull();
  });
});