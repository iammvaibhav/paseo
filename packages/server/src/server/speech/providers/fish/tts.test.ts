import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FishTTS } from "./tts.js";

describe("FishTTS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("posts Fish Audio TTS request with model header and streams mp3 body", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    let chunkIndex = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[chunkIndex]);
        chunkIndex += 1;
      },
    });

    const fetchMock = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new FishTTS(
      {
        apiKey: "fish-key",
        model: "s2.1-pro-free",
        voice: "933563129e564b19a115bedd57b7406a",
        latency: "balanced",
        speed: 1.35,
        format: "mp3",
      },
      pino({ level: "silent" }),
    );

    const result = await provider.synthesizeSpeech("Hello from Paseo voice mode.");
    expect(result.format).toBe("mp3");

    const collected: Buffer[] = [];
    for await (const chunk of result.stream) {
      collected.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(collected)).toEqual(Buffer.from([1, 2, 3, 4]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer fish-key");
    expect(headers.get("model")).toBe("s2.1-pro-free");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Hello from Paseo voice mode.",
      reference_id: "933563129e564b19a115bedd57b7406a",
      format: "mp3",
      latency: "balanced",
      normalize: true,
      prosody: { speed: 1.35 },
    });
  });

  test("throws on non-OK Fish Audio responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("quota exceeded", { status: 429 })),
    );

    const provider = new FishTTS({ apiKey: "fish-key" }, pino({ level: "silent" }));
    await expect(provider.synthesizeSpeech("hello")).rejects.toThrow(/HTTP 429/);
  });
});
