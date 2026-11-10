import { VoiceAccountError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MiniMaxVoiceProvider } from "./minimax-voice.js";
import { createVoiceProvider, voiceCatalogEntry } from "./voice-factory.js";
import { MAX_SYNTHESIZED_AUDIO_BYTES, MAX_VOICE_JSON_BYTES } from "./voice-http.js";

const context = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};
const request = { text: "안녕하세요.", voiceId: "Korean_CalmLady", apiKey: "fake-key" };
const provider = new MiniMaxVoiceProvider();
const ok = { base_resp: { status_code: 0 } };
function wire(body: unknown, status = 200) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe("MiniMax voice", () => {
  it("uses the shared settings catalog and provider contract", () => {
    expect(voiceCatalogEntry("minimax")).toMatchObject({ speechModel: true, transcribe: true });
    expect(createVoiceProvider("minimax").describe()).toMatchObject({
      id: "minimax",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    });
  });
  it("verifies speech access and lists system, cloned and generated voices", async () => {
    const fetchMock = wire({
      ...ok,
      system_voice: [
        null,
        { voice_id: "ko", voice_name: "Korean voice", description: ["Calm", 1] },
        {},
      ],
      voice_cloning: [{ voice_id: "cloned" }],
      voice_generation: [{ voice_id: "generated" }],
    });
    await expect(provider.verify("fake-key", context)).resolves.toEqual({ ok: true });
    await expect(provider.listVoices("fake-key", context)).resolves.toEqual([
      { id: "ko", label: "Korean voice", description: "Calm" },
      { id: "cloned", label: "cloned", description: undefined },
      { id: "generated", label: "generated", description: undefined },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.minimax.io/v1/get_voice");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ voice_type: "all" });
  });
  it.each([undefined, "speech-2.8-turbo"])(
    "decodes MP3 and honors model override %s",
    async (model) => {
      const fetchMock = wire({ ...ok, data: { audio: "494433ff" } });
      await expect(provider.synthesize({ ...request, model }, context)).resolves.toEqual({
        bytes: new Uint8Array([73, 68, 51, 255]),
        mimeType: "audio/mpeg",
      });
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        model: model ?? "speech-2.8-hd",
        text: request.text,
        output_format: "hex",
        stream: false,
        language_boost: "auto",
        voice_setting: { voice_id: request.voiceId },
        audio_setting: { format: "mp3" },
      });
    },
  );
  it.each([1004, 2049, 1008, 2053, 2056, 2067])(
    "classifies application-level account error %s even on HTTP 200",
    async (code) => {
      wire({ base_resp: { status_code: code, status_msg: "private submitted text fake-key" } });
      await expect(provider.synthesize(request, context)).rejects.toMatchObject({
        code: [1004, 2049].includes(code) ? "VOICE_KEY_REJECTED" : "VOICE_OUT_OF_CREDIT",
      });
      const result = await provider.verify("fake-key", context);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("private");
      expect(JSON.stringify(result)).not.toContain("fake-key");
    },
  );
  it.each([1002, 2062, 2013])(
    "keeps non-account error %s distinct from credit exhaustion",
    async (code) => {
      wire({ base_resp: { status_code: code } });
      const error = await provider.synthesize(request, context).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(VoiceAccountError);
    },
  );
  it.each(["", "abc", "zz", null, 123, "https://example.test/audio.mp3"])(
    "rejects invalid audio %s",
    async (audio) => {
      const fetchMock = wire({ ...ok, data: { audio } });
      await expect(provider.synthesize(request, context)).rejects.toThrow("invalid audio");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("accepts audio JSON beyond the catalog cap, but rejects oversized audio", async () => {
    wire({ ...ok, data: { audio: "ab".repeat(MAX_VOICE_JSON_BYTES) } });
    expect((await provider.synthesize(request, context)).bytes.length).toBe(MAX_VOICE_JSON_BYTES);
    wire({ ...ok, data: { audio: "ab".repeat(MAX_SYNTHESIZED_AUDIO_BYTES + 1) } });
    await expect(provider.synthesize(request, context)).rejects.toThrow("too large");
  });
  it("caps unknown-length streamed JSON before decoding audio", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024));
              },
              cancel: cancelled,
            }),
          ),
      ),
    );
    await expect(provider.synthesize(request, context)).rejects.toThrow("too large");
    expect(cancelled).toHaveBeenCalled();
  });
  it("keeps the voice catalog response bounded", async () => {
    wire({ ...ok, padding: "x".repeat(MAX_VOICE_JSON_BYTES) });
    await expect(provider.listVoices("fake-key", context)).rejects.toThrow("too large");
  });
  it.each([null, {}, { base_resp: { status_code: "0" } }])(
    "rejects missing or malformed success envelopes",
    async (body) => {
      wire(body);
      await expect(provider.listVoices("fake-key", context)).rejects.toThrow("invalid response");
    },
  );
  it("sends Korean ASR hints and an audio file without forcing a multipart boundary", async () => {
    const fetchMock = wire({ text: " 안녕하세요. " });
    await expect(
      provider.transcribe(
        {
          audio: new Uint8Array([1, 2]),
          mimeType: "audio/mp4",
          language: "ko-KR",
          apiKey: "fake-key",
        },
        context,
      ),
    ).resolves.toEqual({ text: "안녕하세요." });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.minimax.io/v1/speech_to_text");
    expect(init?.headers).toEqual({ Authorization: "Bearer fake-key", language: "ko" });
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("asr-1.0");
    expect((form.get("file") as File).name).toBe("speech.m4a");
  });
  it("explains unsupported browser recordings without uploading them", async () => {
    const fetchMock = wire({});
    await expect(
      provider.transcribe(
        { audio: new Uint8Array([1]), mimeType: "audio/webm;codecs=opus", apiKey: "fake-key" },
        context,
      ),
    ).rejects.toThrow("does not accept WebM");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects malformed transcripts and HTTP authentication failures", async () => {
    const transcribe = () =>
      provider.transcribe(
        { audio: new Uint8Array([1]), mimeType: "audio/mpeg", apiKey: "fake-key" },
        context,
      );
    wire({ text: 1 });
    await expect(transcribe()).rejects.toThrow("invalid transcript");
    wire({ error: { message: "private" } }, 401);
    await expect(transcribe()).rejects.toMatchObject({ code: "VOICE_KEY_REJECTED" });
  });
  it("cancels a stalled audio JSON body", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => controller.abort(), 0);
        return new Response(new ReadableStream({ cancel: cancelled }));
      }),
    );
    await expect(
      provider.synthesize({ ...request, signal: controller.signal }, context),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalled();
  });
  it("passes caller cancellation through the synthesis deadline", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        init?.signal?.throwIfAborted();
        return new Response();
      }),
    );
    await expect(
      provider.synthesize({ ...request, signal: controller.signal }, context),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
