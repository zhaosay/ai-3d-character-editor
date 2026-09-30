import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useIKStore } from '../../stores/ikStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { captureBoneLocal } from '../../core/animation/applyPose';
import type { IKChainId } from '../../core/ik/types';
import type { Vec3Tuple } from '../../types/global';
import { ProviderBadge } from '../ai/ProviderBadge';

const ORDER: IKChainId[] = ['arm.L', 'arm.R', 'leg.L', 'leg.R'];

export function IKPanel() {
  const chains = useIKStore((s) => s.chains);
  const rig = useSkeletonStore((s) => s.rigSuggestion);
  const detected = ORDER.filter((id) => chains[id]);
  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-700">
        IK <ProviderBadge source="real" label="P3 双骨+Pole" />
      </div>
      {rig && <RigStatus />}
      {detected.length === 0 && (
        <div className="text-zinc-500">未检测到 IK 链（需要语义映射到手臂/腿骨骼，先加载带骨骼角色）</div>
      )}
      {detected.map((id) => (
        <ChainRow key={id} id={id} />
      ))}
      <div className="text-[11px] text-zinc-500">IK 仅暂停时生效；播放时为 FK 采样。调好姿势后可用“整链打关键帧”存入 Timeline。</div>
    </div>
  );
}

/** 骨架自动识别结果：陌生命名时告诉用户哪里没绑上，而不是静默失效。 */
function RigStatus() {
  const rig = useSkeletonStore((s) => s.rigSuggestion);
  if (!rig) return null;
  if (rig.confidence === 'certain') {
    return (
      <div className="rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800 ring-1 ring-emerald-300">
        骨架自动识别：全部 {Object.keys(rig.map).length} 项已绑定
      </div>
    );
  }
  return (
    <details className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900 ring-1 ring-amber-300">
      <summary className="cursor-pointer font-bold">
        骨架自动识别：{rig.confidence === 'none' ? '核心骨骼缺失' : '建议复核'}
        （已绑 {Object.keys(rig.map).length} 项）
      </summary>
      {rig.missingCore.length > 0 && (
        <div className="mt-1 font-mono">
          缺核心：{rig.missingCore.join('、')}
        </div>
      )}
      {rig.unmapped.length > 0 && (
        <div className="mt-1 text-amber-800">
          未识别 {rig.unmapped.length} 根：{rig.unmapped.slice(0, 8).join('、')}
          {rig.unmapped.length > 8 && ` 等`}
        </div>
      )}
      <div className="mt-1 text-amber-800">
        这些骨骼不参与 IK 与动作模板；改名后可自动识别，或换用标准命名角色。
      </div>
    </details>
  );
}

function ChainRow({ id }: { id: IKChainId }) {
  const c = useIKStore((s) => s.chains[id]);
  const toggleChain = useIKStore((s) => s.toggleChain);
  const setTarget = useIKStore((s) => s.setTarget);
  const setPolePoint = useIKStore((s) => s.setPolePoint);
  const resetChain = useIKStore((s) => s.resetChain);
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const currentTime = useAnimationStore((s) => s.currentTime);
  const active = useAnimationStore((s) => s.active());
  const bakeRotationKeys = useAnimationStore((s) => s.bakeRotationKeys);
  if (!c) return null;

  const bake = () => {
    if (!sceneObject || !active) return;
    const q = [c.def.rootBone, c.def.midBone, c.def.endBone].map((n) => ({ n, cap: captureBoneLocal(sceneObject, n) }));
    if (q.some((x) => !x.cap)) return;
    bakeRotationKeys(q.map((x) => ({ boneName: x.n, time: currentTime, value: x.cap!.quaternion, interp: 'linear' as const })));
  };

  return (
    <div className={`rounded p-2 ring-1 ${c.enabled ? 'bg-zinc-100 ring-emerald-700' : 'bg-zinc-100/70 ring-zinc-300'}`}>
      <div className="flex items-center gap-2">
        <input type="checkbox" checked={c.enabled} onChange={() => toggleChain(id)} />
        <span className="font-bold text-zinc-800">
          {c.def.label} <span className="font-mono text-[10px] text-zinc-500">{id}</span>
        </span>
        <button onClick={() => resetChain(id)} className="ml-auto rounded bg-zinc-200 px-1.5 py-0.5 text-[11px]">
          重置
        </button>
      </div>
      <div className="mt-1 font-mono text-[10px] text-zinc-500">
        {c.def.rootBone} → {c.def.midBone} → {c.def.endBone}
      </div>
      {c.enabled && (
        <div className="mt-1 space-y-1">
          <VecInput label="目标" value={c.target} onChange={(v) => setTarget(id, v)} />
          <VecInput label="极向量" value={c.polePoint} onChange={(v) => setPolePoint(id, v)} />
          {c.lastSolve && (
            <div className="font-mono text-[10px] text-zinc-600">
              肘/膝角 {c.lastSolve.hingeDeg.toFixed(1)}°
              {!c.lastSolve.reached && <span className="text-amber-400"> · 超出可达，已钳制</span>}
            </div>
          )}
          <button onClick={bake} disabled={!active} className="w-full rounded bg-emerald-600 px-2 py-1 text-white disabled:bg-zinc-200 disabled:text-zinc-500">
            ◆ 整链打关键帧 @ {currentTime.toFixed(2)}s
          </button>
        </div>
      )}
    </div>
  );
}

function VecInput({ label, value, onChange }: { label: string; value: Vec3Tuple; onChange: (v: Vec3Tuple) => void }) {
  return (
    <label className="flex items-center gap-1 text-zinc-600">
      <span className="w-10">{label}</span>
      {([0, 1, 2] as const).map((i) => (
        <input
          key={i}
          type="number"
          step={0.05}
          value={Number(value[i].toFixed(3))}
          onChange={(e) => {
            const v: Vec3Tuple = [...value] as Vec3Tuple;
            v[i] = Number(e.target.value);
            onChange(v);
          }}
          className="w-full rounded bg-white px-1 py-0.5 font-mono text-zinc-800 outline-none ring-1 ring-zinc-300"
        />
      ))}
    </label>
  );
}
