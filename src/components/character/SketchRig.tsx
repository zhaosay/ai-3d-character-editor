import { useEffect, useRef, useState } from 'react';
import {
  LANDMARK_LABELS,
  LANDMARK_ORDER,
  SKETCH_H,
  SKETCH_W,
  STANDARD_SKETCH_POSE,
  clampSketchPointToCanvas,
  clientToSketchPoint,
  findSketchPointHit,
  restoreSketchDraft,
  type SketchSourceData,
  type SketchPoint,
  validateSketchLandmarks,
} from '../../core/rig/sketchToSpec';
import { buildSketchCharacter } from '../../services/sketch/buildSketchCharacter';
import { createSketchHistoryAppender, type SketchHistorySnapshot } from '../../core/rig/sketchHistory';
import { useCharacterStore } from '../../stores/characterStore';
import { activateCharacter } from './activateCharacter';
import { useSketchStore } from '../../stores/sketchStore';

const LINKS: Array<[number, number]> = [
  [0, 1], [1, 5], [1, 2], [2, 3], [3, 4], [5, 6], [6, 7],
];

function mirrorX(x: number): number {
  return SKETCH_W - x;
}

/** ✏️ 手绘捏人：画布上按顺序点 8 个关节点，生成带骨骼的 3D 角色（右侧自动镜像）。 */
export function SketchRig() {
  const sketchSource = useCharacterStore((state) => state.meta?.sketchSource ?? null);
  const restoreVersion = useSketchStore((state) => state.restoreVersion);
  const sourceKey = `${sketchSource ? JSON.stringify(sketchSource) : 'new-draft'}:${restoreVersion}`;
  return <SketchRigEditor key={sourceKey} sketchSource={sketchSource} savedDraft={useSketchStore.getState().draft} />;
}

