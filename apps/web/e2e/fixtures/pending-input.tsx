import { I18nProvider } from "@lingui/react";
import type { ThreadMessage } from "@rakazo/contracts";
import { pendingInputMessages, projectMessages, withoutPendingInputs } from "@rakazo/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PendingInputRequests } from "../../src/components/messages/PendingInputRequests";
import { bootstrapI18n, i18n } from "../../src/lib/locale/i18n";
import { queryClient } from "../../src/lib/query/query";
import { Composer } from "../../src/pages/shell/composer/composer";
import { FixtureTranscript } from "./thread-fixture";
import "../../src/styles.css";

const createdAt = "2026-01-01T12:00:00.000Z";
const request: ThreadMessage = {
  id: "request",
  threadId: "thread",
  runId: "run",
  role: "bot",
  createdAt,
  seq: 1,
  blocks: [
    {
      kind: "ask",
      input: "secret",
      status: "pending",
      text: "Delivery information",
      credential: { name: "delivery", origin: "", auth: { type: "contact" } },
    },
  ],
};
const history: ThreadMessage[] = Array.from({ length: 25 }, (_, i) => ({
  id: `message-${i}`,
  threadId: "thread",
  role: i % 2 ? "user" : "bot",
  createdAt,
  seq: i + 2,
  blocks: [
    {
      kind: "text",
      text: i % 2 ? "Compare another option." : "I found another option and saved the comparison.",
    },
  ],
}));
const noop = () => {};
function Fixture() {
  const [answered, setAnswered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const run = { id: "run", status: answered ? "completed" : "waiting_input", userId: "owner" };
  const messages = [
    {
      ...request,
      blocks: request.blocks.map((block) =>
        block.kind === "ask" && answered
          ? {
              ...block,
              status: "answered" as const,
              dismissed: dismissed ? (true as const) : undefined,
              answer: "",
            }
          : block,
      ),
    },
    ...history,
  ];
  // Exercise the same snapshot projection that used to resurrect Working after reload.
  const live = projectMessages(
    [
      {
        id: "tool",
        threadId: "thread",
        runId: "run",
        seq: 1,
        createdAt,
        type: "agent.tool.called",
        payload: { name: "request_secret" },
      },
    ],
    [run],
  );
  const pending = pendingInputMessages({ messages, activeRuns: [run] }, "owner");
  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-hidden [&>main]:h-full">
        <FixtureTranscript
          messages={[...withoutPendingInputs(messages, pending), ...live]}
          running={false}
          showToolActivity
        />
      </div>
      <div className="pointer-events-none relative z-30 -mt-7">
        <PendingInputRequests
          messages={pending}
          onAnswer={async (_message, _text, _fields, dismiss) => {
            setDismissed(Boolean(dismiss));
            setAnswered(true);
          }}
        />
        <Composer
          artifactTarget={{ botId: "bot-1" }}
          activeName="Shopping assistant"
          running={false}
          pendingAttachments={[]}
          attachmentNotice={null}
          sendError={null}
          runError={null}
          runErrorId={null}
          onOpenModels={noop}
          onOpenConnections={noop}
          onOpenBilling={noop}
          onRunErrorPresented={noop}
          onDismissError={noop}
          sending={false}
          fileInputRef={fileInput}
          onAttachmentPick={() => true}
          onRemoveAttachment={noop}
          onSend={async () => true}
          onStop={async () => {}}
          draftKey="pending-input-fixture"
          enterToSend
          mentionTargets={[]}
          agentSkills={[]}
        />
      </div>
    </main>
  );
}
void bootstrapI18n("en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <Fixture />
      </I18nProvider>
    </QueryClientProvider>,
  ),
);
