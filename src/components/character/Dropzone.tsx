import { useCallback, useState } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { isLoadableUrl, loadGltfFile, loadGltfUrl, type LoadedCharacter } from '../../services/loader/loadGltf';
import { buildDemoCharacter, type DemoGender } from '../../services/demo/buildDemoCharacter';
import { activateCharacter } from './activateCharacter';

/** 在线真人预设（运行时下载，本仓库不做分发） */
export const REMOTE_PRESETS = [
  {
    id: 'soldier',
    label: '真人男',
    hint: 'Soldier（Mixamo 骨架，真人比例，在线 2MB）',
    url: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r186/examples/models/gltf/Soldier.glb',
  },
] as const;

/** 仓库内置（public/samples，随构建发布，离线可用） */
export const BUNDLED_PRESETS = [
  {
    id: 'cesiumman',
    label: 'CesiumMan',
    hint: 'Cesium Man by Cesium（CC-BY-4.0，内置离线）',
    path: 'samples/CesiumMan.glb',
  },
] as const;

async function loadBundled(path: string) {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!res.ok) throw new Error(`内置模型加载失败 HTTP ${res.status}`);
  const blob = await res.blob();
  const name = path.split('/').pop() ?? 'sample.glb';
  return loadGltfFile(new File([blob], name, { type: 'model/gltf-binary' }));
}

export function Dropzone({ compact = false }: { compact?: boolean }) {
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [rpmUrl, setRpmUrl] = useState('');
  const setError = useCharacterStore((s) => s.setError);
  const error = useCharacterStore((s) => s.error);

  const run = useCallback(
    async (label: string, task: () => Promise<LoadedCharacter>) => {
      setLoading(true);
      setBusyLabel(label);
      setError(null);
      try {
        const loaded = await task();
        activateCharacter(loaded.meta, loaded.scene, loaded.dispose);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
        setBusyLabel(null);
      }
    },
    [setError],
  );

  const handleFile = useCallback(
    (file: File) => void run(file.name, () => loadGltfFile(file)),
    [run],
  );

  const handleDemo = useCallback(
    (gender: DemoGender) =>
      void run(gender === 'female' ? '示例女' : '示例男', () => {
        const demo = buildDemoCharacter(gender);
        return Promise.resolve(demo);
      }),
    [run],
  );

  const handlePreset = useCallback(
    (preset: (typeof REMOTE_PRESETS)[number]) => void run(preset.label, () => loadGltfUrl(preset.url)),
    [run],
  );

  const handleBundled = useCallback(
    (preset: (typeof BUNDLED_PRESETS)[number]) => void run(preset.label, () => loadBundled(preset.path)),
    [run],
  );

  const handleRpm = useCallback(() => {
    const url = rpmUrl.trim();
    if (!isLoadableUrl(url)) {
      setError('请输入以 .glb 结尾的 http(s) 链接');
      return;
    }
    void run('RPM 真人', () => loadGltfUrl(url));
  }, [rpmUrl, run, setError]);

  const btn =
    'rounded px-1.5 py-1 text-[11px] text-white disabled:opacity-50 disabled:cursor-wait';
  const busy = (label: string) => (loading && busyLabel === label ? '…' : '');

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
      className={`${compact ? 'p-2' : 'p-6'} rounded border border-dashed text-center transition-colors ${
        dragOver ? 'border-emerald-400 bg-emerald-400/10' : 'border-zinc-300 bg-zinc-100/70'
      }`}
    >
      <input
        type="file"
        accept=".glb,.gltf"
        className="hidden"
        id="char-upload"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = '';
        }}
      />
      <label htmlFor="char-upload" className="cursor-pointer text-sm text-zinc-700">
        {loading ? `加载中${busyLabel ?? ''}…` : '拖拽 .glb / .gltf 到此，或点击选择'}
      </label>

      <div className="mt-2 text-left text-[11px] font-bold text-zinc-500">真人（Mixamo 兼容骨架）</div>
      <div className="mt-1 grid grid-cols-2 gap-1">
        {REMOTE_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => handlePreset(p)}
            disabled={loading}
            title={`${p.hint}：${p.url}`}
            className={`${btn} bg-sky-700 hover:bg-sky-600`}
          >
            {p.label}{busy(p.label)}
          </button>
        ))}
        {BUNDLED_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => handleBundled(p)}
            disabled={loading}
            title={p.hint}
            className={`${btn} bg-teal-700 hover:bg-teal-600`}
          >
            {p.label}{busy(p.label)}
          </button>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        <input
          value={rpmUrl}
          onChange={(e) => setRpmUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRpm();
          }}
          placeholder="粘贴 RPM .glb 链接（demo.readyplayer.me 免费创建）"
          title="去 demo.readyplayer.me 免费捏真人（男/女自选），复制 .glb 链接粘贴到此"
          className="min-w-0 flex-1 rounded bg-white px-1.5 py-1 font-mono text-[11px] text-zinc-700 outline-none ring-1 ring-zinc-300 placeholder:text-zinc-400"
        />
        <button onClick={handleRpm} disabled={loading || !rpmUrl.trim()} className={`${btn} bg-sky-700 hover:bg-sky-600`}>
          加载
        </button>
      </div>

      <div className="mt-2 text-left text-[11px] font-bold text-zinc-500">木偶（离线程序化）</div>
      <div className="mt-1 flex gap-1">
        <button
          onClick={() => handleDemo('male')}
          disabled={loading}
          title="男武侠人物：宽肩，束发"
          className={`${btn} flex-1 bg-emerald-700 hover:bg-emerald-600`}
        >
          木偶男{busy('示例男')}
        </button>
        <button
          onClick={() => handleDemo('female')}
          disabled={loading}
          title="女武侠人物：长发髻"
          className={`${btn} flex-1 bg-rose-700 hover:bg-rose-600`}
        >
          木偶女{busy('示例女')}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-500">{error}</div>}
    </div>
  );
}