function SketchRigEditor({ sketchSource, savedDraft }: { sketchSource: SketchSourceData | null; savedDraft: ReturnType<typeof restoreSketchDraft> | null }) {
  const initialDraft = savedDraft ?? (sketchSource ? restoreSketchDraft(sketchSource) : null);
  const initialPoints = initialDraft?.points ?? Array<SketchPoint | null>(8).fill(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingIndex = useRef<number | null>(null);
  const dragStartPoints = useRef<Array<SketchPoint | null> | null>(null);
  const dragStartOptions = useRef({ ...(initialDraft?.options ?? { headR: 0.115, thickness: 1 }) });
  const pointsRef = useRef(initialPoints);
  const optionsRef = useRef(initialDraft?.options ?? { headR: 0.115, thickness: 1 });
  const optionEditStart = useRef<SketchHistorySnapshot | null>(null);
  const optionEditTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [points, setPoints] = useState(initialPoints);
  const [past, setPast] = useState<SketchHistorySnapshot[]>([]);
  const [future, setFuture] = useState<SketchHistorySnapshot[]>([]);
  const [headR, setHeadR] = useState(initialDraft?.options.headR ?? 0.115);
  const [thickness, setThickness] = useState(initialDraft?.options.thickness ?? 1);
  const [editIndex, setEditIndex] = useState(Math.max(0, initialPoints.findIndex((point) => !point)));
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const nextIndex = points.findIndex((p) => !p);
  const completeLandmarks = Object.fromEntries(LANDMARK_ORDER.flatMap((key, i) => points[i] ? [[key, points[i]!]] : []));
  const pointIssues = nextIndex < 0 ? validateSketchLandmarks(completeLandmarks) : [];

  const setCurrentPoints = (next: Array<SketchPoint | null>) => {
    pointsRef.current = next;
    setPoints(next);
    setWarnings([]);
    useSketchStore.getState().updateDraft({ points: next, options: { ...optionsRef.current } });
  };

  const currentSnapshot = (): SketchHistorySnapshot => ({
    points: structuredClone(pointsRef.current),
    options: { ...optionsRef.current },
  });

  const applySnapshot = (snapshot: SketchHistorySnapshot) => {
    pointsRef.current = structuredClone(snapshot.points);
    optionsRef.current = { ...snapshot.options };
    setPoints(pointsRef.current);
    setHeadR(snapshot.options.headR);
    setThickness(snapshot.options.thickness);
    setWarnings([]);
    useSketchStore.getState().updateDraft(structuredClone(snapshot));
  };

  const beginOptionEdit = () => {
    if (!optionEditStart.current) optionEditStart.current = currentSnapshot();
  };

  const finishOptionEdit = () => {
    if (optionEditTimer.current) clearTimeout(optionEditTimer.current);
    optionEditTimer.current = null;
    const start = optionEditStart.current;
    optionEditStart.current = null;
    if (!start || JSON.stringify(start) === JSON.stringify(currentSnapshot())) return;
    setPast(createSketchHistoryAppender(start));
    setFuture([]);
  };

  const commitPoints = (next: Array<SketchPoint | null>) => {
    if (JSON.stringify(pointsRef.current) === JSON.stringify(next)) return;
    const appendStart = createSketchHistoryAppender(currentSnapshot());
    setPast(appendStart);
    setFuture([]);
    setCurrentPoints(next);
    setError(null);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, SKETCH_W, SKETCH_H);
    // 背景 + 中线
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, SKETCH_W, SKETCH_H);
    ctx.strokeStyle = '#e2e8f0';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(SKETCH_W / 2, 0);
    ctx.lineTo(SKETCH_W / 2, SKETCH_H);
    ctx.stroke();
    ctx.setLineDash([]);
    // 已知连线（实线）+ 镜像（虚线）
    const dot = (i: number, ghost: boolean) => {
      const p = points[i];
      if (!p) return null;
      const visible = clampSketchPointToCanvas(p);
      return ghost ? { x: mirrorX(visible.x), y: visible.y } : visible;
    };
    ctx.lineWidth = 2;
    for (const ghost of [false, true]) {
      ctx.strokeStyle = ghost ? '#cbd5e1' : '#34d399';
      if (ghost) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      let started = false;
      for (const [a, b] of LINKS) {
        const pa = dot(a, ghost);
        const pb = dot(b, ghost);
        if (!pa || !pb) continue;
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        started = true;
      }
      if (started) ctx.stroke();
      ctx.setLineDash([]);
    }
    // 标准站姿虚线参考，让用户知道每个点应该落在哪里。
    points.forEach((p, i) => {
      if (p) return;
      const key = LANDMARK_ORDER[i];
      const ref = STANDARD_SKETCH_POSE[key];
      ctx.strokeStyle = '#cbd5e1';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(ref.x, ref.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(i + 1), ref.x + 8, ref.y - 4);
    });
    // 点 + 序号
    points.forEach((p, i) => {
      if (!p) return;
      const visible = clampSketchPointToCanvas(p);
      ctx.fillStyle = i === draggingIndex.current || i === editIndex ? '#f97316' : '#059669';
      ctx.beginPath();
      ctx.arc(visible.x, visible.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), visible.x, visible.y);
    });
    // 下一个点提示
    if (nextIndex >= 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`点 ${nextIndex + 1}/8：${LANDMARK_LABELS[LANDMARK_ORDER[nextIndex]]}`, 10, 18);
    } else {
      ctx.fillStyle = '#059669';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('描点完成，可以生成！', 10, 18);
    }
  }, [points, nextIndex, editIndex]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): SketchPoint | null => {
    return clientToSketchPoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointFromEvent(e);
    if (!point) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const hitIndex = findSketchPointHit(pointsRef.current, point, rect);
    if (hitIndex !== null) {
      draggingIndex.current = hitIndex;
      setEditIndex(hitIndex);
      dragStartPoints.current = structuredClone(pointsRef.current);
      dragStartOptions.current = { ...optionsRef.current };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const targetIndex = editIndex < pointsRef.current.length ? editIndex : nextIndex;
    if (targetIndex < 0) return;
    const next = [...pointsRef.current];
    next[targetIndex] = point;
    commitPoints(next);
    const unplacedIndex = next.findIndex((candidate) => !candidate);
    setEditIndex(unplacedIndex >= 0 ? unplacedIndex : targetIndex);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const index = draggingIndex.current;
    if (index === null) return;
    const point = pointFromEvent(e);
    if (!point) return;
    const next = pointsRef.current.map((p, i) => i === index ? point : p);
    pointsRef.current = next;
    setPoints(next);
    setWarnings([]);
    setError(null);
    useSketchStore.getState().updateDraft({ points: next, options: { headR, thickness } });
  };

  const onPointerUp = () => {
    const startPoints = dragStartPoints.current;
    if (draggingIndex.current !== null && startPoints
      && JSON.stringify(startPoints) !== JSON.stringify(pointsRef.current)) {
      const appendStart = createSketchHistoryAppender({ points: startPoints, options: dragStartOptions.current });
      setPast(appendStart);
      setFuture([]);
    }
    draggingIndex.current = null;
    dragStartPoints.current = null;
  };

  const undo = () => {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture([currentSnapshot(), ...future].slice(0, 50));
    applySnapshot(previous);
    setEditIndex(previous.points.findIndex((point) => !point) >= 0 ? previous.points.findIndex((point) => !point) : 0);
    setError(null);
  };

  const redo = () => {
    if (future.length === 0) return;
    const next = future[0];
    setPast(createSketchHistoryAppender(currentSnapshot())(past));
    setFuture(future.slice(1));
    applySnapshot(next);
    setEditIndex(next.points.findIndex((point) => !point) >= 0 ? next.points.findIndex((point) => !point) : 0);
    setError(null);
  };

  const clear = () => {
    if (pointsRef.current.every((point) => point === null)) return;
    commitPoints(Array(8).fill(null));
    setEditIndex(0);
    setWarnings([]);
    setError(null);
  };

  const loadStandardPose = () => {
    commitPoints(LANDMARK_ORDER.map((key) => ({ ...STANDARD_SKETCH_POSE[key] })));
    setWarnings([]);
    setError(null);
  };

  const generate = () => {
    setError(null);
    setWarnings([]);
    try {
      if (pointIssues.length > 0) throw new Error(pointIssues[0]);
      const record: Record<string, SketchPoint> = {};
      LANDMARK_ORDER.forEach((k, i) => {
        if (points[i]) record[k] = points[i]!;
      });
      const built = buildSketchCharacter(record, { headR, thickness });
      useSketchStore.getState().updateDraft({ points, options: { headR, thickness } });
      activateCharacter(built.meta, built.scene, built.dispose);
      setWarnings(built.warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
    }
  };

  return (
    <div className="border-b border-zinc-200">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center px-3 py-1.5 text-xs font-bold text-zinc-600"
      >
        <span className="text-zinc-400">{open ? '▾' : '▸'}</span> ✏️ 手绘捏人
        <span className="ml-auto font-normal text-zinc-400">{points.filter(Boolean).length}/8</span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          <canvas
            ref={canvasRef}
            width={SKETCH_W}
            height={SKETCH_H}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className="sketch-rig-canvas w-full touch-none cursor-crosshair rounded ring-1 ring-zinc-300"
            style={{ aspectRatio: `${SKETCH_W} / ${SKETCH_H}` }}
            title="按顺序点击关节点；拖动已标记的点可调整位置"
          />
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 rounded bg-zinc-50 p-1 text-[10px] text-zinc-500">
            {LANDMARK_ORDER.map((key, i) => (
              <button
                key={key}
                type="button"
                aria-pressed={editIndex === i}
                onClick={() => setEditIndex(i)}
                className={`rounded px-1 py-0.5 text-left ${editIndex === i ? 'bg-orange-100 font-bold text-orange-800' : points[i] ? 'text-emerald-600' : 'text-zinc-500'}`}
                title={points[i] ? '选择后在画布空白处重新定位，或直接拖动此点' : '选择后在画布上放置此关节点'}
              >
                {points[i] ? '✓' : i + 1}. {LANDMARK_LABELS[key]}{editIndex === i ? ' · 当前' : ''}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[11px] text-zinc-600">
            <span className="w-10">头大小</span>
            <input type="range" min={0.09} max={0.15} step={0.005} value={headR} onPointerDown={beginOptionEdit} onPointerUp={finishOptionEdit} onPointerCancel={finishOptionEdit} onKeyDown={beginOptionEdit} onKeyUp={() => { if (optionEditTimer.current) clearTimeout(optionEditTimer.current); optionEditTimer.current = setTimeout(finishOptionEdit, 250); }} onBlur={finishOptionEdit} onChange={(e) => { const value = Number(e.target.value); optionsRef.current = { ...optionsRef.current, headR: value }; setHeadR(value); useSketchStore.getState().updateDraft({ points: pointsRef.current, options: { ...optionsRef.current } }); }} className="flex-1 accent-emerald-600" />
            <span className="w-8 font-mono">{headR.toFixed(3)}</span>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-zinc-600">
            <span className="w-10">粗细</span>
            <input type="range" min={0.7} max={1.3} step={0.05} value={thickness} onPointerDown={beginOptionEdit} onPointerUp={finishOptionEdit} onPointerCancel={finishOptionEdit} onKeyDown={beginOptionEdit} onKeyUp={() => { if (optionEditTimer.current) clearTimeout(optionEditTimer.current); optionEditTimer.current = setTimeout(finishOptionEdit, 250); }} onBlur={finishOptionEdit} onChange={(e) => { const value = Number(e.target.value); optionsRef.current = { ...optionsRef.current, thickness: value }; setThickness(value); useSketchStore.getState().updateDraft({ points: pointsRef.current, options: { ...optionsRef.current } }); }} className="flex-1 accent-emerald-600" />
            <span className="w-8 font-mono">{thickness.toFixed(2)}</span>
          </label>
          <div className="grid grid-cols-2 gap-1">
            <button onClick={loadStandardPose} className="flex-1 rounded bg-emerald-50 px-1 py-1 text-[11px] text-emerald-700">
              标准站姿
            </button>
            <button onClick={undo} disabled={past.length === 0} className="flex-1 rounded bg-zinc-200 px-1 py-1 text-[11px] text-zinc-700 disabled:opacity-40">
              撤销
            </button>
            <button onClick={redo} disabled={future.length === 0} className="flex-1 rounded bg-zinc-200 px-1 py-1 text-[11px] text-zinc-700 disabled:opacity-40">
              重做
            </button>
            <button onClick={clear} className="flex-1 rounded bg-zinc-200 px-1 py-1 text-[11px] text-zinc-700">
              清空
            </button>
            <button
              onClick={generate}
              disabled={nextIndex >= 0 || pointIssues.length > 0}
              title={nextIndex >= 0 ? '先点完 8 个点' : pointIssues[0] ?? '生成带骨骼的 3D 角色'}
              className="flex-1 rounded bg-emerald-600 px-1 py-1 text-[11px] text-white disabled:bg-zinc-200 disabled:text-zinc-400"
            >
              生成角色
            </button>
          </div>
          {warnings.map((w, i) => (
            <div key={i} className="text-[11px] text-amber-600">⚠ {w}</div>
          ))}
          {pointIssues.map((issue) => <div key={issue} className="text-[11px] text-amber-700">⚠ {issue}</div>)}
          {error && <div className="text-[11px] text-red-500">{error}</div>}
          <div className="text-[11px] text-zinc-400">可按顺序描点，也可先选上方任一关节点再定位；拖动可微调。撤销/重做保留整次拖动，标准站姿可载入后微调，右侧自动镜像。</div>
        </div>
      )}
    </div>
  );
}
