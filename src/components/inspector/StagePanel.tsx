import { useState } from 'react';
import { useWorldStore } from '../../stores/worldStore';
import { useWeaponGripStore } from '../../stores/weaponGripStore';
import { useAnimationStore } from '../../stores/animationStore';
import { validateStagePropPlacement, type StageProp } from '../../core/previs/world';

const numberInput = 'w-full rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-800 ring-1 ring-zinc-200';

function NumericField({ value, step = 0.1, className = numberInput, onCommit }: {
  value: number;
  step?: number;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  return <input type="number" step={step} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(String(value));
  }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} className={className} />;
}

type PropPatch = Partial<Omit<StageProp, 'size'>> & { size?: Partial<StageProp['size']> };

function propEditError(props: StageProp[], prop: StageProp, patch: PropPatch): string | null {
  const candidate: StageProp = { ...prop, ...patch, size: { ...prop.size, ...patch.size } };
  return validateStagePropPlacement(props, candidate);
}

function commitPropEdit(
  props: StageProp[], prop: StageProp, patch: PropPatch,
  checkpoint: () => void, updateProp: (id: string, patch: PropPatch) => void,
): string | null {
  const error = propEditError(props, prop, patch);
  if (error) return error;
  checkpoint();
  updateProp(prop.id, patch);
  return null;
}

