import { getEnvVar, type AppConfig, type SOURCE } from "../config";

export const appConfigHotelMonopol: AppConfig = {
  isDryRun: false,
  sources: {
    activeSource: getEnvVar("SOURCE") as SOURCE | undefined,
    clock: {
      costCenter: getEnvVar("CLOCK_COST_CENTER"),
      accountId: getEnvVar("CLOCK_ACCOUNT_ID"),
      subscriptionId: getEnvVar("CLOCK_SUBSCRIPTION_ID"),
      subscriptionRegion: getEnvVar("CLOCK_SUBSCRIPTION_REGION"),
      baseApi: getEnvVar("CLOCK_BASE_API"),
      apiUser: getEnvVar("CLOCK_API_USER"),
      apiKey: getEnvVar("CLOCK_API_KEY"),
      isCacheEnabled: false,
      isDoNotDeleteCacheEnabled: false,
      metricType: getEnvVar("CLOCK_METRIC_TYPE"),
    },
  },
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: {
    enabled: false,
    name: "",
  },
  metricTypeMappings: [],
};
