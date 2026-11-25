// @vitest-environment jsdom
import { PageStateSchema } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PageStateSave } from "./page-state";
import { pageStateRetryable, usePageStateQueue, withSavedValues } from "./page-state";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("retries failed page changes with later edits and drops changes the server refused", async () => {
  const sent: PageStateSave[] = [];
  const offline = deferred<void>();
  const refused = deferred<void>();
  let queue!: ReturnType<typeof usePageStateQueue>;
  let completed!: Promise<void>;
  const write = vi.fn(async (save: PageStateSave) => {
    sent.push(save);
    if (sent.length === 1) await offline.promise;
    if (sent.length === 2) await refused.promise;
  });
  function Queue() {
    queue = usePageStateQueue("page-1", (save) => {
      completed = queue.drain(save, write).then(
        () => queue.finished(save),
        (error: Error) => queue.finished(save, error),
      );
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Queue />));
  queue.save({ a: 1 });
  queue.save({ b: 2 });
  expect(sent).toEqual([{ pageId: "page-1", values: { a: 1 } }]);
  offline.reject(new Error("offline"));
  await completed;
  queue.save({ c: 3 });
  expect(sent[1]).toEqual({ pageId: "page-1", values: { a: 1, b: 2, c: 3 } });
  queue.save({ d: 4 });
  refused.reject(Object.assign(new Error("too much"), { code: "PAGE_STATE_LIMIT" }));
  await completed;
  expect(sent[2]).toEqual({ pageId: "page-1", values: { d: 4 } });
  queue.retry();
  expect(sent).toHaveLength(3);
  expect(pageStateRetryable(new Error("offline"))).toBe(true);
  expect(pageStateRetryable({ code: "PAGE_STATE_LIMIT" })).toBe(false);
  act(() => root.unmount());
});

it("drains edits added before the page viewer unmounts", async () => {
  const first = deferred<void>();
  const write = vi.fn<(save: PageStateSave) => Promise<void>>().mockResolvedValue(undefined);
  write.mockReturnValueOnce(first.promise);
  let queue!: ReturnType<typeof usePageStateQueue>;
  let drained!: Promise<void>;
  function Queue() {
    queue = usePageStateQueue("page-1", (save) => {
      // The scoped write finishes even when the screen's completion callbacks are skipped.
      drained = queue.drain(save, write);
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Queue />));
  queue.save({ a: 1 });
  queue.save({ b: 2 });
  act(() => root.unmount());
  first.resolve();
  await drained;

  expect(write).toHaveBeenNthCalledWith(2, { pageId: "page-1", values: { b: 2 } });
});

it.each([
  [
    "count",
    Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, index])),
    { next: true },
  ],
  ["bytes", { note: "가".repeat(12_000) }, { description: "나".repeat(12_000) }],
])("keeps queued writes within the request %s limit", async (_, left, right) => {
  const first = deferred<void>();
  const writes: PageStateSave[] = [];
  const write = async (save: PageStateSave) => {
    writes.push(save);
    if (writes.length === 1) await first.promise;
    expect(PageStateSchema.safeParse(save.values).success).toBe(true);
  };
  let queue!: ReturnType<typeof usePageStateQueue>;
  let drained!: Promise<void>;
  function Queue() {
    queue = usePageStateQueue("page-1", (save) => {
      drained = queue.drain(save, write);
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Queue />));
  queue.save({ initial: true });
  queue.save(left);
  queue.save(right);
  first.resolve();
  await drained;

  expect(writes.map((save) => save.values)).toEqual([{ initial: true }, left, right]);
  act(() => root.unmount());
});

it("adds saved values to a page read that carries the reader's values, and only to one", () => {
  const read = { code: "x", readerState: { a: 1, b: 2 } };
  expect(withSavedValues(read, { b: 3 })).toEqual({ code: "x", readerState: { a: 1, b: 3 } });
  const older: { code: string; readerState?: { b: number } } = { code: "old version" };
  expect(withSavedValues(older, { b: 3 })).toEqual({ code: "old version" });
});
