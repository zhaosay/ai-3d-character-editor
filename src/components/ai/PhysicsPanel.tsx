import { useMemo, useState } from 'react';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useIKStore } from '../../stores/ikStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { analyzeTrajectory } from '../../core/physics/analyze';
import { collectTrajectory } from '../../core/physics/trajectory';
import { buildFootLockEntries, buildHipsLiftEntries, buildSmoothedHipsEntries } from '../../core/physics/fixes';
import type { BoneNames, PhysicsIssue, TrajSample } from '../../core/physics/types';
import type { IKChainId } from '../../core/ik/types';
import { ProviderBadge } from './ProviderBadge';

function boneNamesOf(): BoneNames | null {
  const snap = useSkeletonStore.getState().snapshot;
  if (!snap) return null;
  const bySem = new Map(Object.values(snap.nodes).map((n) => [n.semantic, n.name]));
  const hips = bySem.get('hips');
  if (!hips) return null;
  return { hips, footL: bySem.get('foot.L') ?? null, footR: bySem.get('foot.R') ?? null };
}

export function PhysicsPanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const active = useAnimationStore((s) => s.active());
  const setTime = useAnimationStore((s) => s.setTime);
  const bakePoseKeys = useAnimationStore((s) => s.bakePoseKeys);
  const [issues, setIssues] = useState<PhysicsIssue[] | null>(null);
  const [samples, setSamples] = useState<TrajSample[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fixed, setFixed] = useState<string | null>(null);

  const names = useMemo(() => (active ? boneNamesOf() : null), [active, sceneObject]);

  const check = () => {
    if (!sceneObject || !active || !names) return;
    setBusy(true);
    try {
      const { samples: s, warnings: w } = collectTrajectory(sceneObject, active, names, 30);
      setSamples(s);
      setWarnings(w);
      setIssues(analyzeTrajectory(s));
      setFixed(null);
    } finally {
      setBusy(false);
    }
  };

  const fixPenetration = () => {
    if (!active || !names || !issues) return;
    const entries = buildHipsLiftEntries(samples, issues, names.hips);
    if (entries.length === 0) return;
    bakePoseKeys([], entries);
    setFixed(`穿透修复：髋部上抬写入 ${entries.length} 个 position keys`);
    check();
  };

  const fixAccel = () => {
    if (!active || !names || !issues) return;
    const entries = buildSmoothedHipsEntries(samples, issues, names.hips);
    if (entries.length === 0) return;
    bakePoseKeys([], entries);
    setFixed(`落地缓冲：平滑 ${entries.length} 个髋部 keys`);
    check();
  };

  const fixSlide = (issue: PhysicsIssue) => {
    if (!active || !sceneObject || !issue.foot) return;
    const id = (issue.foot === 'L' ? 'leg.L' : 'leg.R') as IKChainId;
    const c = useIKStore.getState().chains[id];
    if (!c) {
      setWarnings([`${id} IK 链未检测到，无法脚锁（先确认语义映射）`]);
      return;
    }
    const { entries, warnings: w } = buildFootLockEntries(sceneObject, active, issue, c.def, [...c.polePoint]);
    if (entries.length > 0) bakePoseKeys(entries, []);
    setWarnings(w);
    setFixed(`脚锁：${issue.foot === 'L' ? '左' : '右'}脚 ${issue.t0.toFixed(2)}–${issue.t1.toFixed(2)}s 写入 ${entries.length / 3} 帧整链 keys`);
    check();
  };

  const kinds = new Set((issues ?? []).map((i) => i.kind));

  return (
    <div className="space-y-2 border-b border-zinc-800 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-300">
        Physics <ProviderBadge source="real" label="P9 本地分析" />
      </div>
      {!active && <div className="text-zinc-500">先创建动画</div>}
      {active && !names && <div className="text-amber-400">未找到 hips 骨骼，无法分析</div>}
      <button
        onClick={check}
        disabled={busy || !sceneObject || !active || !names}
        className="w-full rounded bg-emerald-600 px-2 py-1.5 text-white disabled:bg-zinc-800 disabled:text-zinc-500"
      >
        {busy ? '分析中…' : '一键检查（重心/脚滑/落地）'}
      </button>
      {samples.length > 2 && <HeightChart samples={samples} issues={issues ?? []} />}
      {warnings.map((w, i) => (
        <div key={i} className="text-[11px] text-amber-400">⚠ {w}</div>
      ))}
      {issues && issues.length === 0 && <div className="text-emerald-400">未发现问题 ✓</div>}
      {(issues ?? []).map((issue, i) => (
        <div key={i} className="rounded bg-zinc-900 p-2 text-[11px]">
          <button onClick={() => setTime(issue.t0)} className="text-left text-zinc-200 hover:text-emerald-300" title="跳转到问题时间">
            {issue.message} →
          </button>
          {issue.kind === 'footSlide' && (
            <button onClick={() => fixSlide(issue)} className="mt-1 w-full rounded bg-zinc-700 px-2 py-1 text-white">
              脚锁修复此段
            </button>
          )}
        </div>
      ))}
      {issues && issues.length > 0 && (
        <div className="flex gap-1">
          {kinds.has('penetration') && (
            <button onClick={fixPenetration} className="flex-1 rounded bg-zinc-700 px-2 py-1">修穿透</button>
          )}
          {kinds.has('accelSpike') && (
            <button onClick={fixAccel} className="flex-1 rounded bg-zinc-700 px-2 py-1">落地缓冲</button>
          )}
        </div>
      )}
      {fixed && <div className="text-[11px] text-emerald-400">{fixed}</div>}
      <div className="text-[11px] text-zinc-500">本地采样分析（30fps），修复均为可撤销 bake；非完整物理引擎。</div>
    </div>
  );
}

function HeightChart({ samples, issues }: { samples: TrajSample[]; issues: PhysicsIssue[] }) {
  const W = 240;
  const H = 56;
  const ys = samples.map((s) => s.hipsY);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = Math.max(max - min, 1e-4);
  const dur = samples[samples.length - 1].time;
  const pts = samples.map((s) => {
    const x = (s.time / Math.max(dur, 1e-6)) * W;
    const y = H - 4 - ((s.hipsY - min) / span) * (H - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <div className="rounded bg-zinc-900 p-1">
      <div className="mb-0.5 text-[10px] text-zinc-500">重心高度–时间（{min.toFixed(2)}–{max.toFixed(2)}m）</div>
      <svg width={W} height={H} className="w-full">
        <polyline points={pts} fill="none" stroke="#34d399" strokeWidth="1.5" />
        {issues.filter((i) => i.kind === 'accelSpike').map((s, i) => (
          <circle key={i} cx={(s.t0 / Math.max(dur, 1e-6)) * W} cy={6} r={3} fill="#f87171" />
        ))}
      </svg>
    </div>
  );
}
