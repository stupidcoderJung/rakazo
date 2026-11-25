import type { PageStateSave } from "@rakazo/chat-ui/page-state";
import { pageStateRetryable, usePageStateQueue, withSavedValues } from "@rakazo/chat-ui/page-state";
import type { PageState } from "@rakazo/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useSave } from "../query/query";
import { useEventListener } from "../use-event-listener";

/** Saves what the reader set on a page and keeps the page read at `read` showing it. */
export function usePageStateSaver(pageId: string, read: QueryKey) {
  const queryClient = useQueryClient();
  const queue = usePageStateQueue(pageId, (save) => saver.run(save));
  const saver = useSave({
    save: (input: PageStateSave, rpc) =>
      queue.drain(input, async (save) => {
        await rpc.pageReviews.saveState(save);
        queryClient.setQueryData<{ readerState?: PageState }>(read, (cached) =>
          withSavedValues(cached, save.values),
        );
      }),
    onSaved: (_, input) => queue.finished(input),
    onFailed: (error, input) => queue.finished(input, error),
  });
  const failed =
    saver.error !== null &&
    !saver.pending &&
    saver.input?.pageId === pageId &&
    pageStateRetryable(saver.error);
  useEventListener(failed ? window : null, "focus", queue.retry);
  useEventListener(failed ? window : null, "online", queue.retry);
  return { save: queue.save, failed };
}
