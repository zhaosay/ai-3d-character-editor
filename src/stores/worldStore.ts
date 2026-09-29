import { create } from 'zustand';
import { defaultStagePropPosition, STAGE_PROP_SIZE_LIMITS, type StageProp } from '../core/previs/world';

type StagePropPatch = Partial<Omit<StageProp, 'size'>> & { size?: Partial<StageProp['size']> };

interface WorldState {
  props: StageProp[];
  addBed: () => void;
  addObject: (kind: Extract<StageProp['kind'], 'room' | 'chair' | 'sofa' | 'table' | 'door' | 'phone' | 'opponent'>) => void;
  addSword: () => void;
  removeProp: (id: string) => void;
  updateProp: (id: string, patch: StagePropPatch) => void;
  replaceProps: (props: StageProp[]) => void;
  clear: () => void;
}

function validateProp(prop: StageProp): StageProp | null {
  if (!['room', 'bed', 'chair', 'sofa', 'table', 'door', 'phone', 'sword', 'opponent'].includes(prop.kind) || !prop.id || !Array.isArray(prop.position) || prop.position.length !== 3 || !prop.size || typeof prop.size !== 'object') return null;
  const values = [...prop.position, prop.rotationY, prop.size.width, prop.size.height, prop.size.length, ...(prop.attachOffset ?? [])];
  if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > 100)) return null;
  if (prop.attachTo !== undefined && prop.attachTo !== null && prop.attachTo !== 'hand.R' && prop.attachTo !== 'hand.L') return null;
  const limits = STAGE_PROP_SIZE_LIMITS[prop.kind];
  const clamp = (dimension: 'width' | 'height' | 'length') => {
    const [min, max] = limits[dimension];
    return Math.min(Math.max(prop.size[dimension], min), max);
  };
  return {
    ...prop,
    position: [...prop.position] as StageProp['position'],
    rotationY: prop.rotationY,
    attachTo: prop.kind === 'sword' ? (prop.attachTo === undefined ? 'hand.R' : prop.attachTo) : undefined,
    attachOffset: prop.kind === 'sword' ? [...(prop.attachOffset ?? [0, 0, 0])] as StageProp['position'] : undefined,
    size: { width: clamp('width'), height: clamp('height'), length: clamp('length') },
  };
}

export const useWorldStore = create<WorldState>((set) => ({
  props: [],
  addBed: () => set((state) => state.props.some((prop) => prop.kind === 'bed') ? state : ({
    props: [...state.props, {
      id: 'bed-main', kind: 'bed', position: defaultStagePropPosition('bed'), rotationY: 0,
      size: { width: 1.3, height: 0.58, length: 2.1 },
  }],
  })),
  addObject: (kind) => set((state) => {
    if (!['opponent', 'phone', 'sofa'].includes(kind) && state.props.some((prop) => prop.kind === kind)) return state;
    let opponentIndex = 1;
    while (state.props.some((prop) => prop.id === `opponent-${opponentIndex}`)) opponentIndex++;
    const phoneIndex = state.props.filter((prop) => prop.kind === 'phone').length;
    const sofaIndex = state.props.filter((prop) => prop.kind === 'sofa').length;
    const position = defaultStagePropPosition(kind, kind === 'opponent' ? opponentIndex - 1 : phoneIndex);
    return { props: [...state.props, {
      id: kind === 'opponent' ? `opponent-${opponentIndex}` : kind === 'phone' && phoneIndex > 0 ? `phone-${phoneIndex + 1}`
        : kind === 'sofa' && sofaIndex > 0 ? `sofa-${sofaIndex + 1}` : `${kind}-main`, kind,
      position,
      rotationY: kind === 'opponent' ? Math.atan2(-position[0], -position[2]) : 0,
      size: kind === 'room' ? { width: 5, height: 3, length: 5 }
        : kind === 'chair' ? { width: 0.52, height: 0.9, length: 0.52 }
          : kind === 'sofa' ? { width: 2.0, height: 0.9, length: 0.9 }
        : kind === 'table' ? { width: 1.1, height: 0.75, length: 0.7 }
          : kind === 'door' ? { width: 0.9, height: 2.05, length: 0.08 }
            : kind === 'opponent' ? { width: 0.62, height: 1.72, length: 0.42 }
              : { width: 0.075, height: 0.018, length: 0.15 },
    }] };
  }),
  addSword: () => set((state) => state.props.some((prop) => prop.kind === 'sword') ? state : ({
    props: [...state.props, {
      id: 'sword-main', kind: 'sword', position: defaultStagePropPosition('sword'), rotationY: 0,
      size: { width: 0.045, height: 0.045, length: 0.9 }, attachTo: 'hand.R', attachOffset: [0, 0, 0],
    }],
  })),
  removeProp: (id) => set((state) => ({ props: state.props.filter((prop) => prop.id !== id) })),
  updateProp: (id, patch) => set((state) => ({
    props: state.props.map((prop) => prop.id === id ? validateProp({ ...prop, ...patch, size: patch.size ? { ...prop.size, ...patch.size } : prop.size }) ?? prop : prop),
  })),
  replaceProps: (props) => set({ props: props.map(validateProp).filter((prop): prop is StageProp => prop !== null) }),
  clear: () => set({ props: [] }),
}));
