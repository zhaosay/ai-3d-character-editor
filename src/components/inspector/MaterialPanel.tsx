import { useEffect, useRef, useState } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { useMaterialStore, importTexture, MAX_TEXTURE_BYTES, isEmptyOverride, type MaterialOverride } from '../../stores/materialStore';
import { TEXTURE_LABELS, TEXTURE_SLOTS, type TextureSlot } from '../../core/material/pbr';
import { ProviderBadge } from '../ai/ProviderBadge';

/**
 * PBR 材质面板。
 *
 * 之前项目里**没有任何材质面板**：导入 GLB 后 `loadGltf.finishLoaded`
 * 只统计材质数量、从不触碰 material 属性，用户改不了金属度/粗糙度/贴图；
 * 内置角色也只有 Appearance.skinRoughness 一个标量。
 *
 * 覆盖按「材质路径」存（不是 uuid），可随项目存取。
 * 数据贴图（法线/粗糙/金属）导入时按**线性**色彩空间解读，标成 sRGB 会失真。
 */

export function MaterialPanel() {
  const sceneObject = useCharacterStore((s) => s.sceneObject);
  const overrides = useMaterialStore((s) => s.overrides);
  const setOverride = useMaterialStore((s) => s.setOverride);
  const setTexture = useMaterialStore((s) => s.setTexture);
  const applyTo = useMaterialStore((s) => s.applyTo);
  const clearAll = useMaterialStore((s) => s.clearAll);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 角色切换 / 覆盖变化后重新施加
  useEffect(() => {
    applyTo(sceneObject ?? null);
  }, [sceneObject, overrides, applyTo]);

  const listFn = useMaterialStore((s) => s.list);
  const materials = listFn(sceneObject ?? null);
  const overrideCount = Object.values(overrides).filter((o) => !isEmptyOverride(o)).length;

  return (
    <section className="space-y-2 border-b border-zinc-200 p-3 text-xs">
      <div className="flex items-center gap-2 font-bold text-zinc-800">
        材质 PBR
        <ProviderBadge source="real" label="PBR 通道" />
        {overrideCount > 0 && (
          <button
            onClick={() => { clearAll(); setMsg(null); }}
            className="ml-auto rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600"
          >
            重置 {overrideCount}
          </button>
        )}
      </div>

      {materials.length === 0 ? (
        <p className="text-[11px] text-zinc-500">
          当前角色没有可编辑的 PBR 材质（需要 MeshStandardMaterial / MeshPhysicalMaterial）。
        </p>
      ) : (
        <>
          <p className="text-[11px] text-zinc-500">
            共 {materials.length} 个材质。修改会随项目保存；导入的贴图内嵌在 project.json（单张 ≤
            {Math.round(MAX_TEXTURE_BYTES / 1024 / 1024)}MB）。
          </p>
          <ul className="space-y-1">
            {materials.map((m) => (
              <li key={m.path} className="rounded bg-zinc-50 p-1.5 ring-1 ring-zinc-200">
                <button
                  onClick={() => setExpanded(expanded === m.path ? null : m.path)}
                  className="flex w-full items-center gap-2 text-left"
                >
                  <span className="font-medium text-zinc-700">
                    {m.name || m.meshName}
                  </span>
                  {m.themable && (
                    <span className="rounded bg-zinc-200 px-1 text-[10px] text-zinc-600">
                      换肤:{m.themable === 'skin' ? '皮肤' : '服装'}
                    </span>
                  )}
                  {Object.values(m.maps).some(Boolean) && (
                    <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-800">含贴图</span>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-zinc-500">
                    {expanded === m.path ? '收起' : '展开'}
                  </span>
                </button>

                {expanded === m.path && (
                  <div className="mt-2 space-y-1.5">
                    <ColorRow
                      label="基色"
                      value={m.override?.color ?? m.values.color}
                      onChange={(hex) => setOverride(m.path, { color: hex })}
                    />
                    <Slider label="金属度" value={m.override?.metalness ?? m.values.metalness}
                      onChange={(v) => setOverride(m.path, { metalness: v })} />
                    <Slider label="粗糙度" value={m.override?.roughness ?? m.values.roughness}
                      onChange={(v) => setOverride(m.path, { roughness: v })} />
                    <Slider label="法线强度" max={3} value={m.override?.normalScale ?? m.values.normalScale}
                      onChange={(v) => setOverride(m.path, { normalScale: v })} />
                    <Slider label="环境反射" max={3} value={m.override?.envMapIntensity ?? m.values.envMapIntensity}
                      onChange={(v) => setOverride(m.path, { envMapIntensity: v })} />
                    <ColorRow
                      label="自发光"
                      value={m.override?.emissive ?? m.values.emissive}
                      onChange={(hex) => setOverride(m.path, { emissive: hex })}
                    />
                    <Slider label="自发光强度" max={5} value={m.override?.emissiveIntensity ?? m.values.emissiveIntensity}
                      onChange={(v) => setOverride(m.path, { emissiveIntensity: v })} />

                    <div className="pt-1">
                      <div className="mb-1 font-bold text-zinc-600">贴图</div>
                      <div className="grid grid-cols-2 gap-1">
                        {TEXTURE_SLOTS.map((slot) => (
                          <TextureSlotRow
                            key={slot}
                            slot={slot}
                            has={m.maps[slot]}
                            overridden={!!(m.override as MaterialOverride | undefined)?.textures?.[slot]}
                            onPick={async (file) => {
                              try {
                                const url = await importTexture(file);
                                setTexture(m.path, slot, url);
                                setMsg(null);
                              } catch (e) {
                                setMsg(e instanceof Error ? e.message : '贴图导入失败');
                              }
                            }}
                            onClear={() => { setTexture(m.path, slot, ''); setMsg(null); }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {msg && <p role="alert" className="text-[11px] text-red-600">{msg}</p>}
      <p className="text-[11px] text-zinc-400">
        只影响视口预览；导出的 GLB 会带上同样的材质参数与贴图。程序化角色没有真实皮肤/头发贴图，
        近景可信度仍需导入外部 PBR 资产。
      </p>
    </section>
  );
}

function Slider({ label, value, min = 0, max = 1, onChange }: {
  label: string; value: number; min?: number; max?: number; onChange: (v: number) => void;
}) {
  return (
    <label className="block text-zinc-600">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono text-zinc-800">{value.toFixed(2)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={0.01} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-600"
      />
    </label>
  );
}

function ColorRow({ label, value, onChange }: {
  label: string; value: string; onChange: (hex: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-zinc-600">
      <span className="w-12">{label}</span>
      <input
        type="color" value={value} onChange={(e) => onChange(e.target.value)}
        className="h-6 w-10 cursor-pointer rounded bg-white ring-1 ring-zinc-300"
      />
      <span className="font-mono text-[11px]">{value}</span>
    </label>
  );
}

function TextureSlotRow({ slot, has, overridden, onPick, onClear }: {
  slot: TextureSlot;
  has: boolean;
  overridden: boolean;
  onPick: (file: File) => void | Promise<void>;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const state = overridden ? '已导入' : has ? '模型自带' : '无';
  return (
    <div className="flex items-center gap-1 rounded bg-zinc-100 px-1 py-0.5">
      <span className="text-[11px] text-zinc-600">{TEXTURE_LABELS[slot]}</span>
      <span className={`ml-auto text-[10px] ${overridden ? 'text-emerald-700' : 'text-zinc-400'}`}>{state}</span>
      <button
        onClick={() => ref.current?.click()}
        className="rounded bg-zinc-200 px-1 text-[10px] text-zinc-700"
        title={`导入${TEXTURE_LABELS[slot]}贴图`}
      >
        导入
      </button>
      {overridden && (
        <button onClick={onClear} className="rounded bg-zinc-200 px-1 text-[10px] text-red-600">清</button>
      )}
      <input
        ref={ref} type="file" accept="image/*" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onPick(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}