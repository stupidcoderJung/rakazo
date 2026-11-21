import type { LoginFieldInput, ThreadMessage } from "@rakazo/contracts";
import type { RpcClient } from "../../lib/query/rpc";
import { AskCard } from "./AskCard";

/** The existing input controls, kept beside the composer until the request is resolved. */
export function PendingInputRequests({
  messages,
  onAnswer,
  rpc,
}: {
  messages: readonly ThreadMessage[];
  onAnswer: (
    message: ThreadMessage,
    text: string,
    fields?: LoginFieldInput[],
    dismiss?: boolean,
    remember?: false,
  ) => Promise<void>;
  rpc?: RpcClient;
}) {
  if (!messages.length) return null;
  return (
    <div
      data-testid="pending-input-requests"
      className="pointer-events-auto max-h-[35vh] overflow-y-auto bg-background px-3 pb-2 pt-7"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-2">
        {messages.map((message) =>
          message.blocks.map((block, index) =>
            block.kind === "ask" ? (
              <AskCard
                key={`${message.id}:${index}`}
                block={block}
                canAnswer
                canDismiss
                onAnswer={(text, fields, remember) =>
                  onAnswer(message, text, fields, undefined, remember)
                }
                onDismiss={() => onAnswer(message, "", undefined, true)}
                rpc={rpc}
              />
            ) : null,
          ),
        )}
      </div>
    </div>
  );
}
