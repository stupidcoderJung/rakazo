import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  pendingInputMessages,
  samePendingSecretRequest,
  withoutPendingInputs,
} from "./pending-input.js";

const ask: Extract<MessageBlock, { kind: "ask" }> = {
  kind: "ask",
  input: "secret",
  status: "pending",
  text: "Delivery details",
  credential: { name: "delivery", origin: "", auth: { type: "contact" } },
};
describe("pending input", () => {
  it("matches the destination despite different explanatory text, without merging different inputs", () => {
    expect(samePendingSecretRequest(ask, { ...ask, text: "Recipient details" })).toBe(true);
    for (const other of [
      { ...ask, status: "answered" as const },
      { ...ask, credential: { ...ask.credential!, name: "billing" } },
      { ...ask, credential: { ...ask.credential!, auth: { type: "card" as const } } },
      { ...ask, credential: { ...ask.credential!, origin: "https://other.example.test" } },
      { ...ask, loginFields: ["Account", "Password"] },
      { ...ask, oneTimeCode: { origin: "https://example.test" } },
      { ...ask, credential: undefined },
    ])
      expect(samePendingSecretRequest(ask, other)).toBe(false);
  });
  it("docks only this user's pending cards, retains other content and restores answered history", () => {
    const message = {
      id: "ask",
      runId: "r",
      blocks: [{ kind: "text" as const, text: "Research" }, ask],
    };
    const snapshot = {
      messages: [message],
      activeRuns: [{ id: "r", status: "waiting_input", userId: "owner" }],
    };
    const pending = pendingInputMessages(snapshot, "owner");
    expect(pending[0]?.blocks).toEqual([ask]);
    expect(withoutPendingInputs(snapshot.messages, pending)[0]?.blocks).toEqual([
      message.blocks[0],
    ]);
    expect(pendingInputMessages(snapshot, "other")).toEqual([]);
    expect(
      pendingInputMessages(
        { ...snapshot, activeRuns: [{ id: "r", status: "running", userId: "owner" }] },
        "owner",
      ),
    ).toEqual([]);
    const answered = { ...message, blocks: [{ ...ask, status: "answered" as const }] };
    expect(pendingInputMessages({ ...snapshot, messages: [answered] }, "owner")).toEqual([]);
    expect(withoutPendingInputs([answered], [])).toEqual([answered]);
  });
});
