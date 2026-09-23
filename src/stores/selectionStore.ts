import { create } from 'zustand';

interface SelectionState {
  selectedBoneId: string | null;
  select: (id: string | null) => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedBoneId: null,
  select: (selectedBoneId) => set({ selectedBoneId }),
}));
