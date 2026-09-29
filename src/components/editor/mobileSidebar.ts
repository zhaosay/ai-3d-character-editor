export interface ScrollableSidebar {
  scrollTop: number;
}

export function resetSidebarScroll(sidebar: ScrollableSidebar): void {
  sidebar.scrollTop = 0;
}
