import { useViewportStore } from '../../stores/viewportStore';
import { useFootLockStore } from '../../stores/footLockStore';

/** 写实预览：曝光/环境/三点光（仅 viewer 效果，不随 GLB 导出）。 */
export function RenderPanel() {
  const exposure = useViewportStore((s) => s.exposure);
  const envIntensity = useViewportStore((s) => s.envIntensity);
  const keyIntensity = useViewportStore((s) => s.keyIntensity);
  const fillIntensity = useViewportStore((s) => s.fillIntensity);
  const rimIntensity = useViewportStore((s) => s.rimIntensity);
  const hemiIntensity = useViewportStore((s) => s.hemiIntensity);
  const setExposure = useViewportStore((s) => s.setExposure);
  const setEnvIntensity = useViewportStore((s) => s.setEnvIntensity);
  const setKeyIntensity = useViewportStore((s) => s.setKeyIntensity);
  const setFillIntensity = useViewportStore((s) => s.setFillIntensity);
  const setRimIntensity = useViewportStore((s) => s.setRimIntensity);
  const setHemiIntensity = useViewportStore((s) => s.setHemiIntensity);
  const footLockEnabled = useFootLockStore((s) => s.enabled);
  const setFootLockEnabled = useFootLockStore((s) => s.setEnabled);
  const setConfig = useFootLockStore((s) => s.setConfig);
  const groundY = useFootLockStore((s) => s.config.groundY);
  const maxCorrection = useFootLockStore((s) => s.config.maxCorrection);
  const steps = useFootLockStore((s) => s.steps);
  const setSteps = useFootLockStore((s) => s.setSteps);

  const addStep = () => {
    // 默认在角色前方 1m 放一级 0.15m 台阶，便于直接观察
    const last = steps[steps.length - 1];
    setSteps([
      ...steps,
      { id: `step-${steps.length}`, center: [0, (last ? last.center[1] + 0.15 : 0.075), steps.length * 1.2 + 1.2], size: [1.2, 0.15, 0.6] },
    ]);
  };
  const removeStep = (i: number) => setSteps(steps.filter((_, idx) => idx !== i));
  const updateStep = (i: number, patch: { y?: number; z?: number; top?: number }) => {
    setSteps(steps.map((s, idx) => {
      if (idx !== i) return s;
      const size = [...s.size] as number[];
      if (patch.top !== undefined && s.size[1] > 0) {
        size[1] = s.size[1] + (patch.top - (s.center[1] + s.size[1] / 2));
      }
      return {
        ...s,
        center: [s.center[0], patch.y ?? s.center[1], patch.z ?? s.center[2]] as [number, number, number],
        size: size as [number, number, number],
      };
    }));
  };

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="font-bold text-zinc-700">写实预览</div>
      <Slider label="曝光" value={exposure} min={0.3} max={2} step={0.05} onChange={setExposure} />
      <Slider label="环境反射" value={envIntensity} min={0} max={1.5} step={0.05} onChange={setEnvIntensity} />
      <Slider label="主光" value={keyIntensity} min={0} max={5} step={0.1} onChange={setKeyIntensity} />
      <Slider label="补光" value={fillIntensity} min={0} max={3} step={0.1} onChange={setFillIntensity} />
      <Slider label="轮廓光" value={rimIntensity} min={0} max={5} step={0.1} onChange={setRimIntensity} />
      <Slider label="半球光" value={hemiIntensity} min={0} max={2} step={0.05} onChange={setHemiIntensity} />
      <div className="text-[11px] text-zinc-400">ACES 色调映射 + 内置摄影棚环境；只影响预览，不导出。</div>

      <div className="mt-2 space-y-1 border-t border-zinc-200 pt-2">
        <label className="flex items-center gap-2 text-zinc-600">
          <input
            type="checkbox"
            checked={footLockEnabled}
            onChange={(e) => setFootLockEnabled(e.target.checked)}
          />
          足部锁定
          <span className="text-[11px] text-zinc-400">（支撑脚钉地，消除打滑）</span>
        </label>
        {footLockEnabled && (
          <>
            <Slider label="地面高度 (m)" value={groundY} min={-0.5} max={0.5} step={0.01} onChange={(v) => setConfig({ groundY: v })} />
            <Slider label="最大校正 (m)" value={maxCorrection} min={0.1} max={1.2} step={0.05} onChange={(v) => setConfig({ maxCorrection: v })} />

            <div className="mt-1 space-y-1 border-t border-zinc-200 pt-1">
              <div className="flex items-center justify-between">
                <span>台阶/平台</span>
                <button
                  onClick={addStep}
                  className="rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600"
                >
                  + 加一级
                </button>
              </div>
              {steps.length === 0 && <div className="text-[11px] text-zinc-400">无台阶时足部锁定只跟随平面高度。</div>}
              {steps.map((s, i) => (
                <div key={i} className="space-y-0.5 rounded bg-zinc-50 p-1">
                  <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                    <span>第 {i + 1} 级</span>
                    <button onClick={() => updateStep(i, { top: (s.center[1] + s.size[1] / 2) + 0.05 })} className="ml-auto rounded bg-zinc-200 px-1">↑</button>
                    <button onClick={() => updateStep(i, { top: (s.center[1] + s.size[1] / 2) - 0.05 })} className="rounded bg-zinc-200 px-1">↓</button>
                    <button onClick={() => removeStep(i)} className="rounded bg-red-200 px-1 text-red-600">×</button>
                  </div>
                  <MiniSlider label="高度" value={s.center[1]} min={-0.5} max={1.5} step={0.01} onChange={(v) => updateStep(i, { y: v })} />
                  <MiniSlider label="Z 位置" value={s.center[2]} min={-6} max={6} step={0.1} onChange={(v) => updateStep(i, { z: v })} />
                </div>
              ))}
            </div>

            <div className="text-[11px] text-zinc-400">
              支撑相内把脚拉回落点（实测残余约 1–2cm）；有台阶时落点自动吸附到台面。
              手工摆过脚部关键帧的动画建议关闭，否则会覆盖你的姿势。
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MiniSlider({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-zinc-500">
      <span className="w-10 shrink-0">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-600"
      />
      <span className="w-10 shrink-0 text-right font-mono">{value.toFixed(2)}</span>
    </label>
  );
}

function Slider({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label className="block text-zinc-600">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono text-zinc-800">{value.toFixed(2)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-600"
      />
    </label>
  );
}
