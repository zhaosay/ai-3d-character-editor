export function ProviderBadge({ source, label }: { source: 'real' | 'mock'; label: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${source === 'real' ? 'bg-emerald-600 text-white' : 'bg-amber-600 text-black'}`}
      title={source === 'real' ? '真实实现' : 'Mock / 占位，待后续替换'}
    >
      {source === 'real' ? 'REAL' : 'MOCK'} · {label}
    </span>
  );
}
