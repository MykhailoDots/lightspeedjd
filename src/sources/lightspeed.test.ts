import { afterEach, describe, expect, it, mock } from "bun:test";
import dayjs from "../helper/customDayJs";
import fs from "fs";
import path from "path";
import {
  buildAuthorizationUrlForLogging,
  buildDateStringsRange,
  computeCoversForSales,
  computeRevenueForSales,
  computeTransactionsForSales,
  importFromLightspeed,
  getEffectiveMetricCategory,
  getEffectiveMetricTypeName,
  getMappedMetricTypeName,
  getTokenCachePath,
  inferAuthVersion,
  isTokenValid,
  parseAmount,
  resolveApiBaseUrl,
  resolveAuthBaseUrl,
  resolveCostCenter,
  roundTo,
} from "./lightspeed";
import type { LightspeedSourceConfig } from "../config";
import { makeFetchResponse } from "../test-utils/mocks";

const tempTokenCacheFiles: string[] = [];

afterEach(() => {
  for (const filePath of tempTokenCacheFiles) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  tempTokenCacheFiles.length = 0;
});

const makeConfig = (
  partial?: Partial<LightspeedSourceConfig>
): LightspeedSourceConfig => ({
  name: "lightspeed-source",
  type: "lightspeed",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: { enabled: false, name: "Umsatz" },
  metricTypeMappings: [{ importName: "Revenue", jobdoneName: "Umsatz" }],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  environment: "demo",
  clientId: "devp-v2-client",
  clientSecret: "secret",
  redirectUri: "https://app.example.com/callback",
  refreshToken: "refresh-token",
  outputs: [
    {
      enabled: true,
      kind: "revenue",
      metricType: "Revenue",
      revenueType: "net",
    },
  ],
  daysPast: 1,
  daysFuture: 0,
  ...partial,
});

