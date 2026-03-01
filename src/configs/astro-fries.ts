import type { AppConfig, GmailSourceConfig } from "../config";
import { getEnvVar } from "../config";

export const appConfigAstroFries: AppConfig = {
  sources: [
    {
      name: "revenue-actual",
      type: "gmail",
      enabled: true,
      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      metricTypeCategory: "Ist",
      mergeMetricTypes: {
        enabled: true,
        name: "Umsatz",
      },
      metricTypeMappings: [],
      costCenterMappingField: "customId2",
      host: getEnvVar("GMAIL_HOST", true) || "imap.gmail.com",
      port: parseInt(getEnvVar("GMAIL_PORT", true) || "993"),
      secure: getEnvVar("GMAIL_SECURE", true)
        ? getEnvVar("GMAIL_SECURE", true) === "true"
        : true,
      username: getEnvVar("GMAIL_USERNAME", true) || "reports@example.com",
      password: getEnvVar("GMAIL_APP_PASSWORD", true),
      subjectFilter: "Ihr Lightspeed Restaurant-Bericht",
      attachmentNamePattern: ".*\\.csv$",
      dateExtractionRegex: ".*product_breakdown_(\\d{8})_.*\\.csv$",
      dateFormat: "YYYYMMDD",
      daysPast: 7,
      aliasBaseAddress: getEnvVar("GMAIL_ALIAS_BASE_ADDRESS", true),
      orgIdSource: "env",
      createLabelsIfMissing: getEnvVar("GMAIL_CREATE_LABELS_IF_MISSING", true)
        ? getEnvVar("GMAIL_CREATE_LABELS_IF_MISSING", true) === "true"
        : true,
      skipHeader: true,
      valueCell: {
        column: 3,
        row: 2,
      },
    } as GmailSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
