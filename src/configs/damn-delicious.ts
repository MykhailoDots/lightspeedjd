import type { AppConfig, HelloTESSSourceConfig } from "../config";
import { getEnvVar } from "../config";

interface HelloTESSEnvMapping {
  sourceName: string;
  apiKeyEnv: string;
  hostEnv: string;
  storeIdEnv: string;
}

const buildHelloTessSource = (
  mapping: HelloTESSEnvMapping
): HelloTESSSourceConfig => {
  const apiKey = getEnvVar(mapping.apiKeyEnv, true);
  const host = getEnvVar(mapping.hostEnv, true);
  const storeId = getEnvVar(mapping.storeIdEnv, true);

  return {
    name: mapping.sourceName,
    type: "hellotess",
    // Only enable the source when both critical credentials are present.
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
    // Optional filter by store ID for installations with multiple stores.
    ...(storeId ? { storeId } : {}),
    // Can be "net" or "gross"; default in importer is "net".
    revenueType: "net",
    // Historical one-time backfill settings.
    historicalImport: {
      enabled: true,
      startDate: "2025-01-01",
      batchSizeInDays: 10,
    },
  };
};

export const appConfigDamnDelicious: AppConfig = {
  sources: [
    buildHelloTessSource({
      sourceName: "revenue-actual-weisses-roessli",
      apiKeyEnv: "HELLOTESS_WEISSES_ROESSLI_API_KEY",
      hostEnv: "HELLOTESS_WEISSES_ROESSLI_HOST",
      storeIdEnv: "HELLOTESS_WEISSES_ROESSLI_STORE_ID",
    }),
    buildHelloTessSource({
      sourceName: "revenue-actual-coffee-and-plants",
      apiKeyEnv: "HELLOTESS_COFFEE_AND_PLANTS_API_KEY",
      hostEnv: "HELLOTESS_COFFEE_AND_PLANTS_HOST",
      storeIdEnv: "HELLOTESS_COFFEE_AND_PLANTS_STORE_ID",
    }),
    buildHelloTessSource({
      sourceName: "revenue-actual-roast-and-host",
      apiKeyEnv: "HELLOTESS_ROAST_AND_HOST_API_KEY",
      hostEnv: "HELLOTESS_ROAST_AND_HOST_HOST",
      storeIdEnv: "HELLOTESS_ROAST_AND_HOST_STORE_ID",
    }),
    buildHelloTessSource({
      sourceName: "revenue-actual-straeme",
      apiKeyEnv: "HELLOTESS_STRAEME_API_KEY",
      hostEnv: "HELLOTESS_STRAEME_HOST",
      storeIdEnv: "HELLOTESS_STRAEME_STORE_ID",
    }),
    buildHelloTessSource({
      sourceName: "revenue-actual-stadthof",
      apiKeyEnv: "HELLOTESS_STADTHOF_API_KEY",
      hostEnv: "HELLOTESS_STADTHOF_HOST",
      storeIdEnv: "HELLOTESS_STADTHOF_STORE_ID",
    }),
    buildHelloTessSource({
      sourceName: "revenue-actual-casi-casa",
      apiKeyEnv: "HELLOTESS_CASI_CASA_API_KEY",
      hostEnv: "HELLOTESS_CASI_CASA_HOST",
      storeIdEnv: "HELLOTESS_CASI_CASA_STORE_ID",
    }),
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
