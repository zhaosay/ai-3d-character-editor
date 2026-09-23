import { create } from 'zustand';
import type { AnimationData, Interpolation } from '../core/animation/types';
import { createEmptyAnimation } from '../core/animation/types';
import { deleteKeyAt, getOrCreateTrack, moveKey, upsertKey } from '../core/animation/keyframes';
import type { QuatTuple, Vec3Tuple } from '../types/global';
import { useHistoryStore } from './historyStore';

interface AnimationState {
  animations: AnimationData[];
  activeId: string | null;
  currentTime: number;
  playing: boolean;
  loop: boolean;

  active: () => AnimationData | null;
  createAnimation: (name?: string) => string;
  selectAnimation: (id: string) => void;
  setTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  toggleLoop: () => void;
  setDuration: (d: number) => void;

  upsertRotationKey: (boneName: string, time: number, value: QuatTuple, interp?: Interpolation) => void;
  deleteRotationKey: (boneName: string, time: number) => boolean;
  moveRotationKey: (boneName: string, from: number, to: number) => number | null;
  /** 一次性写入多骨骼 rotation key（IK bake 用，单次 history push） */
  bakeRotationKeys: (entries: Array<{ boneName: string; time: number; value: QuatTuple; interp?: Interpolation }>) => void;
  /** 一次性写入多骨骼 position key（AutoPose 髋部下压用，单次 history push） */
  bakePositionKeys: (entries: Array<{ boneName: string; time: number; value: Vec3Tuple; interp?: Interpolation }>) => void;
  /** 合并写入 rotation + position（AutoPose 全身 bake，单次 history push） */
  bakePoseKeys: (
    rot: Array<{ boneName: string; time: number; value: QuatTuple; interp?: Interpolation }>,
    pos: Array<{ boneName: string; time: number; value: Vec3Tuple; interp?: Interpolation }>,
  ) => void;
  renameAnimation: (id: string, name: string) => void;
  deleteAnimation: (id: string) => void;
  /** Open Project 用：整体替换（单次 history push，可撤销） */
  replaceAll: (anims: AnimationData[], activeId: string | null) => void;
  clearProject: () => void;
  undo: () => void;
  redo: () => void;
}

function withHistory(mut: (anims: AnimationData[]) => void) {
  const st = useAnimationStore.getState();
  useHistoryStore.getState().push(st.animations);
  // 深拷贝后修改，保证 React 可检测
  const next = structuredClone(st.animations);
  // 将拷贝临时设回 store 再执行 mut（mut 操作拷贝）
  useAnimationStore.setState({ animations: next });
  mut(next);
  useAnimationStore.setState({ animations: [...next] });
}

