import type { AppConfig, HelloTESSSourceConfig } from "../config";
import { getEnvVar } from "../config";

const apiKey =
  getEnvVar("HELLOTESS_SEEROSE_API_KEY", true) ||
  getEnvVar("HELLOTESS_API_KEY", true);
const host =
  getEnvVar("HELLOTESS_SEEROSE_HOST", true) || getEnvVar("HELLOTESS_HOST", true);
const storeId =
  getEnvVar("HELLOTESS_SEEROSE_STORE_ID", true) ||
  getEnvVar("HELLOTESS_STORE_ID", true);

export const appConfigSeerose: AppConfig = {
  sources: [
    {
      name: "revenue-actual-seerose",
      type: "hellotess",
      enabled: Boolean(apiKey && host),
      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      metricTypeCategory: "Ist",
      mergeMetricTypes: {
        enabled: true,
        name: "Umsatz",
      },
      metricTypeMappings: [],
      costCenterMappingField: "customId2",
      apiKey,
      host,
      daysPast: 7,
      daysFuture: 0,
      ...(storeId ? { storeId } : {}),
      revenueType: "net",
      historicalImport: {
        enabled: true,
        startDate: "2025-01-01",
        batchSizeInDays: 10,
      },
    } as HelloTESSSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
