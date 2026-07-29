import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshCoalescer } from "./index.ts";

function timer() {
  const callbacks = new Map();
  let next = 0;
  return {
    callbacks,
    setTimeout(callback, delay) {
      const id = ++next;
      callbacks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    },
  };
}

test("BTW streaming refreshes coalesce and boundaries flush immediately", () => {
  const clock = timer();
  let renders = 0;
  const refresh = createRefreshCoalescer(() => renders++, 40, clock);

  refresh.request();
  refresh.request();
  refresh.request();
  assert.equal(clock.callbacks.size, 1);
  assert.equal([...clock.callbacks.values()][0].delay, 40);
  assert.equal(renders, 0);

  refresh.flush();
  assert.equal(renders, 1);
  assert.equal(clock.callbacks.size, 0);

  refresh.request();
  const [{ callback }] = clock.callbacks.values();
  callback();
  assert.equal(renders, 2);
});

test("BTW final flush clears queued refresh", () => {
  const clock = timer();
  let renders = 0;
  const refresh = createRefreshCoalescer(() => renders++, 40, clock);
  refresh.request();
  refresh.flush();
  assert.equal(clock.callbacks.size, 0);
  assert.equal(renders, 1);
});
