import { describe, expect, it } from "bun:test";
import {
  dedupeFormattedMetrics,
  detectRawConflicts,
  formatMetricsForImport,
  mergeMetrics,
  normalizeCostCenterKey,
  resolveFanOutTargets,
  validateMetricsForSource,
} from "./metric-pipeline";
import {
  makeBaseSourceConfig,
  makeExistingCostCenters,
  makeExistingMetricTypes,
  makeMetricImport,
} from "../test-utils/fixtures";

describe("metric-pipeline core", () => {
  it("normalizes cost center by prefix length", () => {
    expect(normalizeCostCenterKey("61100", 2)).toBe("61");
    expect(normalizeCostCenterKey("61", 2)).toBe("61");
    expect(normalizeCostCenterKey("61100")).toBe("61100");
  });

  it("resolves fan-out mappings with fallback", () => {
    const source = makeBaseSourceConfig({
      costCenterPrefixLength: 2,
      costCenterFanOut: {
        mode: "mapping",
        mapping: { "61": ["61100", "61200"] },
      },
    });

    expect(resolveFanOutTargets("61123", source)).toEqual(["61100", "61200"]);
    expect(resolveFanOutTargets("72123", source)).toEqual(["72"]);
  });

  it("validates source metrics and returns id maps", async () => {
    const source = makeBaseSourceConfig({
      costCenterMappingField: "customId",
      costCenterPrefixLength: 2,
    });
    const metrics = [makeMetricImport({ costCenter: "61100", metricType: "Umsatz" })];

    const result = await validateMetricsForSource(
      metrics,
      source,
      makeExistingCostCenters(),
      makeExistingMetricTypes()
    );

    expect(result.existingCostCenterIdsByNameMap.get("61")).toBe("cost-center-1");
    expect(result.existingMetricTypesIdsByNameMap.get("Umsatz")).toBe("metric-type-1");
    expect(result.existingMetricTypeCategoryIdsByNameMap.get("Ist")).toBe(
      "metric-type-cat-ist"
    );
  });

  it("throws when metric type category is invalid for effective metric type", async () => {
    const source = makeBaseSourceConfig();
    const metrics = [makeMetricImport({ metricTypeCategory: "DoesNotExist" })];

    await expect(
      validateMetricsForSource(
        metrics,
        source,
        makeExistingCostCenters(),
        makeExistingMetricTypes()
      )
    ).rejects.toThrow("metric type categories");
  });

  it("formats metrics for import and drops non-importable records", () => {
    const source = makeBaseSourceConfig();
    const metrics = [
      makeMetricImport({ costCenter: "cc-1", value: "101.236" }),
      makeMetricImport({ costCenter: "missing-center", value: "50" }),
    ];

    const formatted = formatMetricsForImport(
      metrics,
      source,
      new Map([
        ["cc-1", "cost-center-1"],
        ["61100", "cost-center-1"],
      ]),
      new Map([["Umsatz", "metric-type-1"]]),
      new Map([["Ist", "metric-type-cat-ist"]]),
      "Europe/Zurich"
    );

    expect(formatted).toHaveLength(1);
    expect(formatted[0]).toMatchObject({
      costCenterId: "cost-center-1",
      metricTypeId: "metric-type-1",
      metricTypeCategoryId: "metric-type-cat-ist",
      value: 101.24,
    });
  });

  it("merges metrics by timestamp+costCenter+metricType", () => {
    const merged = mergeMetrics([
      {
        timestamp: "2025-01-01T00:00:00.000Z",
        timeZone: "Europe/Zurich",
        costCenterId: "c1",
        metricTypeId: "m1",
        metricTypeCategoryId: "cat1",
        value: 2.12,
      },
      {
        timestamp: "2025-01-01T00:00:00.000Z",
        timeZone: "Europe/Zurich",
        costCenterId: "c1",
        metricTypeId: "m1",
        metricTypeCategoryId: "cat2",
        value: 3.22,
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe(5.34);
  });

  it("detects raw conflicts with different source values", () => {
    const conflicts = detectRawConflicts([
      {
        sourceName: "a",
        metric: makeMetricImport({ value: "100" }),
      },
      {
        sourceName: "b",
        metric: makeMetricImport({ value: "200" }),
      },
      {
        sourceName: "c",
        metric: makeMetricImport({
          timestampCompatibleWithGranularity: "2025-01-02T00:00:00.000Z",
          value: "100",
        }),
      },
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].entries.map((entry) => entry.sourceName)).toEqual(["a", "b"]);
  });

  it("dedupes formatted metrics and returns conflict list", () => {
    const { dedupedMetrics, formattedConflicts } = dedupeFormattedMetrics([
      {
        timestamp: "2025-01-01T00:00:00.000Z",
        timeZone: "Europe/Zurich",
        costCenterId: "c1",
        metricTypeId: "m1",
        metricTypeCategoryId: "cat1",
        value: 10,
      },
      {
        timestamp: "2025-01-01T00:00:00.000Z",
        timeZone: "Europe/Zurich",
        costCenterId: "c1",
        metricTypeId: "m1",
        metricTypeCategoryId: "cat1",
        value: 10,
      },
      {
        timestamp: "2025-01-01T00:00:00.000Z",
        timeZone: "Europe/Zurich",
        costCenterId: "c1",
        metricTypeId: "m1",
        metricTypeCategoryId: "cat1",
        value: 12,
      },
    ]);

    expect(dedupedMetrics).toHaveLength(1);
    expect(formattedConflicts).toHaveLength(1);
    expect(formattedConflicts[0].key).toContain("2025-01-01T00:00:00.000Z");
  });
});
