import { useEffect, useRef, useState } from 'react';
import {
  LANDMARK_LABELS,
  LANDMARK_ORDER,
  SKETCH_H,
  SKETCH_W,
  type SketchPoint,
} from '../../core/rig/sketchToSpec';
import { buildSketchCharacter } from '../../services/sketch/buildSketchCharacter';
import { activateCharacter } from './activateCharacter';

const LINKS: Array<[number, number]> = [
  [0, 1], [1, 5], [1, 2], [2, 3], [3, 4], [5, 6], [6, 7],
];

function mirrorX(x: number): number {
  return SKETCH_W - x;
}

/** ✏️ 手绘捏人：画布上按顺序点 8 个关节点，生成带骨骼的 3D 角色（右侧自动镜像）。 */
export function SketchRig() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState<Array<SketchPoint | null>>(Array(8).fill(null));
  const [headR, setHeadR] = useState(0.115);
  const [thickness, setThickness] = useState(1);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const nextIndex = points.findIndex((p) => !p);

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
      return ghost ? { x: mirrorX(p.x), y: p.y } : p;
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
    // 点 + 序号
    points.forEach((p, i) => {
      if (!p) return;
      ctx.fillStyle = '#059669';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y);
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
  }, [points, nextIndex]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (nextIndex < 0) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * SKETCH_W;
    const y = ((e.clientY - rect.top) / rect.height) * SKETCH_H;
    setPoints((prev) => {
      const next = [...prev];
      next[nextIndex] = { x: Math.min(Math.max(x, 0), SKETCH_W), y: Math.min(Math.max(y, 0), SKETCH_H) };
      return next;
    });
    setError(null);
  };

  const undoOne = () => {
    setPoints((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i]) {
          next[i] = null;
          break;
        }
      }
      return next;
    });
  };

  const clear = () => {
    setPoints(Array(8).fill(null));
    setWarnings([]);
    setError(null);
  };

  const generate = () => {
    setError(null);
    setWarnings([]);
    try {
      const record: Record<string, SketchPoint> = {};
      LANDMARK_ORDER.forEach((k, i) => {
        if (points[i]) record[k] = points[i]!;
      });
      const built = buildSketchCharacter(record, { headR, thickness });
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
            onClick={onClick}
            className="w-full cursor-crosshair rounded ring-1 ring-zinc-300"
            style={{ aspectRatio: `${SKETCH_W} / ${SKETCH_H}` }}
            title="按顺序点击 8 个关节点"
          />
          <label className="flex items-center gap-2 text-[11px] text-zinc-600">
            <span className="w-10">头大小</span>
            <input type="range" min={0.09} max={0.15} step={0.005} value={headR} onChange={(e) => setHeadR(Number(e.target.value))} className="flex-1 accent-emerald-600" />
            <span className="w-8 font-mono">{headR.toFixed(3)}</span>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-zinc-600">
            <span className="w-10">粗细</span>
            <input type="range" min={0.7} max={1.3} step={0.05} value={thickness} onChange={(e) => setThickness(Number(e.target.value))} className="flex-1 accent-emerald-600" />
            <span className="w-8 font-mono">{thickness.toFixed(2)}</span>
          </label>
          <div className="flex gap-1">
            <button onClick={undoOne} className="flex-1 rounded bg-zinc-200 px-1 py-1 text-[11px] text-zinc-700">
              撤销一点
            </button>
            <button onClick={clear} className="flex-1 rounded bg-zinc-200 px-1 py-1 text-[11px] text-zinc-700">
              清空
            </button>
            <button
              onClick={generate}
              disabled={nextIndex >= 0}
              title={nextIndex >= 0 ? '先点完 8 个点' : '生成带骨骼的 3D 角色'}
              className="flex-1 rounded bg-emerald-600 px-1 py-1 text-[11px] text-white disabled:bg-zinc-200 disabled:text-zinc-400"
            >
              生成角色
            </button>
          </div>
          {warnings.map((w, i) => (
            <div key={i} className="text-[11px] text-amber-600">⚠ {w}</div>
          ))}
          {error && <div className="text-[11px] text-red-500">{error}</div>}
          <div className="text-[11px] text-zinc-400">只描左侧，右侧自动镜像；颜色取当前主题。</div>
        </div>
      )}
    </div>
  );
}
