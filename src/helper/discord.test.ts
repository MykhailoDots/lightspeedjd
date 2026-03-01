import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { setRequiredEnvForConfig } from "../test-utils/mocks";

beforeAll(() => {
  setRequiredEnvForConfig();
});

afterEach(() => {
  mock.restore();
});

describe("sendMessageToDiscord", () => {
  it("sends formatted message payload", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    );
    (globalThis as any).fetch = fetchMock;

    const { sendMessageToDiscord } = await import("./discord");
    await sendMessageToDiscord({
      message: "hello world",
      includeTimestamp: false,
      includeClientName: true,
      topSeparator: true,
      bottomSeparator: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const body = JSON.parse(call[1].body as string);
    expect(body.content).toContain("hello world");
    expect(body.content).toContain("client-name");
  });

  it("handles non-ok webhook responses without throwing", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response("nope", { status: 500 }))
    );
    (globalThis as any).fetch = fetchMock;

    const { sendMessageToDiscord } = await import("./discord");
    await expect(
      sendMessageToDiscord({
        message: "failed request",
        includeTimestamp: false,
      })
    ).resolves.toBeUndefined();
  });
});
