import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { setRequiredEnvForConfig } from "./test-utils/mocks";

const setHeaderMock = mock(() => undefined);

const requestMock = mock(async (query: unknown) => {
  if (query === "Q_COST") {
    return { costCenter: [{ id: "cc-1", name: "CC 1" }] };
  }
  if (query === "Q_METRIC") {
    return { metricType: [{ id: "mt-1", name: "Umsatz", metricTypeCategories: [] }] };
  }
  if (query === "Q_SAVE") {
    return { saveMetrics: true };
  }
  return {};
});

beforeAll(() => {
  setRequiredEnvForConfig();

  mock.module("./helper/cognito.ts", () => ({
    authenticate: async () => ({
      accessToken: "acc-1",
      idToken: "id-1",
      refreshToken: "ref-1",
    }),
    refreshBearerToken: async () => ({
      accessToken: "acc-2",
      idToken: "id-2",
      refreshToken: "ref-2",
    }),
  }));

  mock.module("graphql-request", () => ({
    GraphQLClient: class {
      constructor(_: string, __: unknown) {}
      request = requestMock;
      setHeader = setHeaderMock;
    },
  }));

  mock.module("./graphql/generated/graphql.ts", () => ({
    CostCentersByOrganizationId: "Q_COST",
    MetricTypesByOrganizationId: "Q_METRIC",
    SaveMetrics: "Q_SAVE",
  }));
});

afterAll(() => {
  mock.restore();
});

describe("util module", () => {
  it("refreshes auth token and updates external client header", async () => {
    const util = await import("./util");
    await util.refreshAuthTokenBearerToken();
    expect(setHeaderMock).toHaveBeenCalledWith("authorization", "id-2");
  });

  it("requests cost centers and metric types from internal client", async () => {
    const util = await import("./util");

    const cost = await util.getCostCenters({ organizationId: "org-id" } as any);
    const types = await util.getMetricTypes({ organizationId: "org-id" } as any);

    expect(cost.costCenter[0].id).toBe("cc-1");
    expect(types.metricType[0].id).toBe("mt-1");
  });

  it("upserts metrics through external client", async () => {
    const util = await import("./util");
    const result = await util.UpsertMetrics({
      input: {
        details: [],
      },
    } as any);
    expect(result.saveMetrics).toBe(true);
  });
});
