import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "fs";
import path from "path";
import { setRequiredEnvForConfig } from "../test-utils/mocks";
import type { PowerBIDelegatedSourceConfig } from "../config";

const cachePath = path.join(process.cwd(), ".tmp-msal-cache.json");
const getAllAccountsMock = mock(async () => []);
const acquireTokenSilentMock = mock(async () => null);
const acquireTokenByDeviceCodeMock = mock(async () => ({
  accessToken: "device-access-token",
  account: { username: "user@example.com" },
}));

beforeAll(() => {
  setRequiredEnvForConfig();

  mock.module("@azure/msal-node", () => ({
    ConfidentialClientApplication: class {},
    PublicClientApplication: class {
      constructor(_: unknown) {}
      private tokenCacheValue = "";

      getTokenCache() {
        return {
          deserialize: (input: string) => {
            this.tokenCacheValue = input;
          },
          serialize: () => this.tokenCacheValue || "{\"token\":\"x\"}",
          getAllAccounts: getAllAccountsMock,
        };
      }

      acquireTokenSilent = acquireTokenSilentMock;
      acquireTokenByDeviceCode = acquireTokenByDeviceCodeMock;
    },
    LogLevel: { Info: 3 },
  }));
});

beforeEach(() => {
  getAllAccountsMock.mockReset();
  acquireTokenSilentMock.mockReset();
  acquireTokenByDeviceCodeMock.mockReset();

  getAllAccountsMock.mockResolvedValue([]);
  acquireTokenSilentMock.mockResolvedValue(null);
  acquireTokenByDeviceCodeMock.mockResolvedValue({
    accessToken: "device-access-token",
    account: { username: "user@example.com" },
  });
});

afterEach(() => {
  if (fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }
});

const makeConfig = (
  partial?: Partial<PowerBIDelegatedSourceConfig>
): PowerBIDelegatedSourceConfig => ({
  name: "pbi-delegated",
  type: "powerbi-delegated",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: { enabled: false, name: "Umsatz" },
  metricTypeMappings: [{ importName: "RevenueRaw", jobdoneName: "Umsatz" }],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  tenantId: "tenant",
  clientId: "client",
  userPrincipalName: "user@example.com",
  datasetId: "dataset",
  groupId: "group-1",
  daxQuery: "EVALUATE ROW(\"from\", \"{fromDate}\", \"to\", \"{toDate}\")",
  daysPast: 2,
  daysFuture: 1,
  tokenCachePath: cachePath,
  ...partial,
});

describe("powerbi delegated helpers", () => {
  it("builds dax query with from/to dates", async () => {
    const config = makeConfig();
    const { buildDaxQuery } = await import("./powerbi-delegated.ts?case=dax");

    const query = buildDaxQuery(config, "Europe/Zurich");
    expect(query.includes("{fromDate}")).toBe(false);
    expect(query.includes("{toDate}")).toBe(false);
  });

  it("loads and saves cache through pca token cache API", async () => {
    const { loadCache, saveCache } = await import(
      "./powerbi-delegated.ts?case=cache-helpers"
    );

    const pca: any = {
      _cache: "",
      getTokenCache() {
        return {
          deserialize: (input: string) => {
            pca._cache = input;
          },
          serialize: () => pca._cache || "{\"token\":\"x\"}",
        };
      },
    };

    pca._cache = "{\"token\":\"saved\"}";
    saveCache(pca, cachePath);
    pca._cache = "";
    loadCache(pca, cachePath);

    expect(pca._cache).toBe("{\"token\":\"saved\"}");
  });

  it("prefers acquireTokenSilent when account is available", async () => {
    const account = { username: "user@example.com" };
    getAllAccountsMock.mockResolvedValueOnce([account]);
    acquireTokenSilentMock.mockResolvedValueOnce({ accessToken: "silent-token" });

    const { acquireDelegatedToken } = await import(
      "./powerbi-delegated.ts?case=silent"
    );
    const result = await acquireDelegatedToken(makeConfig());

    expect(result.accessToken).toBe("silent-token");
    expect(result.account?.username).toBe("user@example.com");
    expect(acquireTokenByDeviceCodeMock).not.toHaveBeenCalled();
  });

  it("falls back to device code when silent acquisition fails", async () => {
    const account = { username: "user@example.com" };
    getAllAccountsMock.mockResolvedValueOnce([account]);
    acquireTokenSilentMock.mockRejectedValueOnce(new Error("silent failed"));
    acquireTokenByDeviceCodeMock.mockImplementationOnce(async (request: any) => {
      request.deviceCodeCallback?.({
        verificationUri: "https://microsoft.com/devicelogin",
        userCode: "ABCD-1234",
      });
      return {
        accessToken: "device-code-token",
        account: { username: "user@example.com" },
      };
    });

    const { acquireDelegatedToken } = await import(
      "./powerbi-delegated.ts?case=device-code"
    );
    const result = await acquireDelegatedToken(makeConfig());

    expect(result.accessToken).toBe("device-code-token");
    expect(acquireTokenByDeviceCodeMock).toHaveBeenCalledTimes(1);
  });

  it("imports delegated executeQueries rows into metrics", async () => {
    getAllAccountsMock.mockResolvedValueOnce([{ username: "user@example.com" }]);
    acquireTokenSilentMock.mockResolvedValueOnce({
      accessToken: "delegated-token",
    });

    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/executeQueries")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                tables: [
                  {
                    rows: [
                      {
                        Date: "2025-01-03T00:00:00.000Z",
                        OutletId: "CC-02",
                        Revenue: 88.5,
                        metricType: "RevenueRaw",
                        Category: "Actual",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    });
    (globalThis as any).fetch = fetchMock;

    const { importFromPowerBIDelegated } = await import(
      "./powerbi-delegated.ts?case=import-success"
    );
    const metrics = await importFromPowerBIDelegated(
      makeConfig(),
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "CC-02",
      metricType: "Umsatz",
      value: "88.5",
      metricTypeCategory: "Actual",
    });
  });
});
