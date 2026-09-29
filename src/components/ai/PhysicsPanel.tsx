import { useMemo, useState } from 'react';
import { useAnimationStore } from '../../stores/animationStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useIKStore } from '../../stores/ikStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { analyzeTrajectory, JOINT_LIMIT_DEGREES } from '../../core/physics/analyze';
import { collectTrajectory } from '../../core/physics/trajectory';
import { buildBalanceCorrectionEntries, buildFootLockEntries, buildHipsLiftEntries, buildJointLimitEntries, buildSmoothedHipsEntries } from '../../core/physics/fixes';
import { formatMotionCollisionWarnings, inspectGroundSupportWarnings, inspectMotionCollisions, inspectPropSupportWarnings } from '../../core/previs/collision';
import type { BoneNames, PhysicsIssue, TrajSample } from '../../core/physics/types';
import type { IKChainId } from '../../core/ik/types';
import { ProviderBadge } from './ProviderBadge';
import { usePrevisStore } from '../../stores/previsStore';
import { useWorldStore } from '../../stores/worldStore';

function boneNamesOf(snap = useSkeletonStore.getState().snapshot): BoneNames | null {
  if (!snap) return null;
  const bySem = new Map(Object.values(snap.nodes).map((n) => [n.semantic, n.name]));
  const hips = bySem.get('hips');
  if (!hips) return null;
  return {
    hips, footL: bySem.get('foot.L') ?? null, footR: bySem.get('foot.R') ?? null,
    massBones: Object.fromEntries([...bySem].filter(([semantic, name]) => semantic && name)) as BoneNames['massBones'],
    jointLimits: Object.values(snap.nodes).flatMap((node) => node.semantic && JOINT_LIMIT_DEGREES[node.semantic] !== undefined
      ? [{ semantic: node.semantic, boneName: node.name, restQuaternion: node.restLocal.quaternion, maxDegrees: JOINT_LIMIT_DEGREES[node.semantic]! }]
      : []),
  };
}

