import type { AppConfig, HelloTESSSourceConfig } from "../config";
import { getEnvVar } from "../config";

export const appConfigDamnDelicious: AppConfig = {
  sources: [
    {
      name: "revenue-actual",
      type: "hellotess",
      enabled: true,
      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      metricTypeCategory: "Ist",
      mergeMetricTypes: {
        enabled: true,
        name: "Umsatz",
      },
      metricTypeMappings: [],
      costCenterMappingField: "customId",
      apiKey: getEnvVar("HELLOTESS_API_KEY", true),
      host: getEnvVar("HELLOTESS_HOST", true),
      daysPast: 7,
      daysFuture: 0,
      storeId: getEnvVar("HELLOTESS_STORE_ID", true), // Optional filter by store
      revenueType: "net", // Can be 'net' or 'gross', defaults to 'net' if not specified
      historicalImport: {
        enabled: true,
        startDate: "2025-01-01", // Start from January 1, 2024
        batchSizeInDays: 10, // Import 10 days at a time
      },
    } as HelloTESSSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
