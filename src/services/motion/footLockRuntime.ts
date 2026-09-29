import * as THREE from 'three';
import { fieldFromSteps, useFootLockStore } from '../../stores/footLockStore';
import { applyIKChain } from '../../core/ik/applyIK';
import { indexBonesByName } from '../../core/animation/applyPose';
import {
  computePolePoint, createFootLockStates, footSolePosition, lockedTarget, measureSoleDrop,
  resolveFootRig, totalSlip, updateFootState, type FootLockConfig, type FootSide, type FootState,
} from '../../core/ik/footLock';
import type { IKChainDef } from '../../core/ik/types';

/**
 * 足部锁定运行时。
 * 状态是「时间相关」的：同一时间点重复求解必须得到同样结果，
 * 因此用可寻址的状态（按时间分桶 + 循环回卷）而非逐帧累积。
 */

const _pos = new THREE.Vector3();

interface FootRuntime {
  state: FootState;
  lastTime: number;
  lastPos: THREE.Vector3 | null;
}

export class FootLockRuntime {
  private readonly chains: IKChainDef[];
  private readonly runtimes = new Map<FootSide, FootRuntime>();
  private config: FootLockConfig;
  private lastTime = -1;
  /** 缓存：同一时间的求解结果 */
  private cacheTime = Number.NaN;
  private cacheSlip = 0;

  constructor(chains: IKChainDef[], config: FootLockConfig) {
    this.chains = chains.filter((c) => c.type === 'leg');
    this.config = config;
    const states = createFootLockStates(this.chains.map((c) => legSideOf(c.id)));
    for (const [side, state] of states) {
      this.runtimes.set(side, { state, lastTime: -1, lastPos: null });
    }
  }

  /** 时间回退（拖动时间轴/重播）时重置状态。 */
  rewindIfNeeded(time: number) {
    if (this.lastTime >= 0 && time < this.lastTime - 1e-6) this.reset();
    this.lastTime = time;
  }

  reset() {
    for (const [side, rt] of this.runtimes) {
      this.runtimes.set(side, { state: { ...rt.state, planted: false, anchor: null, correction: 0 }, lastTime: -1, lastPos: null });
    }
    this.lastTime = -1;
    this.cacheTime = Number.NaN;
  }

  /**
   * 对给定根对象求解足部锁定。返回本帧累计打滑（米）。
   * 必须在 applySampledPose 之后调用（依赖 FK 后的世界位置）。
   */
  solve(root: THREE.Object3D, time: number, delta: number): number {
    this.rewindIfNeeded(time);
    if (this.runtimes.size === 0) return 0;
    if (time === this.cacheTime) return this.cacheSlip;

    // store 里有台阶时以 store 为准（场景可编辑）；否则保留构造时传入的场。
    // 不能无条件用 store.config 覆盖 —— 那样会丢掉调用方显式传入的 field。
    const st = useFootLockStore.getState();
    if (st.steps.length > 0) {
      this.config = { ...this.config, field: fieldFromSteps(st.steps, st.config.groundY) };
    }

    const bones = indexBonesByName(root);
    for (const chain of this.chains) {
      const side = legSideOf(chain.id);
      const rt = this.runtimes.get(side);
      if (!rt) continue;
      const rig = resolveFootRig(root, chain);
      if (!rig) continue;

      // 脚底偏移按实际几何实测（不同资产的脚骨原点差异很大，硬编码会误判触地）
      const sole = footSolePosition(rig.foot, measureSoleDrop(root, rig.foot), _pos).clone();
      const prev = rt.lastPos;
      const velocity = prev && delta > 0 ? sole.distanceTo(prev) / delta : 0;
      const state = updateFootState(rt.state, sole, this.config, velocity);
      rt.state = state;
      rt.lastPos = sole;

      const target = lockedTarget(state, this.config);
      if (!target) continue;

      // applyIKChain 内部用 getWorldPosition，故直接传世界坐标落点
      applyIKChain(bones, chain, target, computePolePoint(rig));
    }
    root.updateWorldMatrix(true, true);

    const slip = totalSlip([...this.runtimes.values()].map((r) => r.state));
    this.cacheTime = time;
    this.cacheSlip = slip;
    return slip;
  }
}

function legSideOf(id: string): FootSide {
  return id.endsWith('.L') ? 'L' : 'R';
}

/** 便捷入口：从 store 读取开关与配置。 */
export function footLockEnabled(): boolean {
  return useFootLockStore.getState().enabled;
}

export function footLockConfig(): FootLockConfig {
  return useFootLockStore.getState().config;
}
