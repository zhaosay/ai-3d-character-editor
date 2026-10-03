import type { ReactNode } from 'react';

/**
 * Inspector 折叠分组。
 *
 * ## 为什么用折叠而不是标签页
 *
 * 原来 20 个面板分装在 4 个标签页里（预演 6 / 场景 4 / 角色 9 / 显示 1），
 * 代价是 **15 个面板被完全隐藏**、不可发现，且「显示」独占一个标签页只放 1 个面板。
 *
 * 参照 avatar-stage 的 `details.panel`：分组标题**始终可见**、可扫读，
 * 展开才看内容。用户一眼能知道编辑器里有什么，而不是先猜该点哪个标签。
 *
 * 用原生 `<details>/<summary>` 而非 JS 状态：天然可访问（键盘可达、
 * 读屏软件能识别展开态）、无需维护 open 集合。
 *
 * @param defaultOpen 默认展开。首屏只展开第一个分组，其余收起 ——
 *                    避免一进来就是一长条滚动条（这正是标签页要解决的问题）。
 */
export function InspectorSection({
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** 标题右侧的计数/状态提示 */
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="inspector-section group border-b border-zinc-200/70 last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-bold text-zinc-700 transition-colors hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
        <span
          className="text-zinc-400 transition-transform duration-150 group-open:rotate-90"
          aria-hidden
        >
          ›
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {badge != null && <span className="shrink-0 text-[11px] font-medium text-zinc-400">{badge}</span>}
      </summary>
      <div className="border-t border-zinc-100">{children}</div>
    </details>
  );
}