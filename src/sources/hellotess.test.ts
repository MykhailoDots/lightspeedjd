import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import fs from "fs";
import path from "path";
import dayjs from "../helper/customDayJs";
import {
  HISTORICAL_IMPORT_STATUS_FILE,
  checkHistoricalImportDone,
  markHistoricalImportDone,
  processInvoices,
  type HelloTESSInvoice,
} from "./hellotess";
import type { HelloTESSSourceConfig } from "../config";

const axiosGetMock = mock(async () => ({ data: [] }));

beforeAll(() => {
  mock.module("axios", () => ({
    default: { get: axiosGetMock },
    get: axiosGetMock,
  }));
});

const testStatusFile = path.join(
  process.cwd(),
  `${HISTORICAL_IMPORT_STATUS_FILE}_test-source_example.host`
);

afterEach(() => {
  axiosGetMock.mockReset();

  if (fs.existsSync(testStatusFile)) {
    fs.unlinkSync(testStatusFile);
  }
});

const makeSource = (
  partial?: Partial<HelloTESSSourceConfig>
): HelloTESSSourceConfig => ({
  name: "test-source",
  type: "hellotess",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: { enabled: false, name: "Umsatz" },
  metricTypeMappings: [],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  apiKey: "api-key",
  host: "example.host",
  daysPast: 1,
  daysFuture: 0,
  ...partial,
});

const makeInvoice = (
  partial?: Partial<HelloTESSInvoice>
): HelloTESSInvoice => ({
  id: "1",
  number: "inv-1",
  date: "2025-01-10T12:00:00.000Z",
  cancelled: false,
  articles: [],
  totals: {
    gross: 12000,
    net: 10000,
    tax: 2000,
    subvention: 0,
    surcharge: 0,
  },
  location: {
    store: {
      id: "store-1",
      name: "Store A",
      number: 1,
    },
  },
  ...partial,
});

describe("hellotess helpers", () => {
  it("creates and detects historical import status file", async () => {
    expect(await checkHistoricalImportDone("test-source", "example.host")).toBe(
      false
    );
    await markHistoricalImportDone("test-source", "example.host");
    expect(await checkHistoricalImportDone("test-source", "example.host")).toBe(
      true
    );
  });

  it("processes invoices using net revenue by default", () => {
    const metrics = processInvoices(
      [makeInvoice()],
      makeSource(),
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "Store A",
      metricType: "Umsatz",
      value: "100",
      metricTypeCategory: "Ist",
    });
  });

  it("supports storeId cost center and gross revenue mode", () => {
    const metrics = processInvoices(
      [makeInvoice()],
      makeSource({ revenueType: "gross", costCenterFrom: "storeId" }),
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "store-1",
      value: "120",
    });
  });

  it("imports and aggregates recent invoices from API", async () => {
    const todayIso = dayjs().toISOString();

    axiosGetMock.mockResolvedValueOnce({
      data: [
        makeInvoice({
          date: todayIso,
          totals: { gross: 12000, net: 10000, tax: 2000, subvention: 0, surcharge: 0 },
        }),
        makeInvoice({
          id: "2",
          number: "inv-2",
          date: todayIso,
          totals: { gross: 6000, net: 5000, tax: 1000, subvention: 0, surcharge: 0 },
        }),
      ],
    });

    const { importFromHelloTESS } = await import("./hellotess.ts?case=recent-import");
    const metrics = await importFromHelloTESS(
      makeSource({ daysPast: 0, daysFuture: 0 }),
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "Store A",
      metricType: "Umsatz",
      value: "150",
    });
  });

  it("runs historical batches and marks import status as completed", async () => {
    const sourceName = "historical-source";
    const host = "historical.example";
    const historicalStatusFile = path.join(
      process.cwd(),
      `${HISTORICAL_IMPORT_STATUS_FILE}_${sourceName}_${host}`
    );

    if (fs.existsSync(historicalStatusFile)) {
      fs.unlinkSync(historicalStatusFile);
    }

    axiosGetMock.mockResolvedValue({ data: [] });

    const { importFromHelloTESS } = await import("./hellotess.ts?case=historical-import");
    const metrics = await importFromHelloTESS(
      makeSource({
        name: sourceName,
        host,
        daysPast: 0,
        daysFuture: 0,
        historicalImport: {
          enabled: true,
          startDate: dayjs().subtract(2, "day").format("YYYY-MM-DD"),
          batchSizeInDays: 1,
          rateLimitDelayMs: 0,
        },
      }),
      "Europe/Zurich"
    );

    expect(metrics).toEqual([]);
    expect(fs.existsSync(historicalStatusFile)).toBe(true);

    if (fs.existsSync(historicalStatusFile)) {
      fs.unlinkSync(historicalStatusFile);
    }
  });
});