describe("lightspeed helpers", () => {
  it("parses and rounds numeric values", () => {
    expect(parseAmount("12.4")).toBe(12.4);
    expect(parseAmount("")).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(roundTo(12.3456, 2)).toBe(12.35);
  });

  it("resolves auth and API base URLs", () => {
    const config = makeConfig();
    expect(inferAuthVersion(config)).toBe("v2");
    expect(resolveApiBaseUrl(config)).toContain("trial");
    expect(resolveAuthBaseUrl(config)).toContain("demo");
  });

  it("builds auth URL and token cache path", () => {
    const config = makeConfig();
    const url = buildAuthorizationUrlForLogging(config);
    const cachePath = getTokenCachePath(config);

    expect(url).toContain("client_id=devp-v2-client");
    expect(url).toContain("redirect_uri=");
    expect(cachePath).toContain(".lightspeed-token-lightspeed-source-demo.json");
  });

  it("validates token expiry window", () => {
    const valid = {
      access_token: "x",
      expires_at: dayjs().add(10, "minute").toISOString(),
    } as any;
    const invalid = {
      access_token: "x",
      expires_at: dayjs().subtract(10, "minute").toISOString(),
    } as any;

    expect(isTokenValid(valid)).toBe(true);
    expect(isTokenValid(invalid)).toBe(false);
  });

  it("resolves cost center and metric type names", () => {
    const config = makeConfig({
      costCenterByBusinessLocationId: { "7": "cc-override" },
      outputs: [
        {
          enabled: true,
          kind: "revenue",
          metricType: "Revenue",
          metricTypeCategory: "Actual",
          revenueType: "net",
        },
      ],
    });

    const costCenter = resolveCostCenter(config, { id: 7, name: "Store 7" } as any);
    const mappedMetricType = getMappedMetricTypeName(config, "Revenue");
    const effectiveMetricType = getEffectiveMetricTypeName(
      config,
      config.outputs[0] as any
    );
    const effectiveCategory = getEffectiveMetricCategory(
      config,
      config.outputs[0] as any
    );

    expect(costCenter).toBe("cc-override");
    expect(mappedMetricType).toBe("Umsatz");
    expect(effectiveMetricType).toBe("Umsatz");
    expect(effectiveCategory).toBe("Actual");
  });

  it("builds date ranges and computes financial aggregates", () => {
    const config = makeConfig();
    const dates = buildDateStringsRange("Europe/Zurich", 1, 1);
    expect(dates.length).toBe(3);

    const sales = [
      {
        cancelled: false,
        type: "SALE",
        nbCovers: 4,
        salesLines: [
          {
            totalNetAmountWithoutTax: "100",
            taxAmount: "8",
            totalNetAmountWithTax: "108",
            taxLines: [{ taxIncluded: false }],
          },
        ],
      },
      {
        cancelled: false,
        type: "REFUND",
        nbCovers: 1,
        salesLines: [{ totalNetAmountWithoutTax: "-20", taxAmount: "-1.6" }],
      },
    ] as any;

    const revenue = computeRevenueForSales(sales, {
      enabled: true,
      kind: "revenue",
      metricType: "Revenue",
      revenueType: "gross",
    });
    const covers = computeCoversForSales(sales, {
      enabled: true,
      kind: "covers",
      metricType: "Covers",
    } as any);
    const tx = computeTransactionsForSales(sales, {
      enabled: true,
      kind: "transactions",
      metricType: "Transactions",
      saleTypesToInclude: ["SALE", "REFUND"],
    } as any);

    expect(revenue).toBeCloseTo(86.4, 5);
    expect(covers).toBe(4);
    expect(tx).toBe(2);
    expect(config.name).toBe("lightspeed-source");
  });

  it("imports daily revenue/covers/transactions/labor metrics", async () => {
    const todayLocal = dayjs().tz("Europe/Zurich").format("YYYY-MM-DD");
    const tokenCachePath = `.tmp-lightspeed-daily-${Date.now()}.json`;
    tempTokenCacheFiles.push(path.resolve(process.cwd(), tokenCachePath));

    const config = makeConfig({
      authVersion: "v1",
      clientId: "client-v1",
      tokenCachePath,
      metricTypeMappings: [],
      daysPast: 0,
      daysFuture: 0,
      salesFetchMode: "daily",
      outputs: [
        {
          enabled: true,
          kind: "revenue",
          metricType: "Revenue",
          revenueType: "net",
        },
        {
          enabled: true,
          kind: "covers",
          metricType: "Covers",
        },
        {
          enabled: true,
          kind: "transactions",
          metricType: "Transactions",
          saleTypesToInclude: ["SALE"],
        },
        {
          enabled: true,
          kind: "laborHours",
          metricType: "LaborHours",
          roundingDecimals: 1,
        },
      ],
    });

    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        return makeFetchResponse(200, {
          access_token: "token-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      }

      if (url.includes("/f/data/businesses")) {
        return makeFetchResponse(200, [
          {
            id: 1,
            name: "Business A",
            businessLocations: [{ id: 10, name: "Main" }],
          },
        ]);
      }

      if (url.includes("/sales-daily")) {
        return makeFetchResponse(200, {
          sales: [
            {
              cancelled: false,
              type: "SALE",
              nbCovers: 3,
              salesLines: [{ totalNetAmountWithoutTax: "100", taxAmount: "8" }],
            },
          ],
          dataComplete: true,
        });
      }

      if (url.includes("/staff/v1/businessLocations/10/shifts")) {
        return makeFetchResponse(200, {
          data: [
            {
              startTime: `${todayLocal}T08:00:00.000Z`,
              endTime: `${todayLocal}T10:30:00.000Z`,
              shiftEvents: [
                { eventType: "CLOCK_IN", timestamp: `${todayLocal}T08:00:00.000Z` },
                { eventType: "CLOCK_OUT", timestamp: `${todayLocal}T10:30:00.000Z` },
              ],
            },
          ],
          meta: { totalPages: 1 },
        });
      }

      return new Response("not found", { status: 404 });
    });
    (globalThis as any).fetch = fetchMock;

    const metrics = await importFromLightspeed(config, "Europe/Zurich");
    expect(metrics).toHaveLength(4);
    expect(
      metrics.find((metric) => metric.metricType === "Revenue")?.value
    ).toBe("100.00");
    expect(
      metrics.find((metric) => metric.metricType === "Covers")?.value
    ).toBe("3.00");
    expect(
      metrics.find((metric) => metric.metricType === "Transactions")?.value
    ).toBe("1");
    expect(
      metrics.find((metric) => metric.metricType === "LaborHours")?.value
    ).toBe("2.5");
  });

  it("imports range-mode metrics and retries after 401 with refreshed token", async () => {
    const todayLocal = dayjs().tz("Europe/Zurich").format("YYYY-MM-DD");
    const tokenCachePath = `.tmp-lightspeed-range-${Date.now()}.json`;
    tempTokenCacheFiles.push(path.resolve(process.cwd(), tokenCachePath));

    const config = makeConfig({
      authVersion: "v1",
      clientId: "client-v1",
      tokenCachePath,
      metricTypeMappings: [],
      daysPast: 0,
      daysFuture: 0,
      salesFetchMode: "range",
      outputs: [
        {
          enabled: true,
          kind: "revenue",
          metricType: "Revenue",
          revenueType: "net",
        },
        {
          enabled: true,
          kind: "transactions",
          metricType: "Transactions",
          saleTypesToInclude: ["SALE", "REFUND"],
        },
      ],
    });

    let tokenRequests = 0;
    let firstSalesAttempt = true;

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        tokenRequests += 1;
        const token = tokenRequests === 1 ? "token-old" : "token-new";
        return makeFetchResponse(200, {
          access_token: token,
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      }

      if (url.includes("/f/data/businesses")) {
        return makeFetchResponse(200, [
          {
            id: 1,
            name: "Business A",
            businessLocations: [{ id: 10, name: "Main" }],
          },
        ]);
      }

      if (url.includes("/f/v2/business-location/10/sales")) {
        const authHeader = (init?.headers as Record<string, string>)?.Authorization;

        if (firstSalesAttempt && authHeader === "Bearer token-old") {
          firstSalesAttempt = false;
          return new Response("expired", { status: 401 });
        }

        if (url.includes("nextPageToken=next-1")) {
          return makeFetchResponse(200, {
            sales: [
              {
                cancelled: false,
                type: "REFUND",
                timeClosed: `${todayLocal}T18:00:00.000Z`,
                salesLines: [{ totalNetAmountWithoutTax: "-20" }],
              },
            ],
          });
        }

        return makeFetchResponse(200, {
          sales: [
            {
              cancelled: false,
              type: "SALE",
              timeClosed: `${todayLocal}T12:00:00.000Z`,
              salesLines: [{ totalNetAmountWithoutTax: "100" }],
            },
          ],
          nextPageToken: "next-1",
        });
      }

      return new Response("not found", { status: 404 });
    });
    (globalThis as any).fetch = fetchMock;

    const metrics = await importFromLightspeed(config, "Europe/Zurich");
    expect(metrics).toHaveLength(2);
    expect(
      metrics.find((metric) => metric.metricType === "Revenue")?.value
    ).toBe("80.00");
    expect(
      metrics.find((metric) => metric.metricType === "Transactions")?.value
    ).toBe("2");
    expect(tokenRequests).toBeGreaterThanOrEqual(2);
  });
});
