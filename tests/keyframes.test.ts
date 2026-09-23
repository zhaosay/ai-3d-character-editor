import { describe, expect, it } from 'vitest';
import { deleteKeyAt, moveKey, nearestKeyTime, upsertKey } from '../src/core/animation/keyframes';
import type { Keyframe } from '../src/core/animation/types';

function k(time: number): Keyframe<number> {
  return { time, value: time, interp: 'linear' };
}

describe('keyframes helpers', () => {
  it('upsert 保持有序，同帧替换', () => {
    const keys = [k(0), k(2)];
    upsertKey(keys, k(1));
    expect(keys.map((x) => x.time)).toEqual([0, 1, 2]);
    upsertKey(keys, { time: 1.00001, value: 99, interp: 'linear' });
    expect(keys.length).toBe(3);
    expect(keys.find((x) => Math.abs(x.time - 1) < 0.01)?.value).toBe(99);
  });

  it('delete 命中才删除', () => {
    const keys = [k(0), k(1)];
    expect(deleteKeyAt(keys, 1)).toBe(true);
    expect(keys.length).toBe(1);
    expect(deleteKeyAt(keys, 5)).toBe(false);
  });

  it('move 钳制到 [0, duration] 并解决冲突', () => {
    const keys = [k(0), k(1), k(2)];
    expect(moveKey(keys, 0, 5, 2)).toBe(2); // 越界钳制，与 2s 冲突则替换
    expect(keys.map((x) => x.time).sort()).toEqual([1, 2]);
    expect(moveKey(keys, 9, 0, 2)).toBeNull(); // 找不到
    expect(nearestKeyTime(keys, 1.0005)).toBe(1);
    expect(nearestKeyTime(keys, 0.5)).toBeNull();
  });
});
