import { useEffect, useRef, useState } from 'react';
import { Dropzone } from '../character/Dropzone';
import { SkeletonTree } from '../skeleton/SkeletonTree';
import { ViewportCanvas } from '../viewport/ViewportCanvas';
import { ViewportHUD } from '../viewport/ViewportHUD';
import { ScrubApplier } from '../viewport/PlaybackEngine';
import { BoneDetails } from '../inspector/BoneDetails';
import { ThemePanel } from '../inspector/ThemePanel';
import { TransformPanel } from '../inspector/TransformPanel';
import { IKPanel } from '../inspector/IKPanel';
import { AutoPosePanel } from '../inspector/AutoPosePanel';
import { Timeline } from '../timeline/Timeline';
import { MotionPanel } from '../ai/MotionPanel';
import { InbetweenPanel } from '../ai/InbetweenPanel';
import { PhysicsPanel } from '../ai/PhysicsPanel';
import { AgentPanel } from '../ai/AgentPanel';
import { ProviderBadge } from '../ai/ProviderBadge';
import { useAnimationStore } from '../../stores/animationStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useSkeletonStore } from '../../stores/skeletonStore';
import { useViewportStore } from '../../stores/viewportStore';
import { checkCharacterBind, parseProjectFile, serializeProject } from '../../core/project/serialize';
import type { ProjectV1 } from '../../core/project/schema';
import { exportGltf } from '../../services/export/exportGltf';

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function ToolbarActions() {
  const undo = useAnimationStore((s) => s.undo);
  const redo = useAnimationStore((s) => s.redo);
  const pastLen = useHistoryStore((s) => s.past.length);
  const futureLen = useHistoryStore((s) => s.future.length);
  const openRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const doNew = () => {
    useAnimationStore.getState().clearProject();
    setMsg('已新建空项目（角色保留）');
  };

  const doSave = () => {
    const anim = useAnimationStore.getState();
    const project: ProjectV1 = {
      version: '1.0',
      character: useCharacterStore.getState().meta,
      skeleton: useSkeletonStore.getState().snapshot,
      animations: anim.animations,
      scene: {
        bg: '#0b0d12',
        grid: useViewportStore.getState().showGrid,
        shadows: useViewportStore.getState().shadows,
      },
      camera: { position: [2.5, 1.8, 3.2], target: [0, 1, 0], fov: 45 },
      settings: { fps: 30, loop: anim.loop },
    };
    downloadText('project.json', serializeProject(project));
    setMsg(`已保存 project.json（${project.animations.length} 个动画）`);
  };

  const doOpen = async (f: File) => {
    setBusy(true);
    try {
      const { project, warnings } = parseProjectFile(await f.text());
      useAnimationStore.getState().replaceAll(project.animations, project.animations[0]?.id ?? null);
      useViewportStore.setState({ showGrid: project.scene.grid, shadows: project.scene.shadows });
      useAnimationStore.setState({ loop: project.settings.loop });
      const bind = checkCharacterBind(useCharacterStore.getState().meta, project);
      const parts = [`已打开 ${f.name}（${project.animations.length} 个动画）`];
      if (bind === 'match') parts.push('角色匹配');
      else if (project.character) parts.push(`请拖入原角色 ${project.character.fileName} 后应用动画`);
      else parts.push('项目无角色记录，直接拖入 GLB 即可');
      parts.push(...warnings);
      setMsg(parts.join('；'));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '打开失败');
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    const so = useCharacterStore.getState().sceneObject;
    const meta = useCharacterStore.getState().meta;
    const anims = useAnimationStore.getState().animations;
    if (!so || !meta) {
      setMsg('请先加载角色再导出');
      return;
    }
    setBusy(true);
    try {
      const r = await exportGltf(so, anims, meta.fileName);
      setMsg([`已导出 ${r.fileName}（${r.clipCount} 个 clip，可拖回验证）`, ...r.warnings].join('；'));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '导出失败');
    } finally {
      setBusy(false);
    }
  };

  const btn = 'rounded bg-zinc-200 px-2 py-1 hover:bg-zinc-200 disabled:opacity-50';
  return (
    <div className="ml-auto flex min-w-0 items-center gap-1 text-xs">
      {msg && <span className="mr-1 max-w-72 truncate text-zinc-600" title={msg}>{msg}</span>}
      <button onClick={doNew} className={btn}>New</button>
      <button onClick={() => openRef.current?.click()} disabled={busy} className={btn}>Open</button>
      <input ref={openRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void doOpen(f);
        e.target.value = '';
      }} />
      <button onClick={doSave} className={btn}>Save</button>
      <button onClick={() => void doExport()} disabled={busy} className={btn}>Export</button>
      <button onClick={undo} disabled={pastLen === 0} title="撤销" className={btn}>Undo</button>
      <button onClick={redo} disabled={futureLen === 0} title="重做" className={btn}>Redo</button>
    </div>
  );
}

