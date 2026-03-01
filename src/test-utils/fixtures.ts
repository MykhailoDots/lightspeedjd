import type {
  CostCentersByOrganizationIdQuery,
  MetricTypesByOrganizationIdQuery,
} from "../graphql/generated/graphql";
import type { SourceConfigType } from "../config";
import type { MetricImport } from "../index";

export const makeMetricImport = (partial?: Partial<MetricImport>): MetricImport => ({
  timestampCompatibleWithGranularity: "2025-01-01T00:00:00.000Z",
  costCenter: "cc-1",
  metricType: "Umsatz",
  value: "100.25",
  metricTypeCategory: "Ist",
  ...partial,
});

export const makeExistingCostCenters = (): CostCentersByOrganizationIdQuery => ({
  __typename: "query_root",
  costCenter: [
    {
      __typename: "costCenter",
      id: "cost-center-1",
      name: "cc-1",
      description: null,
      status: "ACTIVE" as any,
      customId: "61100",
      customId2: "A1",
      customId3: "B1",
    },
    {
      __typename: "costCenter",
      id: "cost-center-2",
      name: "cc-2",
      description: null,
      status: "ACTIVE" as any,
      customId: "61200",
      customId2: "A2",
      customId3: "B2",
    },
  ],
});

export const makeExistingMetricTypes = (): MetricTypesByOrganizationIdQuery => ({
  __typename: "query_root",
  metricType: [
    {
      __typename: "metricType",
      id: "metric-type-1",
      name: "Umsatz",
      metricTypeCategories: [
        {
          __typename: "metricTypeCategory",
          id: "metric-type-cat-ist",
          name: "Ist",
        },
        {
          __typename: "metricTypeCategory",
          id: "metric-type-cat-plan",
          name: "Geplant",
        },
      ],
    },
    {
      __typename: "metricType",
      id: "metric-type-2",
      name: "Kinder",
      metricTypeCategories: [
        {
          __typename: "metricTypeCategory",
          id: "metric-type-cat-kinder",
          name: "Durchschnitt",
        },
      ],
    },
  ],
});

export const makeBaseSourceConfig = (
  partial?: Partial<SourceConfigType>
): SourceConfigType => {
  const base: SourceConfigType = {
    name: "source-a",
    type: "csv",
    enabled: true,
    ignoredMissingCostCenters: [],
    autoCreateMetricType: false,
    mergeMetricTypes: { enabled: false, name: "Umsatz" },
    metricTypeMappings: [],
    metricTypeCategory: "Ist",
    costCenterMappingField: "name",
    filePath: "/tmp/file.csv",
    importColumns: ["date", "costCenter", "metricType", "value"],
    transformColumns: [],
    dateFormat: "YYYY-MM-DD",
  };

  return {
    ...base,
    ...partial,
  } as SourceConfigType;
};
