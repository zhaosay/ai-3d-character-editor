import { describe, expect, it, beforeEach } from 'vitest';
import { useAnimationStore } from '../src/stores/animationStore';
import { useHistoryStore } from '../src/stores/historyStore';

const Q: [number, number, number, number] = [0, 0, 0, 1];

beforeEach(() => {
  useAnimationStore.setState({ animations: [], activeId: null, currentTime: 0, playing: false, loop: true });
  useHistoryStore.getState().clear();
});

describe('animationStore + history', () => {
  it('打 key → undo 消失 → redo 恢复', () => {
    const st = useAnimationStore.getState();
    const id = st.createAnimation('T');
    useAnimationStore.getState().upsertRotationKey('Hips', 1, Q);
    expect(useAnimationStore.getState().active()?.tracks[0].rotation.length).toBe(1);

    useAnimationStore.getState().undo();
    expect(useAnimationStore.getState().active()?.tracks.length ?? 0).toBe(0);

    useAnimationStore.getState().redo();
    expect(useAnimationStore.getState().active()?.tracks[0].rotation.length).toBe(1);
    expect(useAnimationStore.getState().active()?.id).toBe(id);
  });

  it('删除不存在的 key 不污染 undo 栈', () => {
    useAnimationStore.getState().createAnimation('T');
    const before = useHistoryStore.getState().past.length;
    const ok = useAnimationStore.getState().deleteRotationKey('Hips', 1);
    expect(ok).toBe(false);
    expect(useHistoryStore.getState().past.length).toBe(before);
  });

  it('setDuration 裁掉越界 key', () => {
    useAnimationStore.getState().createAnimation('T');
    useAnimationStore.getState().upsertRotationKey('Hips', 3.5, Q);
    useAnimationStore.getState().setDuration(2);
    expect(useAnimationStore.getState().active()?.duration).toBe(2);
    expect(useAnimationStore.getState().active()?.tracks[0].rotation.length).toBe(0);
  });
});