export const useAnimationStore = create<AnimationState>((set, get) => ({
  animations: [],
  activeId: null,
  currentTime: 0,
  playing: false,
  loop: true,

  active: () => {
    const { animations, activeId } = get();
    return animations.find((a) => a.id === activeId) ?? animations[0] ?? null;
  },

  createAnimation: (name = 'Take 1') => {
    const a = createEmptyAnimation(name, 30, 4);
    withHistory((anims) => {
      anims.push(a);
    });
    set({ activeId: a.id, currentTime: 0, playing: false });
    return a.id;
  },

  selectAnimation: (id) => set({ activeId: id, currentTime: 0, playing: false }),

  setTime: (t) => {
    const a = get().active();
    const clamped = a ? Math.min(Math.max(t, 0), a.duration) : Math.max(t, 0);
    set({ currentTime: clamped });
  },

  setPlaying: (playing) => set({ playing }),

  toggleLoop: () => set((s) => ({ loop: !s.loop })),

  setDuration: (d) => {
    if (d <= 0.5 || d > 120) return;
    withHistory((anims) => {
      const a = anims.find((x) => x.id === get().activeId) ?? anims[0];
      if (a) {
        a.duration = d;
        // 删除越界 key
        for (const t of a.tracks) {
          t.rotation = t.rotation.filter((k) => k.time <= d);
          t.position = t.position.filter((k) => k.time <= d);
          t.scale = t.scale.filter((k) => k.time <= d);
        }
      }
    });
    const a = get().active();
    if (a && get().currentTime > a.duration) set({ currentTime: a.duration });
  },

  upsertRotationKey: (boneName, time, value, interp = 'linear') => {
    withHistory((anims) => {
      const a = anims.find((x) => x.id === get().activeId) ?? anims[0];
      if (!a) return;
      const t = Math.min(Math.max(time, 0), a.duration);
      const track = getOrCreateTrack(a, boneName);
      upsertKey(track.rotation, { time: t, value: [...value] as QuatTuple, interp });
    });
  },

  deleteRotationKey: (boneName, time) => {
    let removed = false;
    withHistory((anims) => {
      const a = anims.find((x) => x.id === get().activeId) ?? anims[0];
      if (!a) return;
      const track = a.tracks.find((x) => x.boneName === boneName);
      if (track) removed = deleteKeyAt(track.rotation, time);
    });
    // withHistory 每次都 push；若实际未删除则弹回（避免空操作污染 undo）
    if (!removed) {
      const h = useHistoryStore.getState();
      const past = h.past;
      if (past.length > 0) {
        // 移除刚才多余的 push：直接重建（保持 future 不变）
        useHistoryStore.setState({ past: past.slice(0, -1) });
      }
    }
    return removed;
  },

  moveRotationKey: (boneName, from, to) => {
    let result: number | null = null;
    withHistory((anims) => {
      const a = anims.find((x) => x.id === get().activeId) ?? anims[0];
      if (!a) return;
      const track = a.tracks.find((x) => x.boneName === boneName);
      if (track) result = moveKey(track.rotation, from, to, a.duration);
    });
    return result;
  },

  bakeRotationKeys: (entries) => {
    if (entries.length === 0) return;
    withHistory((anims) => {
      const a = anims.find((x) => x.id === get().activeId) ?? anims[0];
      if (!a) return;
      for (const e of entries) {
        const t = Math.min(Math.max(e.time, 0), a.duration);
        const track = getOrCreateTrack(a, e.boneName);
        upsertKey(track.rotation, { time: t, value: [...e.value] as QuatTuple, interp: e.interp ?? 'linear' });
      }
    });
  },

  bakePositionKeys: (entries) => {
    get().bakePoseKeys([], entries);
  },

  bakePoseKeys: (rot, pos) => {
    if (rot.length === 0 && pos.length === 0) return;    withHistory((anims) => {
      const a = anims.find((x) => x.id === get().activeId) ?? anims[0];
      if (!a) return;
      for (const e of rot) {
        const t = Math.min(Math.max(e.time, 0), a.duration);
        const track = getOrCreateTrack(a, e.boneName);
        upsertKey(track.rotation, { time: t, value: [...e.value] as QuatTuple, interp: e.interp ?? 'linear' });
      }
      for (const e of pos) {
        const t = Math.min(Math.max(e.time, 0), a.duration);
        const track = getOrCreateTrack(a, e.boneName);
        upsertKey(track.position, { time: t, value: [...e.value] as Vec3Tuple, interp: e.interp ?? 'linear' });
      }
    });
  },

  renameAnimation: (id, name) => {
    const n = name.trim().slice(0, 64);
    if (!n) return;
    withHistory((anims) => {
      const a = anims.find((x) => x.id === id);
      if (a) a.name = n;
    });
  },

  deleteAnimation: (id) => {
    withHistory((anims) => {
      const i = anims.findIndex((x) => x.id === id);
      if (i >= 0) anims.splice(i, 1);
    });
    const st = get();
    if (st.activeId === id) {
      const next = st.animations[0] ?? null;
      set({ activeId: next ? next.id : null, currentTime: 0, playing: false });
    }
  },

  replaceAll: (anims, activeId) => {
    // 先 push 当前状态进 undo（空修改），再整体替换 → Open/New 均可撤销
    withHistory(() => {});
    set({
      animations: structuredClone(anims),
      activeId: activeId ?? anims[0]?.id ?? null,
      currentTime: 0,
      playing: false,
    });
  },

  clearProject: () => {
    withHistory((anims) => {
      anims.length = 0;
    });
    set({ activeId: null, currentTime: 0, playing: false });
  },

  undo: () => {
    const prev = useHistoryStore.getState().undo(get().animations);
    if (prev) set({ animations: prev, playing: false });
  },

  redo: () => {
    const next = useHistoryStore.getState().redo(get().animations);
    if (next) set({ animations: next, playing: false });
  },
}));
