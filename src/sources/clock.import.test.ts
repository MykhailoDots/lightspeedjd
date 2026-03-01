import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import fs from "fs";
import path from "path";
import type { ClockSourceConfig } from "../config";
import { setRequiredEnvForConfig } from "../test-utils/mocks";

const digestFetchMock = mock(async (_url: string) => new Response("[]"));

beforeAll(() => {
  setRequiredEnvForConfig();

  mock.module("digest-fetch", () => ({
    default: class {
      constructor(_: unknown, __: unknown) {}
      fetch = digestFetchMock;
    },
  }));
});

const makeClockConfig = (
  partial?: Partial<ClockSourceConfig>
): ClockSourceConfig => ({
  name: "clock-source",
  type: "clock",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: { enabled: false, name: "Umsatz" },
  metricTypeMappings: [{ importName: "RoomNightsRaw", jobdoneName: "RoomNights" }],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  costCenter: "Hotel A",
  metricType: "RoomNightsRaw",
  accountId: "account",
  subscriptionId: "subscription",
  subscriptionRegion: "eu",
  baseApi: "api",
  apiUser: "user",
  apiKey: "key",
  isCacheEnabled: true,
  isDoNotDeleteCacheEnabled: false,
  ...partial,
});

const cleanupClockArtifacts = async () => {
  const clockStatePath = path.resolve(process.cwd(), "clock-state.json");
  const cacheDir = path.resolve(process.cwd(), "cache");

  if (fs.existsSync(clockStatePath)) {
    fs.unlinkSync(clockStatePath);
  }

  if (fs.existsSync(cacheDir)) {
    const files = await fs.promises.readdir(cacheDir);
    for (const file of files) {
      fs.unlinkSync(path.join(cacheDir, file));
    }
    fs.rmdirSync(cacheDir);
  }
};

afterEach(async () => {
  digestFetchMock.mockReset();
  await cleanupClockArtifacts();
});

describe("clock source import flow", () => {
  it("aggregates expected bookings into Geplant metrics", async () => {
    digestFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/bookings")) {
        return new Response(JSON.stringify([101, 102]), { status: 200 });
      }
      if (url.endsWith("/bookings/101") || url.endsWith("/bookings/102")) {
        return new Response(
          JSON.stringify({
            id: 101,
            status: "expected",
            arrival: "2025-01-10",
            departure: "2025-01-11",
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const { importFromClock } = await import("./clock");
    const metrics = await importFromClock(
      makeClockConfig(),
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "Hotel A",
      metricType: "RoomNights",
      value: "2",
      metricTypeCategory: "Geplant",
    });
  });

  it("creates per-day Ist metrics and clears cache files", async () => {
    digestFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/bookings")) {
        return new Response(JSON.stringify([501]), { status: 200 });
      }
      if (url.endsWith("/bookings/501")) {
        return new Response(
          JSON.stringify({
            id: 501,
            status: "checked_in",
            arrival: "2025-01-20",
            departure: "2025-01-22",
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const { importFromClock } = await import("./clock");
    const metrics = await importFromClock(
      makeClockConfig({
        isCacheEnabled: true,
        isDoNotDeleteCacheEnabled: false,
      }),
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(2);
    expect(metrics.every((metric) => metric.metricTypeCategory === "Ist")).toBe(
      true
    );

    const cacheDir = path.resolve(process.cwd(), "cache");
    if (fs.existsSync(cacheDir)) {
      const files = fs.readdirSync(cacheDir);
      expect(files).toHaveLength(0);
    }
  });
});
