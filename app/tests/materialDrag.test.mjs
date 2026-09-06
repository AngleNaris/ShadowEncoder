import assert from 'node:assert/strict';
import test from 'node:test';
import { MATERIAL_DROP_EVENT, startMaterialDrag } from '../src/lib/materialDrag.ts';

test('internal material pointer drag respects threshold, cancellation and cleanup', () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const badges = new Set();
  globalThis.window = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 });
  globalThis.document = {
    createElement: () => ({ style: {}, offsetWidth: 100, offsetHeight: 24, isConnected: false,
      remove() { this.isConnected = false; badges.delete(this); } }),
    body: { append(badge) { badge.isConnected = true; badges.add(badge); } },
  };
  const send = (type, fields) => window.dispatchEvent(Object.assign(new Event(type), fields));
  const drops = [];
  window.addEventListener(MATERIAL_DROP_EVENT, event => drops.push(event.detail));
  const origin = { pointerId: 1, clientX: 10, clientY: 10 };
  try {
    startMaterialDrag(origin, 'one.mp4');
    send('pointermove', { ...origin, clientX: 12 });
    send('pointerup', origin);
    assert.equal(drops.length, 0);
    startMaterialDrag(origin, 'one.mp4');
    send('pointermove', { ...origin, clientX: 100 });
    assert.equal(badges.size, 1);
    send('pointerup', { ...origin, clientX: 100, clientY: 200 });
    assert.deepEqual(drops, [{ path: 'one.mp4', x: 100, y: 200 }]);
    assert.equal(badges.size, 0);
    for (const cancellation of ['keydown', 'pointercancel', 'blur']) {
      startMaterialDrag(origin, 'canceled.mp4');
      send('pointermove', { ...origin, clientX: 100 });
      send(cancellation, { key: 'Escape' });
      send('pointerup', origin);
      assert.equal(badges.size, 0);
      assert.equal(drops.length, 1);
    }
    const cleanup = startMaterialDrag(origin, 'unmounted.mp4');
    cleanup();
    send('pointermove', { ...origin, clientX: 100 });
    send('pointerup', origin);
    assert.equal(badges.size, 0);
    assert.equal(drops.length, 1);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