export function StagePanel() {
  const twoHandGrip = useWeaponGripStore((s) => s.enabled);
  const setTwoHandGrip = useWeaponGripStore((s) => s.setEnabled);
  const [bedError, setBedError] = useState<string | null>(null);
  const checkpoint = useAnimationStore((state) => state.checkpoint);
  const props = useWorldStore((state) => state.props);
  const addBed = useWorldStore((state) => state.addBed);
  const addSword = useWorldStore((state) => state.addSword);
  const addObject = useWorldStore((state) => state.addObject);
  const removeProp = useWorldStore((state) => state.removeProp);
  const updateProp = useWorldStore((state) => state.updateProp);
  const bed = props.find((prop) => prop.kind === 'bed');
  const sword = props.find((prop) => prop.kind === 'sword');

  return (
    <section className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center">
        <h2 className="font-semibold text-zinc-800">场景与动作道具</h2>
        <div className="ml-auto flex flex-wrap justify-end gap-1">
          {!bed && <button onClick={() => { checkpoint(); addBed(); }} className="rounded-md bg-sky-50 px-2 py-1 text-sky-700">+ 床</button>}
          {!sword && <button onClick={() => { checkpoint(); addSword(); }} className="rounded-md bg-amber-50 px-2 py-1 text-amber-700">+ 剑</button>}
          {(['room', 'table', 'chair', 'sofa', 'door', 'phone', 'opponent'] as const).map((kind) => (['opponent', 'sofa'].includes(kind) || !props.some((prop) => prop.kind === kind)) && <button key={kind} onClick={() => { checkpoint(); addObject(kind); }} className="rounded-md bg-zinc-100 px-2 py-1 text-zinc-700">+ {{ room: '房间', table: '桌', chair: '椅', sofa: '沙发', door: '门', phone: '手机', opponent: '对手' }[kind]}</button>)}
        </div>
      </div>
      {!bed && !sword && <p className="text-[11px] leading-relaxed text-zinc-500">添加场景物体作为 AI 走位、支撑或交互目标；描述“走到桌前拿起手机”即可按摆放位置规划。</p>}
      {bed && (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            {(['x', 'y', 'z'] as const).map((axis, index) => (
              <label key={axis} className="space-y-1 text-[10px] text-zinc-500">
                床位置 {axis.toUpperCase()}
                <NumericField key={`${axis}-${bed.position[index]}`} value={bed.position[index]} onCommit={(value) => {
                    const position = [...bed.position] as typeof bed.position;
                    position[index] = value;
                    setBedError(commitPropEdit(props, bed, { position }, checkpoint, updateProp));
                  }} />
              </label>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1.5">{(['width', 'height', 'length'] as const).map((axis) => <label key={axis} className="space-y-1 text-[10px] text-zinc-500">{{ width: '床宽', height: '床高', length: '床长' }[axis]}<NumericField key={`${axis}-${bed.size[axis]}`} value={bed.size[axis]} onCommit={(value) => { setBedError(commitPropEdit(props, bed, { size: { [axis]: value } }, checkpoint, updateProp)); }} /></label>)}</div>
          <label className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
            床朝向
            <NumericField key={`rotation-${bed.rotationY}`} value={Math.round(bed.rotationY * 180 / Math.PI)} step={15} className={`${numberInput} max-w-24`} onCommit={(degrees) => { setBedError(commitPropEdit(props, bed, { rotationY: degrees * Math.PI / 180 }, checkpoint, updateProp)); }} />°
          </label>
          {bedError && <p role="alert" className="text-[10px] text-red-700">未应用：{bedError}</p>}
          <p className="text-[10px] text-amber-700">床面 { (bed.position[1] + bed.size.height).toFixed(2) } m · 动作目标已绑定；当前接触为姿态近似，尚无刚体碰撞求解。</p>
          <button onClick={() => { checkpoint(); removeProp(bed.id); }} className="rounded-md bg-zinc-100 px-2 py-1 text-zinc-600">移除床</button>
        </>
      )}
      {sword && <>
        <div className="flex items-center gap-2 text-[11px] text-zinc-700">
          <span>训练剑</span>
          <select
            aria-label="训练剑持握方式"
            value={sword.attachTo ?? ''}
            onChange={(event) => { checkpoint(); updateProp(sword.id, { attachTo: event.target.value === '' ? null : event.target.value as 'hand.R' | 'hand.L' }); }}
            className="ml-auto rounded bg-zinc-100 px-2 py-1"
          >
            <option value="">场景摆放</option>
            <option value="hand.R">右手持握</option>
            <option value="hand.L">左手持握</option>
          </select>
          <button onClick={() => { checkpoint(); removeProp(sword.id); }} className="rounded bg-zinc-100 px-2 py-1 text-red-600">移除</button>
        </div>
        {sword.attachTo && <div className="grid grid-cols-3 gap-1.5">
          {(['x', 'y', 'z'] as const).map((axis, index) => <label key={axis} className="space-y-1 text-[10px] text-zinc-500">
            挂点偏移 {axis.toUpperCase()}
            <NumericField key={`${axis}-${sword.attachOffset?.[index] ?? 0}`} value={sword.attachOffset?.[index] ?? 0} step={0.02} onCommit={(value) => {
              const offset = [...(sword.attachOffset ?? [0, 0, 0])] as typeof sword.position;
              offset[index] = value;
              checkpoint(); updateProp(sword.id, { attachOffset: offset });
            }} />
          </label>)}
        </div>}
        <label className="mt-1.5 flex items-center gap-2 text-[11px] text-zinc-700">
          <input
            type="checkbox"
            checked={twoHandGrip}
            onChange={(event) => setTwoHandGrip(event.target.checked)}
            className="accent-zinc-700"
          />
          双手握持 IK
          <span className="text-[10px] text-zinc-400">副手自动对齐柄尾</span>
        </label>
        <p className="mt-1 text-[10px] text-zinc-500">
          {twoHandGrip
            ? '已开：主手按体型解到护手位，副手 IK 对齐柄尾（实测偏差 13~14mm）。'
            : '已关：退回纯关键帧驱动，副手只按动画摆动 —— 会出现「双手不握同一把剑」。'}
        </p>
        <p className="text-[10px] leading-relaxed text-zinc-500">
          训练剑按手部语义骨骼驱动；AI 可将“换到左手/右手”拆成时间轴交接阶段。
          交接仍是手臂姿态与武器位置插值；挥击弧线未解（下劈需 90°+ 腕旋转，解剖上做不到，
          真实下劈靠肩肘带动的弧线），碰撞判定也仍不在此列。
        </p>
      </>}
      {props.filter((prop) => ['room', 'chair', 'sofa', 'table', 'door', 'phone', 'opponent'].includes(prop.kind)).map((prop) => <GenericPropEditor key={prop.id} prop={prop} />)}
    </section>
  );
}

function GenericPropEditor({ prop }: { prop: import('../../core/previs/world').StageProp }) {
  const checkpoint = useAnimationStore((state) => state.checkpoint);
  const props = useWorldStore((state) => state.props);
  const updateProp = useWorldStore((state) => state.updateProp);
  const removeProp = useWorldStore((state) => state.removeProp);
  const [error, setError] = useState<string | null>(null);
  const commit = (patch: PropPatch) => setError(commitPropEdit(props, prop, patch, checkpoint, updateProp));
  const labels = { room: '房间', chair: '椅子', sofa: '沙发', table: '桌子', door: '门', phone: '手机', opponent: '对手占位体' } as const;
  return <div className="space-y-1.5 rounded-lg bg-zinc-50 p-2 ring-1 ring-zinc-200">
    <div className="flex items-center font-medium text-zinc-700"><span>{labels[prop.kind as keyof typeof labels]}</span><button onClick={() => { checkpoint(); removeProp(prop.id); }} className="ml-auto text-red-600">移除</button></div>
    <div className="grid grid-cols-3 gap-1.5">{(['x', 'y', 'z'] as const).map((axis, index) => <label key={axis} className="space-y-1 text-[10px] text-zinc-500">位置 {axis.toUpperCase()}<NumericField key={`${prop.id}-${axis}-${prop.position[index]}`} value={prop.position[index]} onCommit={(value) => { const position = [...prop.position] as typeof prop.position; position[index] = value; commit({ position }); }} /></label>)}</div>
    <div className="grid grid-cols-3 gap-1.5">{(['width', 'height', 'length'] as const).map((axis) => <label key={axis} className="space-y-1 text-[10px] text-zinc-500">{{ width: '宽', height: '高', length: '深' }[axis]}<NumericField key={`${prop.id}-${axis}-${prop.size[axis]}`} value={prop.size[axis]} onCommit={(value) => commit({ size: { [axis]: value } })} /></label>)}</div>
    <label className="flex items-center gap-2 text-[10px] text-zinc-500">朝向° <NumericField key={`${prop.id}-yaw-${prop.rotationY}`} value={Math.round(prop.rotationY * 180 / Math.PI)} step={15} onCommit={(value) => commit({ rotationY: value * Math.PI / 180 })} /></label>
    {error && <p role="alert" className="text-[10px] text-red-700">未应用：{error}</p>}
  </div>;
}
