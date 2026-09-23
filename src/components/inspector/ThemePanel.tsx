import { useState } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { useThemeStore } from '../../stores/themeStore';
import { useViewportStore } from '../../stores/viewportStore';
import { isThemable, setThemeColor } from '../../core/theme/theme';
import { ProviderBadge } from '../ai/ProviderBadge';

/** 主题面板：人物肤色/服装（仅示例角色）+ 骨骼/网格/阴影显示设置。 */
export function ThemePanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const skin = useThemeStore((s) => s.skin);
  const cloth = useThemeStore((s) => s.cloth);
  const nativeSkin = useThemeStore((s) => s.nativeSkin);
  const nativeCloth = useThemeStore((s) => s.nativeCloth);
  const setSkin = useThemeStore((s) => s.setSkin);
  const setCloth = useThemeStore((s) => s.setCloth);
  const [error, setError] = useState<string | null>(null);

  const showSkeleton = useViewportStore((s) => s.showSkeleton);
  const showGrid = useViewportStore((s) => s.showGrid);
  const shadows = useViewportStore((s) => s.shadows);
  const toggleSkeleton = useViewportStore((s) => s.toggleSkeleton);
  const toggleGrid = useViewportStore((s) => s.toggleGrid);
  const toggleShadows = useViewportStore((s) => s.toggleShadows);
  const skeletonColor = useViewportStore((s) => s.skeletonColor);
  const setSkeletonColor = useViewportStore((s) => s.setSkeletonColor);
  const gridSize = useViewportStore((s) => s.gridSize);
  const setGridSize = useViewportStore((s) => s.setGridSize);
  const gridCell = useViewportStore((s) => s.gridCell);
  const setGridCell = useViewportStore((s) => s.setGridCell);
  const gridSection = useViewportStore((s) => s.gridSection);
  const setGridSection = useViewportStore((s) => s.setGridSection);
  const shadowOpacity = useViewportStore((s) => s.shadowOpacity);
  const setShadowOpacity = useViewportStore((s) => s.setShadowOpacity);
  const setExposure = useViewportStore((s) => s.setExposure);
  const setEnvIntensity = useViewportStore((s) => s.setEnvIntensity);
  const setKeyIntensity = useViewportStore((s) => s.setKeyIntensity);
  const setFillIntensity = useViewportStore((s) => s.setFillIntensity);
  const setRimIntensity = useViewportStore((s) => s.setRimIntensity);
  const setHemiIntensity = useViewportStore((s) => s.setHemiIntensity);

  const themable = !!sceneObject && isThemable(sceneObject);

  const applySkin = (hex: string) => {
    if (!sceneObject) return;
    try {
      setThemeColor(sceneObject, 'skin', hex);
      setSkin(hex);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置失败');
    }
  };

  const applyCloth = (hex: string) => {
    if (!sceneObject) return;
    try {
      setThemeColor(sceneObject, 'cloth', hex);
      setCloth(hex);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置失败');
    }
  };

  const resetAll = () => {
    if (sceneObject && themable) {
      try {
        setThemeColor(sceneObject, 'skin', nativeSkin);
        setThemeColor(sceneObject, 'cloth', nativeCloth);
        setSkin(nativeSkin);
        setCloth(nativeCloth);
      } catch (e) {
        setError(e instanceof Error ? e.message : '重置失败');
      }
    }
    setSkeletonColor('#ffffff');
    setGridSize(30);
    setGridCell('#d9dfe7');
    setGridSection('#a9b4c2');
    setShadowOpacity(0.35);
    setExposure(1.0);
    setEnvIntensity(0.45);
    setKeyIntensity(2.0);
    setFillIntensity(0.5);
    setRimIntensity(1.2);
    setHemiIntensity(0.5);
    setError(null);
  };

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-800">
        主题 <ProviderBadge source="real" label="人物+显示" />
        <button onClick={resetAll} title="恢复默认主题" className="ml-auto rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600">
          重置
        </button>
      </div>

      <div className="space-y-1">
        <div className="font-bold text-zinc-600">人物</div>
        {!sceneObject && <div className="text-zinc-400">先加载角色</div>}
        {sceneObject && !themable && <div className="text-zinc-400">外部模型不支持换肤（仅示例男/女角色）</div>}
        {themable && (
          <>
            <ColorRow label="肤色" value={skin} onChange={applySkin} />
            <ColorRow label="服装" value={cloth} onChange={applyCloth} />
          </>
        )}
      </div>

      <div className="space-y-1">
        <div className="font-bold text-zinc-600">骨骼</div>
        <label className="flex items-center gap-2 text-zinc-600">
          <input type="checkbox" checked={showSkeleton} onChange={toggleSkeleton} />
          显示骨骼
        </label>
        <ColorRow label="颜色" value={skeletonColor} onChange={setSkeletonColor} hint="白色=原色" />
      </div>

      <div className="space-y-1">
        <div className="font-bold text-zinc-600">网格</div>
        <label className="flex items-center gap-2 text-zinc-600">
          <input type="checkbox" checked={showGrid} onChange={toggleGrid} />
          显示网格
        </label>
        <label className="flex items-center gap-2 text-zinc-600">
          <span className="w-10">大小</span>
          <select value={gridSize} onChange={(e) => setGridSize(Number(e.target.value))} className="rounded bg-white px-1 py-0.5 outline-none ring-1 ring-zinc-300">
            {[10, 20, 30, 50].map((n) => (
              <option key={n} value={n}>{n}m</option>
            ))}
          </select>
        </label>
        <ColorRow label="细线" value={gridCell} onChange={setGridCell} />
        <ColorRow label="粗线" value={gridSection} onChange={setGridSection} />
      </div>

      <div className="space-y-1">
        <div className="font-bold text-zinc-600">阴影</div>
        <label className="flex items-center gap-2 text-zinc-600">
          <input type="checkbox" checked={shadows} onChange={toggleShadows} />
          开启阴影
        </label>
        <label className="block text-zinc-600">
          <div className="flex justify-between">
            <span>强度</span>
            <span className="font-mono text-zinc-800">{shadowOpacity.toFixed(2)}</span>
          </div>
          <input
            type="range" min={0} max={0.8} step={0.05} value={shadowOpacity}
            onChange={(e) => setShadowOpacity(Number(e.target.value))}
            className="w-full accent-emerald-600"
          />
        </label>
      </div>

      {error && <div className="text-red-500">{error}</div>}
    </div>
  );
}

function ColorRow({ label, value, onChange, hint }: { label: string; value: string; onChange: (hex: string) => void; hint?: string }) {
  return (
    <label className="flex items-center gap-2 text-zinc-600">
      <span className="w-10">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-10 cursor-pointer rounded bg-white ring-1 ring-zinc-300"
      />
      <span className="font-mono">{value}</span>
      {hint && <span className="text-[11px] text-zinc-400">{hint}</span>}
    </label>
  );
}
