import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";

type Ask = Extract<MessageBlock, { kind: "ask" }>;

/** Match protected destinations, never the model's free-form description of a request. */
export function samePendingSecretRequest(left: Ask, right: Ask): boolean {
  if (
    left.status === "answered" ||
    right.status === "answered" ||
    left.input !== "secret" ||
    right.input !== "secret" ||
    !left.credential ||
    !right.credential ||
    left.oneTimeCode ||
    right.oneTimeCode
  )
    return false;
  const a = left.credential;
  const b = right.credential;
  return (
    left.purpose === right.purpose &&
    left.sharedBrowser === right.sharedBrowser &&
    a.name === b.name &&
    a.origin === b.origin &&
    JSON.stringify(a.auth) === JSON.stringify(b.auth) &&
    JSON.stringify(left.loginFields ?? null) === JSON.stringify(right.loginFields ?? null) &&
    JSON.stringify(left.replaces ?? null) === JSON.stringify(right.replaces ?? null)
  );
}

/** Only the run owner gets an actionable dock; other people's cards stay in the transcript. */
export function pendingInputMessages<M extends Pick<ThreadMessage, "id" | "runId" | "blocks">>(
  snapshot: {
    messages: readonly M[];
    run?: { id: string; status: string; userId?: string } | null;
    activeRuns?: readonly { id: string; status: string; userId?: string }[];
  } | null,
  userId?: string,
): M[] {
  if (!snapshot || !userId) return [];
  const waiting = new Set(
    (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []))
      .filter((run) => run.status === "waiting_input" && run.userId === userId)
      .map((run) => run.id),
  );
  return snapshot.messages.flatMap((message) => {
    if (!message.runId || !waiting.has(message.runId)) return [];
    const blocks = message.blocks.filter(
      (block) => block.kind === "ask" && block.status !== "answered",
    );
    return blocks.length ? [{ ...message, blocks }] : [];
  });
}

/** Keep history and mixed-message content, but show each pending question in only one place. */
export function withoutPendingInputs<M extends Pick<ThreadMessage, "id" | "blocks">>(
  messages: readonly M[],
  pending: readonly Pick<M, "id">[],
): M[] {
  const ids = new Set(pending.map((message) => message.id));
  return messages.flatMap((message) => {
    if (!ids.has(message.id)) return [message];
    const blocks = message.blocks.filter(
      (block) => block.kind !== "ask" || block.status === "answered",
    );
    return blocks.length ? [{ ...message, blocks }] : [];
  });
}
