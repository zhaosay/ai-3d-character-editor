import { describe, expect, it } from 'vitest';
import { resetSidebarScroll } from '../src/components/editor/mobileSidebar';

describe('mobile character sidebar', () => {
  it('opens at the top so the first sketch landmarks are visible', () => {
    const sidebar = { scrollTop: 420.5 };

    resetSidebarScroll(sidebar);

    expect(sidebar.scrollTop).toBe(0);
  });
});
