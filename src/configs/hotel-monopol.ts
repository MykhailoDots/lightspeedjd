import type { AppConfig, ClockSourceConfig } from "../config";
import { getEnvVar } from "../config";

export const appConfigHotelMonopol: AppConfig = {
  sources: [
    {
      name: "hotel_occupancy",
      type: "clock",
      enabled: true,
      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      mergeMetricTypes: {
        enabled: false,
        name: "",
      },
      metricTypeMappings: [],
      costCenter: getEnvVar("CLOCK_COST_CENTER", true),
      accountId: getEnvVar("CLOCK_ACCOUNT_ID", true),
      subscriptionId: getEnvVar("CLOCK_SUBSCRIPTION_ID", true),
      subscriptionRegion: getEnvVar("CLOCK_SUBSCRIPTION_REGION", true),
      baseApi: getEnvVar("CLOCK_BASE_API", true),
      apiUser: getEnvVar("CLOCK_API_USER", true),
      apiKey: getEnvVar("CLOCK_API_KEY", true),
      isCacheEnabled: false,
      isDoNotDeleteCacheEnabled: false,
      metricType: getEnvVar("CLOCK_METRIC_TYPE", true),
    } satisfies ClockSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
