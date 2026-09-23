import { useCallback, useState } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { loadGltfFile } from '../../services/loader/loadGltf';
import { buildDemoCharacter, type DemoGender } from '../../services/demo/buildDemoCharacter';
import { activateCharacter } from './activateCharacter';

export function Dropzone({ compact = false }: { compact?: boolean }) {
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const setError = useCharacterStore((s) => s.setError);
  const error = useCharacterStore((s) => s.error);

  const handleFile = useCallback(
    async (file: File) => {
      setLoading(true);
      setError(null);
      try {
        const loaded = await loadGltfFile(file);
        activateCharacter(loaded.meta, loaded.scene, loaded.dispose);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [setError],
  );

  const handleDemo = useCallback((gender: DemoGender) => {
    setLoading(true);
    setError(null);
    try {
      const demo = buildDemoCharacter(gender);
      activateCharacter(demo.meta, demo.scene, demo.dispose);
    } catch (e) {
      setError(e instanceof Error ? e.message : '示例角色构建失败');
    } finally {
      setLoading(false);
    }
  }, [setError]);

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
        if (f) void handleFile(f);
      }}
      className={`${compact ? 'p-2' : 'p-6'} rounded border border-dashed text-center cursor-pointer transition-colors ${
        dragOver ? 'border-emerald-400 bg-emerald-400/10' : 'border-zinc-700 bg-zinc-900/50'
      }`}
    >
      <input
        type="file"
        accept=".glb,.gltf"
        className="hidden"
        id="char-upload"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      <label htmlFor="char-upload" className="cursor-pointer text-sm text-zinc-300">
        {loading ? '加载中…' : '拖拽 .glb / .gltf 到此，或点击选择'}
      </label>
      <div className="mt-2 flex gap-1">
        <button
          onClick={() => handleDemo('male')}
          disabled={loading}
          title="男武侠木偶：宽肩窄臀，束发"
          className="flex-1 rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          示例男角色
        </button>
        <button
          onClick={() => handleDemo('female')}
          disabled={loading}
          title="女武侠木偶：窄肩宽臀，长发髻"
          className="flex-1 rounded bg-rose-700 px-2 py-1 text-xs text-white hover:bg-rose-600 disabled:opacity-50"
        >
          示例女角色
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
    </div>
  );
}
