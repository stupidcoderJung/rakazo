import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import {
  MAX_SYNTHESIZED_AUDIO_BYTES,
  MAX_VOICE_JSON_BYTES,
  readVoiceJson,
  speechUploadName,
  voiceDeadline,
  voiceLanguageHint,
  voiceRequestError,
  voiceUnreachable,
} from "./voice-http.js";

const API = "https://api.minimax.io/v1";
const SPEECH_MODEL = "speech-2.8-hd";

export class MiniMaxVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "minimax",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      await this.listVoices(apiKey, context);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error && error.message.startsWith("MiniMax")
            ? error.message
            : voiceUnreachable("MiniMax"),
      };
    }
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const res = await fetch(`${API}/get_voice`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ voice_type: "all" }),
      signal: voiceDeadline(context.signal, 20_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    checkResponse(res, body);
    const record = body as Record<string, unknown>;
    const voices = new Map<string, VoiceInfo>();
    for (const category of ["system_voice", "voice_cloning", "voice_generation"]) {
      const items = record[category];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item.voice_id !== "string" || !item.voice_id.trim()) continue;
        voices.set(item.voice_id, {
          id: item.voice_id,
          label:
            typeof item.voice_name === "string" && item.voice_name
              ? item.voice_name
              : item.voice_id,
          description: Array.isArray(item.description)
            ? item.description.filter((part: unknown) => typeof part === "string").join(" · ") ||
              undefined
            : undefined,
        });
      }
    }
    return [...voices.values()];
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${API}/t2a_v2`, {
      method: "POST",
      headers: headers(request.apiKey),
      body: JSON.stringify({
        model: request.model || SPEECH_MODEL,
        text: request.text,
        stream: false,
        output_format: "hex",
        language_boost: "auto",
        voice_setting: { voice_id: request.voiceId, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      }),
      signal,
    });
    // Hex needs two bytes per audio byte; catalog/error responses keep the smaller JSON cap.
    const body = await readVoiceJson(res, {
      requireValid: res.ok,
      maxBytes: res.ok
        ? MAX_SYNTHESIZED_AUDIO_BYTES * 2 + MAX_VOICE_JSON_BYTES
        : MAX_VOICE_JSON_BYTES,
      signal,
    });
    checkResponse(res, body);
    const audio = (body as { data?: { audio?: unknown } }).data?.audio;
    if (
      typeof audio !== "string" ||
      !audio.length ||
      audio.length % 2 ||
      !/^[\da-f]+$/i.test(audio)
    ) {
      throw new Error("MiniMax returned invalid audio.");
    }
    if (audio.length / 2 > MAX_SYNTHESIZED_AUDIO_BYTES)
      throw new Error("Voice response is too large.");
    return { bytes: new Uint8Array(Buffer.from(audio, "hex")), mimeType: "audio/mpeg" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    if (!request.mimeType || request.mimeType.toLowerCase().includes("webm")) {
      throw new Error(
        "MiniMax does not accept WebM recordings. Use on-device dictation or another transcription provider.",
      );
    }
    const form = new FormData();
    form.set("model", "asr-1.0");
    form.set("response_format", "json");
    form.set(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType }),
      speechUploadName(request.mimeType),
    );
    const language = voiceLanguageHint(request.language);
    const res = await fetch(`${API}/speech_to_text`, {
      method: "POST",
      headers: { Authorization: `Bearer ${request.apiKey}`, ...(language ? { language } : {}) },
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw voiceRequestError(res.status, "MiniMax", "transcribing", null);
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== "string") throw new Error("MiniMax returned an invalid transcript.");
    return { text: text.trim() };
  }
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function checkResponse(res: Response, body: unknown): void {
  // Application errors can arrive with HTTP 200. Never expose provider messages, which may
  // repeat submitted text or credentials, and never mistake such an error for audio.
  if (!res.ok) throw voiceRequestError(res.status, "MiniMax", "Voice request", null);
  const code = (body as { base_resp?: { status_code?: unknown } } | null)?.base_resp?.status_code;
  if (code === 0) return;
  if (code === 1004 || code === 2049)
    throw voiceRequestError(401, "MiniMax", "Voice request", null);
  if (code === 1008 || code === 2053 || code === 2056 || code === 2067) {
    throw voiceRequestError(402, "MiniMax", "Voice request", null);
  }
  if (code === 1002 || code === 1039 || code === 1045 || code === 2062) {
    throw voiceRequestError(429, "MiniMax", "Voice request", null);
  }
  throw new Error(
    `MiniMax voice request failed${typeof code === "number" ? ` (${code})` : ": invalid response"}.`,
  );
}
