import type { AppConfig, BaseSourceConfig } from "../config";
import { getEnvVar } from "../config";

export interface HelloTESSSourceConfig extends BaseSourceConfig {
  type: "hellotess";
  apiKey: string;
  host: string; // e.g., "BACKOFFICE_NAME.hellotess.com"
  daysPast: number;
  daysFuture: number;
  storeId?: string; // Optional store ID to filter by
}

export const appConfigHelloTESS: AppConfig = {
  sources: [
    {
      name: "hellotess_revenue",
      type: "hellotess",
      enabled: true,
      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      metricTypeCategory: "Umsatz Effektiv",
      mergeMetricTypes: {
        enabled: true,
        name: "Umsatz",
      },
      metricTypeMappings: [],
      apiKey: getEnvVar("HELLOTESS_API_KEY", true),
      host: getEnvVar("HELLOTESS_HOST", true),
      daysPast: 7,
      daysFuture: 0,
      storeId: getEnvVar("HELLOTESS_STORE_ID", true), // Optional filter by store
    } as HelloTESSSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};