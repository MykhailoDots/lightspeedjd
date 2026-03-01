import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as mssqlSource from "./mssql";
import type { MssqlSourceConfig } from "../config";

const makeConfig = (): MssqlSourceConfig => ({
  name: "mssql-source",
  type: "mssql",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: { enabled: false, name: "Umsatz" },
  metricTypeMappings: [{ importName: "RawRevenue", jobdoneName: "Umsatz" }],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  server: "localhost",
  database: "db",
  username: "user",
  password: "pass",
  daysPast: 1,
  daysFuture: 0,
  query: "select * from metrics where date >= @fromDate and date <= @toDate",
});

afterEach(() => {
  mock.restore();
});

describe("mssql source", () => {
  it("maps query rows into metric imports", async () => {
    const fakeRequest = {
      input: mock(() => fakeRequest),
      query: mock(async () => ({
        recordset: [
          {
            timestamp: "2025-01-05",
            costCenter: "cc-1",
            metricType: "RawRevenue",
            value: "12.5",
          },
        ],
      })),
    };
    const fakePool = {
      request: () => fakeRequest,
      close: mock(async () => undefined),
    } as any;

    spyOn(mssqlSource, "createMssqlPool").mockResolvedValue(fakePool as any);

    const metrics = await mssqlSource.importFromMssql(
      makeConfig(),
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "cc-1",
      metricType: "Umsatz",
      value: "12.5",
      metricTypeCategory: "Ist",
    });
  });

  it("returns empty array when query returns no rows", async () => {
    const fakeRequest = {
      input: mock(() => fakeRequest),
      query: mock(async () => ({ recordset: [] })),
    };
    const fakePool = {
      request: () => fakeRequest,
      close: mock(async () => undefined),
    } as any;

    spyOn(mssqlSource, "createMssqlPool").mockResolvedValue(fakePool as any);

    const metrics = await mssqlSource.importFromMssql(
      makeConfig(),
      "Europe/Zurich"
    );
    expect(metrics).toEqual([]);
  });
});
