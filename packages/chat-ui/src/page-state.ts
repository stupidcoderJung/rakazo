import type { PageState } from "@rakazo/contracts";
import { errorCode } from "@rakazo/core";
import { useCallback, useEffect, useRef } from "react";

export type PageStateSave = { pageId: string; values: PageState };

const REFUSED = new Set(["BAD_REQUEST", "PAGE_STATE_LIMIT", "NOT_FOUND", "FORBIDDEN"]);

/** Whether saving again could help: the server refuses the same values every time. */
export function pageStateRetryable(error: unknown): boolean {
  const code = errorCode(error);
  return !(typeof code === "string" && REFUSED.has(code));
}

/** A cached page read with the values just saved, so reopening or redrawing it shows them. */
export function withSavedValues<T extends { readerState?: PageState }>(
  read: T | undefined,
  values: PageState,
): T | undefined {
  return read?.readerState ? { ...read, readerState: { ...read.readerState, ...values } } : read;
}

/**
 * What a reader changed on a page, saved one request at a time: changes made while one is out go
 * in the next, a failed one goes again with the next, and one the server refused is dropped.
 */
export function usePageStateQueue(pageId: string, run: (save: PageStateSave) => void) {
  const send = useRef(run);
  send.current = run;
  const queued = useRef(new Map<string, PageState>());
  const sending = useRef(false);
  const shown = useRef(pageId);
  shown.current = pageId;
  const take = useCallback((id: string): PageStateSave | undefined => {
    const values = queued.current.get(id);
    if (!values) return;
    queued.current.delete(id);
    return { pageId: id, values };
  }, []);
  const next = useCallback(() => {
    if (sending.current) return;
    const save = take(shown.current);
    if (!save) return;
    sending.current = true;
    send.current(save);
  }, [take]);
  useEffect(() => next(), [pageId, next]);
  return {
    save(values: PageState) {
      queued.current.set(pageId, { ...queued.current.get(pageId), ...values });
      next();
    },
    async drain(first: PageStateSave, write: (save: PageStateSave) => Promise<void>) {
      let save: PageStateSave | undefined = first;
      while (save) {
        try {
          await write(save);
        } catch (error) {
          if (pageStateRetryable(error)) {
            queued.current.set(save.pageId, {
              ...save.values,
              ...queued.current.get(save.pageId),
            });
            throw error;
          }
          if (!queued.current.has(save.pageId)) throw error;
        }
        // The save owns its page and scoped RPC even after the viewer closes.
        save = take(first.pageId);
      }
    },
    finished(save: PageStateSave, error?: Error) {
      sending.current = false;
      if (!error || !pageStateRetryable(error) || save.pageId !== shown.current) next();
    },
    retry: next,
  };
}
