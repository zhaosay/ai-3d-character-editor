import { useState } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { activateCharacter } from '../character/activateCharacter';
import { buildDemoCharacter } from '../../services/demo/buildDemoCharacter';
import { ProviderBadge } from '../ai/ProviderBadge';
import {
  APPEARANCE_PRESETS, RANGES, clampAppearance, sameAppearance,
  type Appearance, type FaceShape, type HairStyle,
} from '../../core/character/appearance';

const FACE_LABELS: Record<FaceShape, string> = {
  oval: '鹅蛋', round: '圆脸', square: '方脸', heart: '心形', long: '长脸',
};
const HAIR_LABELS: Record<HairStyle, string> = {
  bald: '光头', buzz: '寸头', short: '短发', bob: '波波头', long: '长发',
};

/** 人物定制：体型/面部/发型/皮肤。仅对程序化示例人物生效（外部 GLB 需重新拓扑，无法改体型）。 */
export function AppearancePanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const replace = useAppearanceStore((s) => s.replace);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const current = sceneObject?.userData['appearance'] as Appearance | undefined;
  const editable = !!sceneObject && !!current;

  const apply = (next: Partial<Appearance>) => {
    if (!editable || !sceneObject) return;
    const a = clampAppearance({ ...current, ...next });
    if (sameAppearance(a, current)) return;
    setBusy(true);
    try {
      const demo = buildDemoCharacter(a.gender, a);
      activateCharacter(demo.meta, demo.scene, demo.dispose);
      replace(a);
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '应用失败');
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, node: React.ReactNode) => (
    <div className="space-y-0.5">
      <div className="flex justify-between text-zinc-600"><span>{label}</span></div>
      {node}
    </div>
  );

  const slider = (
    label: string, key: keyof typeof RANGES, value: number,
    fmt: (v: number) => string = (v) => v.toFixed(2),
  ) => row(label, (
    <div className="flex items-center gap-2">
      <input
        type="range" min={RANGES[key].min} max={RANGES[key].max} step={0.01}
        value={value} disabled={!editable || busy}
        onChange={(e) => apply({ [key]: Number(e.target.value) } as Partial<Appearance>)}
        className="w-full accent-emerald-600 disabled:opacity-40"
      />
      <span className="w-10 shrink-0 text-right font-mono text-[11px] text-zinc-500">{fmt(value)}</span>
    </div>
  ));

  const colorRow = (label: string, key: 'skinColor' | 'hairColor' | 'clothColor') => row(label, (
    <div className="flex items-center gap-2">
      <input
        type="color" value={current?.[key] ?? '#000000'} disabled={!editable || busy}
        onChange={(e) => apply({ [key]: e.target.value })}
        className="h-6 w-12 rounded disabled:opacity-40"
      />
      <span className="font-mono text-[11px] text-zinc-500">{current?.[key]}</span>
    </div>
  ));

  return (
    <div className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-800">
        人物定制 <ProviderBadge source="real" label="程序化" />
      </div>

      <div className="space-y-1">
        <div className="font-bold text-zinc-600">预设</div>
        <div className="grid grid-cols-2 gap-1">
          {APPEARANCE_PRESETS.map((p) => (
            <button
              key={p.id}
              disabled={!editable || busy}
              onClick={() => apply(p.appearance)}
              className="rounded bg-zinc-100 px-1.5 py-1 text-[11px] text-zinc-700 hover:bg-zinc-200 disabled:opacity-40"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {!editable && (
        <div className="text-[11px] text-zinc-400">
          {sceneObject
            ? '外部模型不支持体型/面部定制（需重新拓扑），仅可在「主题」换色。'
            : '先加载示例男/女角色以启用定制。'}
        </div>
      )}

      {editable && (
        <>
          <div className="space-y-1">
            <div className="font-bold text-zinc-600">体型</div>
            {row('性别', (
              <div className="grid grid-cols-2 gap-1">
                {(['male', 'female'] as const).map((g) => (
                  <button
                    key={g}
                    disabled={busy}
                    onClick={() => apply({ gender: g })}
                    className={`rounded px-1.5 py-1 ${current.gender === g ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-700'}`}
                  >
                    {g === 'male' ? '男' : '女'}
                  </button>
                ))}
              </div>
            ))}
            {slider('身高 (m)', 'height', current.height, (v) => v.toFixed(2))}
            {slider('体型 (瘦↔壮)', 'build', current.build)}
          </div>

          <div className="space-y-1">
            <div className="font-bold text-zinc-600">面部</div>
            {row('脸型', (
              <div className="grid grid-cols-5 gap-1">
                {(Object.keys(FACE_LABELS) as FaceShape[]).map((f) => (
                  <button
                    key={f} disabled={busy}
                    onClick={() => apply({ faceShape: f })}
                    className={`rounded px-0.5 py-1 text-[10px] ${current.faceShape === f ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-700'}`}
                  >
                    {FACE_LABELS[f]}
                  </button>
                ))}
              </div>
            ))}
            {slider('眼睛大小', 'eyeSize', current.eyeSize)}
            {slider('眉厚度', 'browThickness', current.browThickness)}
            {slider('鼻子大小', 'noseSize', current.noseSize)}
            {slider('嘴宽', 'mouthWidth', current.mouthWidth)}
          </div>

          <div className="space-y-1">
            <div className="font-bold text-zinc-600">发型与肤色</div>
            {row('发型', (
              <div className="grid grid-cols-5 gap-1">
                {(Object.keys(HAIR_LABELS) as HairStyle[]).map((h) => (
                  <button
                    key={h} disabled={busy}
                    onClick={() => apply({ hairStyle: h })}
                    className={`rounded px-0.5 py-1 text-[10px] ${current.hairStyle === h ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-700'}`}
                  >
                    {HAIR_LABELS[h]}
                  </button>
                ))}
              </div>
            ))}
            {colorRow('发色', 'hairColor')}
            {colorRow('肤色', 'skinColor')}
            {colorRow('服装色', 'clothColor')}
            {slider('皮肤质感 (亮↔哑)', 'skinRoughness', current.skinRoughness)}
          </div>

          <div className="text-[11px] text-zinc-400">
            改动会重建程序化网格并刷新骨骼（动作轨道保留）。外部 GLB 不支持体型/面部定制。
          </div>
        </>
      )}

      {msg && <div className="text-[11px] text-red-500">{msg}</div>}
      <div className="text-[11px] text-zinc-400">目标为写实游戏级：程序化网格不含真实皮肤/头发贴图，需导入 PBR 资产才能到近景可信。</div>
    </div>
  );
}
