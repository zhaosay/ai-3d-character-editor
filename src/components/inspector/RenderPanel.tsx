import { useViewportStore } from '../../stores/viewportStore';

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
    </div>
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
