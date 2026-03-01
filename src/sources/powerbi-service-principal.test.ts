import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { setRequiredEnvForConfig } from "../test-utils/mocks";
import type { PowerBIServicePrincipalSourceConfig } from "../config";

const acquireTokenByClientCredentialMock = mock(async () => ({
  accessToken: "sp-access-token",
}));

beforeAll(() => {
  setRequiredEnvForConfig();

  mock.module("@azure/msal-node", () => ({
    ConfidentialClientApplication: class {
      constructor(_: unknown) {}
      acquireTokenByClientCredential = acquireTokenByClientCredentialMock;
    },
    // Keep delegated tests compatible if this mock is reused.
    PublicClientApplication: class {},
    LogLevel: { Info: 3 },
  }));
});

beforeEach(() => {
  acquireTokenByClientCredentialMock.mockReset();
  acquireTokenByClientCredentialMock.mockResolvedValue({
    accessToken: "sp-access-token",
  });
});

const makeConfig = (
  partial?: Partial<PowerBIServicePrincipalSourceConfig>
): PowerBIServicePrincipalSourceConfig => ({
  name: "pbi-sp",
  type: "powerbi-sp",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: { enabled: false, name: "Umsatz" },
  metricTypeMappings: [{ importName: "RevenueRaw", jobdoneName: "Umsatz" }],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
  datasetId: "dataset-1",
  groupId: "group-1",
  daxQuery:
    "EVALUATE FILTER('Table', 'Table'[Date] >= DATE({fromDate}) && 'Table'[Date] <= DATE({toDate}))",
  daysPast: 2,
  daysFuture: 1,
  ...partial,
});

describe("powerbi service-principal helpers", () => {
  it("builds dax query with date tokens", async () => {
    const config = makeConfig();
    const { buildDaxQuery } = await import("./powerbi-service-principal");

    const query = buildDaxQuery(config, "Europe/Zurich");
    expect(query.includes("{fromDate}")).toBe(false);
    expect(query.includes("{toDate}")).toBe(false);
    expect(query).toContain("EVALUATE FILTER");
  });

  it("maps executeQueries rows into metrics", async () => {
    const config = makeConfig();
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/groups/group-1")) {
        return new Response(JSON.stringify({ id: "group-1", name: "Main" }), {
          status: 200,
        });
      }

      if (url.endsWith("/groups/group-1/datasets")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "dataset-1", name: "Revenue DS" }],
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/groups/group-1/datasets/dataset-1")) {
        return new Response(JSON.stringify({ id: "dataset-1" }), { status: 200 });
      }

      if (url.endsWith("/groups/group-1/datasets/dataset-1/tables")) {
        return new Response(
          JSON.stringify({
            value: [{ name: "Sales", columns: [{}, {}] }],
          }),
          { status: 200 }
        );
      }

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
                        OutletId: "CC-01",
                        Revenue: 123.45,
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

    const { importFromPowerBIServicePrincipal } = await import("./powerbi-service-principal");
    const metrics = await importFromPowerBIServicePrincipal(
      config,
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "CC-01",
      metricType: "Umsatz",
      value: "123.45",
      metricTypeCategory: "Actual",
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("throws when dataset connectivity check fails", async () => {
    const config = makeConfig();
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/groups/group-1")) {
        return new Response(JSON.stringify({ id: "group-1" }), { status: 200 });
      }
      if (url.endsWith("/groups/group-1/datasets")) {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      if (url.endsWith("/groups/group-1/datasets/dataset-1")) {
        return new Response("missing", { status: 404 });
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as any).fetch = fetchMock;

    const { importFromPowerBIServicePrincipal } = await import("./powerbi-service-principal");

    await expect(
      importFromPowerBIServicePrincipal(config, "Europe/Zurich")
    ).rejects.toThrow("dataset connectivity failed");
  });

  it("throws when service principal token is missing", async () => {
    acquireTokenByClientCredentialMock.mockResolvedValueOnce({});
    const { getAccessToken } = await import("./powerbi-service-principal");

    await expect(getAccessToken(makeConfig())).rejects.toThrow(
      "Unable to acquire Power BI access token"
    );
  });
});