export function EditorShell() {
  // Inspector 改为悬浮弹窗：不挤压视口，右上 ✕ 关闭后变悬浮按钮
  const [inspectorOpen, setInspectorOpen] = useState(true);
  // 全局快捷键：空格=播放/暂停，Ctrl+Z=撤销，Ctrl+Y/Ctrl+Shift+Z=重做（输入框内不触发）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const anim = useAnimationStore.getState();
      if (e.code === 'Space') {
        e.preventDefault();
        if (anim.active()) anim.setPlaying(!anim.playing);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) anim.redo();
        else anim.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        anim.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full flex-col bg-white text-zinc-800">
      <ScrubApplier />
      {/* Toolbar */}
      <header className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2">
        <span className="text-sm font-bold text-zinc-900">AI 3D Character Animation Editor</span>
        <ProviderBadge source="real" label="P10 Agent" />
        <ToolbarActions />
      </header>

      {/* AI 命令条（顶部） */}
      <AgentPanel />

      {/* Main */}
      <div className="relative flex min-h-0 flex-1">
        {/* Left */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white">
          <div className="border-b border-zinc-200 p-2">
            <Dropzone compact />
          </div>
          <div className="border-b border-zinc-200 px-3 py-1.5 text-xs font-bold text-zinc-600">Skeleton Explorer</div>
          <div className="min-h-0 flex-1">
            <SkeletonTree />
          </div>
        </aside>

        {/* Viewport */}
        <main className="flex min-w-0 flex-1 flex-col">
          <ViewportHUD />
          <div className="min-h-0 flex-1">
            <ViewportCanvas />
          </div>
          <Timeline />
        </main>

        {/* Right：悬浮 Inspector */}
        {inspectorOpen ? (
          <aside className="absolute top-2 right-2 bottom-2 z-20 flex w-72 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl">
            <div className="flex items-center border-b border-zinc-200 px-3 py-1.5 text-xs font-bold text-zinc-600">
              Inspector
              <button onClick={() => setInspectorOpen(false)} title="关闭面板（视口右上可重新打开）" className="ml-auto rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <ThemePanel />
              <TransformPanel />
              <IKPanel />
              <AutoPosePanel />
              <MotionPanel />
              <InbetweenPanel />
              <PhysicsPanel />
              <BoneDetails />
            </div>
          </aside>
        ) : (
          <button
            onClick={() => setInspectorOpen(true)}
            title="打开 Inspector"
            className="absolute top-2 right-2 z-20 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-600 shadow-lg hover:bg-zinc-50"
          >
            🛠 Inspector
          </button>
        )}
      </div>

      {/* StatusBar */}
      <footer className="flex items-center gap-3 border-t border-zinc-200 bg-white px-3 py-1 text-[11px] text-zinc-500">
        <span>P10: 全功能 REAL（Agent Tool Calling）</span>
        <span>快捷键：空格播放/暂停 · Ctrl+Z 撤销 · Ctrl+Y 重做</span>
      </footer>
    </div>
  );
}
