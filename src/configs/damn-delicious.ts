import type {
  AppConfig,
  HelloTESSSourceConfig,
} from "../config";
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
    } as HelloTESSSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
