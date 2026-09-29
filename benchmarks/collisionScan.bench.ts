import { test } from 'vitest';
import { createEmptyAnimation } from '../src/core/animation/types';
import { inspectMotionCollisions } from '../src/core/previs/collision';
import type { StageProp } from '../src/core/previs/world';
import { buildDemoCharacter } from '../src/services/demo/buildDemoCharacter';

const { scene } = buildDemoCharacter('male');
scene.updateWorldMatrix(true, true);

const props: StageProp[] = [
  { id: 'room', kind: 'room', position: [0, 0, 0], rotationY: 0, size: { width: 8, height: 3, length: 8 } },
  { id: 'bed', kind: 'bed', position: [2, 0, 1], rotationY: 0.2, size: { width: 1.3, height: 0.58, length: 2.1 } },
  { id: 'sofa', kind: 'sofa', position: [-2, 0, 1], rotationY: -0.2, size: { width: 2, height: 0.9, length: 0.9 } },
  { id: 'table', kind: 'table', position: [1, 0, -1], rotationY: 0.1, size: { width: 1.1, height: 0.75, length: 0.7 } },
  { id: 'chair', kind: 'chair', position: [-1, 0, -1], rotationY: 0.1, size: { width: 0.52, height: 0.9, length: 0.52 } },
  { id: 'door', kind: 'door', position: [0, 0, -3], rotationY: 0, size: { width: 0.9, height: 2.05, length: 0.08 } },
  { id: 'phone', kind: 'phone', position: [1, 0.75, -1], rotationY: 0, size: { width: 0.075, height: 0.018, length: 0.15 } },
  { id: 'opponent', kind: 'opponent', position: [0, 0, 2.1], rotationY: Math.PI, size: { width: 0.62, height: 1.72, length: 0.42 } },
];

const animation = createEmptyAnimation('30-second walk', 30, 30);
animation.tracks = [{
  boneName: 'Hips',
  position: [
    { time: 0, value: [0, 1.02, 0], interp: 'linear' },
    { time: 30, value: [2, 1.02, 0], interp: 'linear' },
  ],
  rotation: [],
  scale: [],
}];

test('previs collision scan on representative long scene', async ({ bench }) => {
  const result = await bench('30s / male previs rig / 8 props', { time: 750, iterations: 5, warmupIterations: 1 }, () => {
    inspectMotionCollisions(scene, animation, props, [{ t0: 0, t1: 30, template: 'march', clause: '走到桌前' }]);
  }).run();
  console.info(`collision scan: ${result.latency.mean.toFixed(2)} ms mean, ${result.latency.p75.toFixed(2)} ms p75`);
});
