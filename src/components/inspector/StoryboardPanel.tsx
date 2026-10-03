import { useEffect, useMemo, useState } from 'react';
import { buildStoryboard, storyboardText } from '../../core/previs/storyboard';
import { useAnimationStore } from '../../stores/animationStore';
import { useCameraStore } from '../../stores/cameraStore';
import { usePrevisStore } from '../../stores/previsStore';
import { useEffectsStore } from '../../stores/effectsStore';
import { useWorldStore } from '../../stores/worldStore';
import { useAgentStore } from '../../stores/agentStore';
import { generateAIStoryboardPrompts } from '../../services/agent/aiStoryboardPrompts';
import { ShotGeneration } from './ShotGeneration';
import { useMotionStore } from '../../stores/motionStore';

export function StoryboardPanel() {
  const mediaApi = useMotionStore((state) => state.baseUrl.replace(/\/+$/, ''));
  const active = useAnimationStore((s) => s.active());
  const cameraKeys = useCameraStore((s) => s.keyframes);
  const allEffects = useEffectsStore((s) => s.events);
  const effects = useMemo(() => allEffects.filter((event) => !event.animationId || event.animationId === active?.id), [allEffects, active?.id]);
  const sceneProps = useWorldStore((s) => s.props);
  const source = usePrevisStore((s) => active ? s.byAnimationId[active.id] : undefined);
  const storyboardLocked = source?.scenePlan?.lockedFields.includes('storyboard') ?? false;
  const provider = useAgentStore((s) => s.provider);
  const configs = useAgentStore((s) => s.configs);
  const keys = useAgentStore((s) => s.keys);
  const saveAIPrompts = usePrevisStore((s) => s.updateStoryboardPrompts);
  const [copied, setCopied] = useState(false);
  const [aiBusy, setAIBusy] = useState(false);
  const [aiError, setAIError] = useState<string | null>(null);
  const [comfyAvailable, setComfyAvailable] = useState<boolean | null>(null);
  const [comfyReason, setComfyReason] = useState('');
  const [vpipeReady, setVpipeReady] = useState<boolean | null>(null);
  const shots = useMemo(() => active ? buildStoryboard(active, source?.segments ?? [], cameraKeys, effects, sceneProps, {
    sourcePrompt: source?.prompt,
    aiDetails: source?.scenePlan?.storyboard?.shots,
    contacts: source?.scenePlan?.contacts ?? source?.contacts,
  }) : [], [active, source, cameraKeys, effects, sceneProps]);
  const text = storyboardText(shots);
  useEffect(() => {
    let live = true;
    let delay = 15000;
    let timer = 0;

    /** @returns 后端是否可达 —— 决定下一轮轮询的间隔 */
    const refresh = async (): Promise<boolean> => {
      let reachable = true;
      try {
        const [comfy, vpipe] = await Promise.all([
          fetch(`${mediaApi}/integrations/comfy/status`).then(async (response) => {
            const value = await response.json() as Record<string, unknown>;
            if (!response.ok) throw new Error(String(value['detail'] ?? 'ComfyUI 状态检查失败'));
            return value;
          }),
          fetch(`${mediaApi}/integrations/vpipe/status`).then(async (response) => {
            const value = await response.json() as Record<string, unknown>;
            if (!response.ok) throw new Error(String(value['detail'] ?? 'V-Pipe 状态检查失败'));
            return value;
          }),
        ]);
        if (!live) return reachable;
        setComfyAvailable(Boolean(comfy['connected'] && comfy['available']));
        setComfyReason(String(comfy['reason'] ?? ''));
        setVpipeReady(Boolean(vpipe['connected']));
      } catch {
        reachable = false;
        if (!live) return reachable;
        setComfyAvailable(false);
        setVpipeReady(false);
      }
      return reachable;
    };

    // 后端不在时必须降频：15s 硬打一次会在无后端环境持续产生跨域失败
    //（浏览器层面的 CORS 错误，catch 拦不住），控制台被刷屏。
    // 实测修正前：t=5s 4 条 → t=65s 20 条，线性增长。
    const schedule = () => {
      timer = window.setTimeout(() => {
        void refresh().then((reachable) => {
          delay = reachable ? 15000 : 60000;
          schedule();
        });
      }, delay);
    };

    void refresh().then((reachable) => {
      delay = reachable ? 15000 : 60000;
      schedule();
    });
    return () => { live = false; window.clearTimeout(timer); };
  }, [mediaApi]);
  const polishWithAI = async () => {
    if (!active || provider === 'mock') {
      setAIError('请先在顶部 AI 栏连接一个真实模型通道，再生成分镜提示词');
      return;
    }
    setAIBusy(true);
    setAIError(null);
    try {
      const details = await generateAIStoryboardPrompts(shots, source?.prompt ?? active.name, {
        kind: provider, ...configs[provider], apiKey: keys[provider] ?? '',
      });
      const currentlyLocked = usePrevisStore.getState().byAnimationId[active.id]?.scenePlan?.lockedFields.includes('storyboard') ?? false;
      if (!currentlyLocked) useAnimationStore.getState().checkpoint();
      saveAIPrompts(active.id, details);
    } catch (error) {
      setAIError(error instanceof Error ? error.message : 'AI 分镜提示词生成失败');
    } finally {
      setAIBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  if (!active) return null;
  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="font-bold text-zinc-700">生成视频分镜</div>
      <div className="text-[11px] text-zinc-500">基于动作、蓝色镜头关键帧和特效事件整理；ComfyUI 用于视觉参考，vpipe 用于视频生成。</div>
      <div className="max-h-52 space-y-2 overflow-auto rounded bg-zinc-50 p-2">
        {shots.map((shot) => <div key={shot.index} className="border-b border-zinc-200 pb-2 last:border-0 last:pb-0">
          <div className="font-medium text-zinc-700">镜头 {shot.index} · {shot.t0.toFixed(1)}–{shot.t1.toFixed(1)}s · {shot.shot}</div>
          {shot.scene && <div className="text-zinc-500">场景：{shot.scene}</div>}<div className="text-zinc-600">{shot.action}</div>{shot.effects && <div className="text-amber-700">{shot.effects}</div>}<div className="text-sky-700">{shot.camera}</div>
          <ShotGeneration shot={shot} comfyAvailable={comfyAvailable} comfyReason={comfyReason} vpipeReady={vpipeReady} />
        </div>)}
      </div>
      <button onClick={() => void polishWithAI()} disabled={aiBusy || shots.length === 0 || provider === 'mock' || storyboardLocked} className="w-full rounded bg-sky-600 px-2 py-1.5 text-white disabled:bg-zinc-200 disabled:text-zinc-500">
        {storyboardLocked ? '分镜提示词已锁定' : aiBusy ? 'AI 正在补全视觉与连续性…' : source?.scenePlan?.storyboard ? 'AI 重新优化镜头提示词' : 'AI 优化视觉与角色连续性'}
      </button>
      {storyboardLocked && <div className="text-[11px] text-amber-700">解锁“分镜提示词”后，AI 才能改写风格与跨镜头连续性。</div>}
      {aiError && <div role="alert" className="text-[11px] text-red-600">{aiError}</div>}
      <button onClick={() => void copy()} className="w-full rounded bg-emerald-600 px-2 py-1.5 text-white">{copied ? '已复制提示词包' : '复制 ComfyUI + vpipe 提示词包'}</button>
      {!source && <div className="text-[11px] text-amber-600">当前动画没有动作语义记录，已按完整动作段生成；重新执行“一句话预演”可得到更细的分镜。</div>}
    </div>
  );
}
