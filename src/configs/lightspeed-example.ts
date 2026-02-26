import type { AppConfig, LightspeedSourceConfig } from "../config";
import { getEnvVar } from "../config";

export const appConfigLightspeedExample: AppConfig = {
  sources: [
    {
      name: "lightspeed-kseries",
      type: "lightspeed",
      enabled: true,

      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      metricTypeCategory: "Ist",
      mergeMetricTypes: { enabled: false, name: "Umsatz" },
      metricTypeMappings: [],
      costCenterMappingField: "name",

      environment: "demo", // "demo" or "prod"
      clientId: getEnvVar("LSK_CLIENT_ID"),
      clientSecret: getEnvVar("LSK_CLIENT_SECRET"),
      redirectUri: getEnvVar("LSK_REDIRECT_URI"),
      refreshToken: getEnvVar("LSK_REFRESH_TOKEN", true),

      // Optional
      authVersion: "v2", // can be omitted (auto-infer)
      salesFetchMode: "daily", // aligns with Lightspeed business day boundaries
      skipIncompleteDays: false,

      // If you prefer mapping by ID to JobDone customId2:
      // costCenterMappingField: "customId2",
      // costCenterFrom: "id",

      businessLocationIds: [
        Number(getEnvVar("LSK_BUSINESS_LOCATION_ID_1", true)),
      ].filter(Boolean) as number[],

      daysPast: 7,
      daysFuture: 0,

      outputs: [
        {
          enabled: true,
          kind: "revenue",
          metricType: "Umsatz",
          metricTypeCategory: "Ist",
          revenueType: "net",
          includeServiceCharge: false,
          // saleTypesToInclude: ["SALE", "REFUND"],
          includeVoidedLines: false,
        },
        {
          enabled: true,
          kind: "covers",
          metricType: "Covers",
          metricTypeCategory: "Ist",
        },
        {
          enabled: true,
          kind: "laborHours",
          metricType: "Arbeitsstunden",
          metricTypeCategory: "Ist",
          roundingDecimals: 2,
        },
      ],
    } satisfies LightspeedSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
