import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as snowflakeSource from "./snowflake";
import type { SnowflakeSourceConfig } from "../config";

const makeConfig = (): SnowflakeSourceConfig => ({
  name: "snowflake-source",
  type: "snowflake",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: { enabled: false, name: "Umsatz" },
  metricTypeMappings: [{ importName: "RawRevenue", jobdoneName: "Umsatz" }],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  account: "acc",
  username: "user",
  password: "pass",
  database: "db",
  schema: "public",
  warehouse: "wh",
  role: "role",
  daysPast: 1,
  daysFuture: 0,
  query: "select * from metrics where ts between ? and ?",
});

afterEach(() => {
  mock.restore();
});

describe("snowflake source", () => {
  it("maps snowflake rows into metric imports", async () => {
    const fakeConnection = {
      connect: (cb: (err: Error | null, conn: unknown) => void) => cb(null, {}),
      execute: (opts: any) => {
        opts.complete(null, null, [
          {
            timestamp: "2025-01-05",
            costCenter: "cc-1",
            metricType: "RawRevenue",
            value: "45.5",
          },
        ]);
      },
      destroy: mock(() => undefined),
    } as any;

    spyOn(snowflakeSource, "createSnowflakeConnection").mockReturnValue(
      fakeConnection
    );

    const metrics = await snowflakeSource.importFromSnowflake(
      makeConfig(),
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "cc-1",
      metricType: "Umsatz",
      value: "45.5",
      metricTypeCategory: "Ist",
    });
  });
});
