import { beforeEach, describe, expect, it } from 'vitest';
import { useWorldStore } from '../src/stores/worldStore';
import { findStagePropOverlaps, findStagePropRoomOverflows } from '../src/core/previs/world';

describe('worldStore weapon attachment', () => {
  beforeEach(() => useWorldStore.getState().clear());

  it('preserves an explicitly detached weapon and supports either hand', () => {
    useWorldStore.getState().addSword();
    const swordId = useWorldStore.getState().props[0].id;
    useWorldStore.getState().updateProp(swordId, { attachTo: null });
    expect(useWorldStore.getState().props[0].attachTo).toBeNull();
    useWorldStore.getState().updateProp(swordId, { attachTo: 'hand.L' });
    expect(useWorldStore.getState().props[0].attachTo).toBe('hand.L');
  });

  it('preserves realistic default room and door dimensions after an unrelated edit', () => {
    useWorldStore.getState().addObject('room');
    useWorldStore.getState().addObject('door');
    useWorldStore.getState().updateProp('room-main', { position: [1, 0, 0] });
    useWorldStore.getState().updateProp('door-main', { position: [0, 0, 1] });

    expect(useWorldStore.getState().props.find((prop) => prop.kind === 'room')?.size).toEqual({ width: 5, height: 3, length: 5 });
    expect(useWorldStore.getState().props.find((prop) => prop.kind === 'door')?.size).toEqual({ width: 0.9, height: 2.05, length: 0.08 });
  });

  it('adds separately placeable sparring opponents with human-scale dimensions', () => {
    useWorldStore.getState().addObject('opponent');
    useWorldStore.getState().addObject('opponent');

    const opponents = useWorldStore.getState().props.filter((prop) => prop.kind === 'opponent');
    expect(opponents).toEqual([
      expect.objectContaining({ id: 'opponent-1', position: [0, 0, 1.6], size: { width: 0.62, height: 1.72, length: 0.42 } }),
      expect.objectContaining({ id: 'opponent-2', position: [0.8, 0, 1.6], size: { width: 0.62, height: 1.72, length: 0.42 } }),
    ]);
    expect(Math.cos(opponents[0].rotationY)).toBeCloseTo(-1);
    expect(opponents[1].rotationY).toBeCloseTo(Math.atan2(-0.8, -1.6));
    useWorldStore.getState().removeProp('opponent-1');
    useWorldStore.getState().addObject('opponent');
    expect(useWorldStore.getState().props.filter((prop) => prop.kind === 'opponent').map((prop) => prop.id)).toEqual(['opponent-2', 'opponent-1']);
  });

  it('places the standard room, bed, desk, chair, door, phone and opponent as a valid starter layout', () => {
    useWorldStore.getState().addObject('room');
    useWorldStore.getState().addBed();
    useWorldStore.getState().addObject('table');
    useWorldStore.getState().addObject('chair');
    useWorldStore.getState().addObject('door');
    useWorldStore.getState().addObject('phone');
    useWorldStore.getState().addObject('opponent');

    const props = useWorldStore.getState().props;
    expect(props.find((prop) => prop.kind === 'room')?.position).toEqual([0, 0, 0]);
    expect(props.find((prop) => prop.kind === 'phone')?.position[1]).toBe(props.find((prop) => prop.kind === 'table')?.size.height);
    expect(findStagePropOverlaps(props)).toEqual([]);
    expect(findStagePropRoomOverflows(props)).toEqual([]);
  });

  it('places multiple AI-selectable phones at distinct supported table positions', () => {
    useWorldStore.getState().addObject('room');
    useWorldStore.getState().addObject('table');
    useWorldStore.getState().addObject('phone');
    useWorldStore.getState().addObject('phone');
    const props = useWorldStore.getState().props;
    const phones = props.filter((prop) => prop.kind === 'phone');
    expect(phones.map((prop) => prop.id)).toEqual(['phone-main', 'phone-2']);
    expect(phones[0].position[0]).not.toBe(phones[1].position[0]);
    expect(phones.every((phone) => phone.position[1] === props.find((prop) => prop.kind === 'table')?.size.height)).toBe(true);
    expect(findStagePropOverlaps(props)).toEqual([]);
    expect(findStagePropRoomOverflows(props)).toEqual([]);
  });
});
