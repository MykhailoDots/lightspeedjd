import type { AppConfig, EmailSourceConfig } from "../config";
import { getEnvVar } from "../config";

export const appConfigAstroFries: AppConfig = {
  sources: [
    {
      name: "revenue-actual",
      type: "email",
      enabled: true,
      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      metricTypeCategory: "Ist",
      mergeMetricTypes: {
        enabled: true,
        name: "Umsatz",
      },
      metricTypeMappings: [],
      host: getEnvVar("EMAIL_HOST", true) || "mail.example.com",
      port: parseInt(getEnvVar("EMAIL_PORT", true) || "993"),
      secure: getEnvVar("EMAIL_SECURE", true) === "true",
      username: getEnvVar("EMAIL_USERNAME", true) || "reports@example.com",
      password: getEnvVar("EMAIL_PASSWORD", true),
      subjectFilter: "Ihr Lightspeed Restaurant-Bericht",
      attachmentNamePattern: ".*\\.csv$",
      dateExtractionRegex: ".*product_breakdown_(\\d{8})_.*\\.csv$",
      dateFormat: "YYYYMMDD",
      daysPast: 7,
      skipHeader: true,
      valueCell: {
        column: 3,
        row: 2,
      },
      costCenterCell: {
        column: 1,
        row: 2,
      },
    } as EmailSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