export function PhysicsPanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const skeletonSnapshot = useSkeletonStore((s) => s.snapshot);
  const active = useAnimationStore((s) => s.active());
  const hasActiveAnimation = Boolean(active);
  const setTime = useAnimationStore((s) => s.setTime);
  const bakePoseKeys = useAnimationStore((s) => s.bakePoseKeys);
  const [issues, setIssues] = useState<PhysicsIssue[] | null>(null);
  const [samples, setSamples] = useState<TrajSample[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fixed, setFixed] = useState<string | null>(null);

  const names = useMemo(() => (hasActiveAnimation ? boneNamesOf(skeletonSnapshot) : null), [hasActiveAnimation, skeletonSnapshot]);

  const check = (preserveFixMessage = false, extraWarnings: string[] = []) => {
    const currentScene = useCharacterStore.getState().sceneObject;
    const currentAnimation = useAnimationStore.getState().active();
    const currentNames = boneNamesOf();
    if (!currentScene || !currentAnimation || !currentNames) return;
    setBusy(true);
    try {
      const { samples: s, warnings: w } = collectTrajectory(currentScene, currentAnimation, currentNames, 30);
      const stageProps = useWorldStore.getState().props;
      const previs = usePrevisStore.getState().byAnimationId[currentAnimation.id];
      const segments = previs?.segments ?? [];
      const contacts = previs?.scenePlan?.contacts ?? previs?.contacts ?? [];
      const collisionWarnings = formatMotionCollisionWarnings(inspectMotionCollisions(
        currentScene, currentAnimation, stageProps, segments, contacts, useSkeletonStore.getState().snapshot ?? undefined,
      ), currentScene);
      const supportWarnings = [
        ...inspectGroundSupportWarnings(currentScene, currentAnimation, segments, contacts,
          stageProps.find((prop) => prop.kind === 'room')?.position[1] ?? 0),
        ...inspectPropSupportWarnings(currentScene, currentAnimation, segments, contacts, stageProps),
      ];
      setSamples(s);
      setWarnings([...w, ...collisionWarnings, ...supportWarnings, ...extraWarnings]);
      setIssues(analyzeTrajectory(s, currentNames.jointLimits));
      if (!preserveFixMessage) setFixed(null);
    } catch (error) {
      setIssues(null);
      setWarnings([error instanceof Error ? `分析失败：${error.message}` : '分析失败：未知错误']);
    } finally {
      setBusy(false);
    }
  };

  const fixPenetration = () => {
    if (!active || !names || !issues) return;
    const entries = buildHipsLiftEntries(samples, issues, names.hips);
    if (entries.length === 0) {
      setWarnings(['穿透修复未生成关键帧；请重新检查轨迹或确认采样数据完整']);
      return;
    }
    bakePoseKeys([], entries);
    setFixed(`穿透修复：髋部上抬写入 ${entries.length} 个 position keys`);
    check(true);
  };

  const fixAccel = () => {
    if (!active || !names || !issues) return;
    const entries = buildSmoothedHipsEntries(samples, issues, names.hips);
    if (entries.length === 0) {
      setWarnings(['落地缓冲未生成关键帧；请重新检查轨迹或调整采样范围']);
      return;
    }
    bakePoseKeys([], entries);
    setFixed(`落地缓冲：平滑 ${entries.length} 个髋部 keys`);
    check(true);
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
    if (entries.length === 0) {
      setWarnings([...w, '脚锁修复未生成关键帧；请检查接触段和骨骼映射']);
      setFixed(null);
      return;
    }
    bakePoseKeys(entries, []);
    setWarnings(w);
    setFixed(`脚锁：${issue.foot === 'L' ? '左' : '右'}脚 ${issue.t0.toFixed(2)}–${issue.t1.toFixed(2)}s 写入 ${entries.length / 3} 帧整链 keys`);
    check(true);
  };

  const fixJointLimit = (issue: PhysicsIssue) => {
    if (!active || !names) return;
    const limit = names.jointLimits?.find((item) => item.boneName === issue.boneName && item.maxDegrees === issue.limit);
    if (!limit) {
      setWarnings(['找不到该骨骼的预警阈值；请重新扫描骨架后再修复']);
      return;
    }
    const entries = buildJointLimitEntries(active, issue, limit);
    if (entries.length === 0) {
      setWarnings(['关节修复未生成关键帧；该骨骼可能没有可编辑的旋转轨道']);
      return;
    }
    bakePoseKeys(entries, []);
    setTime(issue.t0);
    setFixed(`关节范围修复：${issue.boneName} 写入 ${entries.length} 个旋转关键帧，可撤销`);
    check(true);
  };

  const fixBalance = (issue: PhysicsIssue) => {
    if (!active || !sceneObject || !names || !samples.length) return;
    const chains = useIKStore.getState().chains;
    const result = buildBalanceCorrectionEntries(sceneObject, active, samples, issue, names.hips, {
      ...(chains['leg.L'] ? { L: { def: chains['leg.L'].def, polePoint: [...chains['leg.L'].polePoint] as [number, number, number] } } : {}),
      ...(chains['leg.R'] ? { R: { def: chains['leg.R'].def, polePoint: [...chains['leg.R'].polePoint] as [number, number, number] } } : {}),
    });
    if (result.pos.length === 0) {
      setWarnings(result.warnings);
      setFixed(null);
      return;
    }
    bakePoseKeys(result.rot, result.pos);
    setTime(issue.t0);
    setFixed(`重心配平尝试：${result.pos.length} 个髋部位置帧、${result.rot.length} 个腿部 IK 旋转帧，可撤销`);
    check(true, result.warnings);
  };

  const kinds = new Set((issues ?? []).map((i) => i.kind));

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-700">
        Physics <ProviderBadge source="real" label="P9 本地分析" />
      </div>
      {!active && <div className="text-zinc-500">先创建动画</div>}
      {active && !names && <div className="text-amber-400">未找到 hips 骨骼，无法分析</div>}
      <button
        onClick={() => check()}
        disabled={busy || !sceneObject || !active || !names}
        className="w-full rounded bg-emerald-600 px-2 py-1.5 text-white disabled:bg-zinc-200 disabled:text-zinc-500"
      >
        {busy ? '分析中…' : '一键检查（重心/支撑/脚滑/关节/环境穿透）'}
      </button>
      {samples.length > 2 && <HeightChart samples={samples} issues={issues ?? []} />}
      {warnings.map((warning, index) => {
        const time = warning.match(/(?:动作约\s*|约\s*)(\d+(?:\.\d+)?)\s*秒/)?.[1];
        return time ? (
          <button key={`${index}:${warning}`} onClick={() => setTime(Math.min(Number(time), active?.duration ?? Number(time)))} className="block w-full text-left text-[11px] text-amber-700 hover:text-amber-900" title="跳转到估算问题时间">
            ⚠ {warning} →
          </button>
        ) : (
          <div key={`${index}:${warning}`} className="text-[11px] text-amber-700">⚠ {warning}</div>
        );
      })}
      {issues && issues.length === 0 && <div className="text-emerald-400">未发现问题 ✓</div>}
      {(issues ?? []).map((issue, i) => (
        <div key={i} className="rounded bg-zinc-100 p-2 text-[11px]">
          <button onClick={() => setTime(issue.t0)} className="text-left text-zinc-800 hover:text-emerald-300" title="跳转到问题时间">
            {issue.message} →
          </button>
          {issue.kind === 'footSlide' && (
            <button onClick={() => fixSlide(issue)} className="mt-1 w-full rounded bg-zinc-200 px-2 py-1 text-zinc-800">
              脚锁修复此段
            </button>
          )}
          {issue.kind === 'jointLimit' && (
            <button onClick={() => fixJointLimit(issue)} className="mt-1 w-full rounded bg-zinc-200 px-2 py-1 text-zinc-800">
              将此段回收到 {issue.limit}° 阈值内
            </button>
          )}
          {issue.kind === 'balance' && (
            <button onClick={() => fixBalance(issue)} className="mt-1 w-full rounded bg-zinc-200 px-2 py-1 text-zinc-800">
              尝试配平（需对应腿部 IK，可撤销）
            </button>
          )}
        </div>
      ))}
      {issues && issues.length > 0 && (
        <div className="flex gap-1">
          {kinds.has('penetration') && (
            <button onClick={fixPenetration} className="flex-1 rounded bg-zinc-200 px-2 py-1">修穿透</button>
          )}
          {kinds.has('accelSpike') && (
            <button onClick={fixAccel} className="flex-1 rounded bg-zinc-200 px-2 py-1">落地缓冲</button>
          )}
        </div>
      )}
      {fixed && <div className="text-[11px] text-emerald-400">{fixed}</div>}
      <div className="text-[11px] text-zinc-500">本地采样分析（30fps）；包含人体与场景代理碰撞、已声明接触/支撑核对。几何与重心仍是近似检查，不是完整物理引擎。</div>
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
    <div className="rounded bg-zinc-100 p-1">
      <div className="mb-0.5 text-[10px] text-zinc-500">髋部高度–时间（{min.toFixed(2)}–{max.toFixed(2)}m）</div>
      <svg width={W} height={H} className="w-full">
        <polyline points={pts} fill="none" stroke="#34d399" strokeWidth="1.5" />
        {issues.filter((i) => i.kind === 'accelSpike').map((s, i) => (
          <circle key={i} cx={(s.t0 / Math.max(dur, 1e-6)) * W} cy={6} r={3} fill="#f87171" />
        ))}
      </svg>
    </div>
  );
}
