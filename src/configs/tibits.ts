import type { AppConfig, PowerBIDelegatedSourceConfig } from "../config";
import { getEnvVar } from "../config";

const EXCLUDED_BETRIEBE = [
  "tibits Backoffice",
  "tibits Event",
  "ZFF",
  "SIB",
  "Pride",
  "tibits Webladung",
  "tibits Darmstadt",
  "Sonnenberg",
] as const;

const tenantId = getEnvVar("PBI_TIBITS_TENANT_ID", true);
const clientId = getEnvVar("PBI_TIBITS_CLIENT_ID", true);
const userPrincipalName = getEnvVar("PBI_TIBITS_USER_UPN", true);
const datasetId = getEnvVar("PBI_TIBITS_DATASET_ID", true);
const groupId = getEnvVar("PBI_TIBITS_GROUP_ID", true);
const tokenCachePath =
  getEnvVar("PBI_TIBITS_TOKEN_CACHE", true) || ".msal-pbi-cache.json";
const costCenterMappingFieldEnv = getEnvVar(
  "PBI_TIBITS_COST_CENTER_MAPPING_FIELD",
  true
);
const costCenterMappingField: PowerBIDelegatedSourceConfig["costCenterMappingField"] =
  costCenterMappingFieldEnv === "name" ||
  costCenterMappingFieldEnv === "customId" ||
  costCenterMappingFieldEnv === "customId2"
    ? costCenterMappingFieldEnv
    : "customId";

// Optional overrides (useful if the customer renames measures in Power BI)
const actualRevenueExpr =
  getEnvVar("PBI_TIBITS_ACTUAL_REVENUE_EXPR", true) ||
  "'Einnahmen'[Umsatz Restaurant]";
const forecastRevenueExpr =
  getEnvVar("PBI_TIBITS_FORECAST_REVENUE_EXPR", true) || "[Forecast Umsatz]";
const budgetRevenueExpr =
  getEnvVar("PBI_TIBITS_BUDGET_REVENUE_EXPR", true) || "'Budget'[Budget Umsatz]";
const budgetHoursExpr =
  getEnvVar("PBI_TIBITS_BUDGET_HOURS_EXPR", true) || "'Budget'[Budget Stunden]";
const actualCategory =
  getEnvVar("PBI_TIBITS_ACTUAL_CATEGORY", true) || "Ist";
const forecastCategory =
  getEnvVar("PBI_TIBITS_FORECAST_CATEGORY", true) || "Prognostiziert";
const budgetCategory =
  getEnvVar("PBI_TIBITS_BUDGET_CATEGORY", true) || "Ziel";
const budgetHoursCategory =
  getEnvVar("PBI_TIBITS_BUDGET_HOURS_CATEGORY", true) || "Ziel";

const parseIntOr = (raw: string, fallback: number) => {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const costCenterPrefixLength = parseIntOr(
  getEnvVar("PBI_TIBITS_COST_CENTER_PREFIX_LENGTH", true) ||
    (costCenterMappingField === "customId" ? "2" : "0"),
  0
);

const costCenterExpr =
  costCenterMappingField === "customId2"
    ? "MAX('Betriebe'[Betrieb])"
    : `FORMAT(MAX('Betriebe'[Betriebscode]), "0")`;
const ignoredMissingCostCenters = ["10"];

const costCenterFanOutMapping = {
  "20": ["20100", "20150", "20200"],
  "25": ["25100", "25150", "25200"],
  "26": ["26100", "26150", "26200", "26300"],
  "30": ["30100", "30150", "30200"],
  "40": ["40100", "40150", "40200", "40300"],
  "45": ["45100", "45150", "45200"],
  "50": ["50100", "50150", "50200"],
  "55": ["55100", "55150", "55200"],
  "60": ["60100", "60150", "60200"],
  "61": ["61100", "61150", "61200"],
  "62": ["62100", "62150", "62200"],
  "70": ["70100", "70150", "70200"],
  "80": ["80100", "80150", "80200", "80300"],
} satisfies Record<string, string[]>;

const daysPast = parseIntOr(getEnvVar("PBI_TIBITS_DAYS_PAST", true) || "14", 14);
const daysFutureForPlans = parseIntOr(
  getEnvVar("PBI_TIBITS_DAYS_FUTURE", true) || "0",
  0
);

const buildTibitsDaxQuery = (
  valueExpression: string,
  opts?: { includeHour?: boolean }
) => `
DEFINE
    VAR FromDate = DATEVALUE("{fromDate}")
    VAR ToDateExclusive = DATEVALUE("{toDate}")

    VAR __DS0FilterTable =
        FILTER(
            KEEPFILTERS(VALUES('Zeitachse'[Datum])),
            'Zeitachse'[Datum] >= FromDate &&
            'Zeitachse'[Datum] < ToDateExclusive
        )

    VAR __DS0FilterTable2 =
        TREATAS({"aktiv"}, 'Betriebe'[Status])

    VAR __DS0FilterTable3 =
        FILTER(
            KEEPFILTERS(VALUES('Betriebe'[Betrieb])),
            NOT(
                'Betriebe'[Betrieb] IN {
                    BLANK(),
                    ${EXCLUDED_BETRIEBE.map((b) => JSON.stringify(b)).join(
                      ",\n                    "
                    )}
                }
            )
        )

EVALUATE
    FILTER(
        SUMMARIZECOLUMNS(
            'Zeitachse'[Datum],
            'Betriebe'[Standort],
            'Betriebe'[Betriebscode],
            ${opts?.includeHour ? "'Stunde'[Stunde]," : ""}
            __DS0FilterTable,
            __DS0FilterTable2,
            __DS0FilterTable3,
            "timestamp", MIN('Zeitachse'[Datum]),
            "costCenter", ${costCenterExpr},
            "costCenterCode", FORMAT(MAX('Betriebe'[Betriebscode]), "0"),
            "costCenterName", MAX('Betriebe'[Betrieb]),
            "value", ${valueExpression}
        ),
        NOT ISBLANK([value])
    )

ORDER BY
    'Zeitachse'[Datum],
    'Betriebe'[Standort],
    'Betriebe'[Betriebscode]${
      opts?.includeHour ? ", 'Stunde'[Stunde]" : ""
    }
`;

export const appConfigTibits: AppConfig = {
  sources: [
    {
      name: "tibits-umsatz-effektiv",
      type: "powerbi-delegated",
      enabled: true,
      ignoredMissingCostCenters,
      autoCreateMetricType: false,
      metricTypeCategory: actualCategory,
      mergeMetricTypes: { enabled: true, name: "Umsatz" },
      metricTypeMappings: [],
      costCenterMappingField,
      costCenterPrefixLength,
      costCenterFanOut: { mode: "mapping", mapping: costCenterFanOutMapping },
      tenantId,
      clientId,
      userPrincipalName,
      tokenCachePath,
      datasetId,
      groupId,
      daysPast,
      daysFuture: 0,
      daxQuery: buildTibitsDaxQuery(actualRevenueExpr),
    } satisfies PowerBIDelegatedSourceConfig,
    {
      name: "tibits-umsatz-forecast",
      type: "powerbi-delegated",
      enabled: true,
      ignoredMissingCostCenters,
      autoCreateMetricType: false,
      metricTypeCategory: forecastCategory,
      mergeMetricTypes: { enabled: true, name: "Umsatz" },
      metricTypeMappings: [],
      costCenterMappingField,
      costCenterPrefixLength,
      costCenterFanOut: { mode: "mapping", mapping: costCenterFanOutMapping },
      tenantId,
      clientId,
      userPrincipalName,
      tokenCachePath,
      datasetId,
      groupId,
      daysPast,
      daysFuture: daysFutureForPlans,
      daxQuery: buildTibitsDaxQuery(forecastRevenueExpr),
    } satisfies PowerBIDelegatedSourceConfig,
    {
      name: "tibits-umsatz-budget",
      type: "powerbi-delegated",
      enabled: true,
      ignoredMissingCostCenters,
      autoCreateMetricType: false,
      metricTypeCategory: budgetCategory,
      mergeMetricTypes: { enabled: true, name: "Umsatz" },
      metricTypeMappings: [],
      costCenterMappingField,
      costCenterPrefixLength,
      costCenterFanOut: { mode: "mapping", mapping: costCenterFanOutMapping },
      tenantId,
      clientId,
      userPrincipalName,
      tokenCachePath,
      datasetId,
      groupId,
      daysPast,
      daysFuture: daysFutureForPlans,
      // Budget Umsatz appears to be split by hour; we include Stunde so the measure
      // evaluates, and rely on importer-side merging to sum hours into a daily value.
      daxQuery: buildTibitsDaxQuery(budgetRevenueExpr, { includeHour: true }),
    } satisfies PowerBIDelegatedSourceConfig,
    {
      name: "tibits-stunden-budget",
      type: "powerbi-delegated",
      enabled: true,
      ignoredMissingCostCenters,
      autoCreateMetricType: false,
      metricTypeCategory: budgetHoursCategory,
      mergeMetricTypes: { enabled: true, name: "Arbeitsstunden" },
      metricTypeMappings: [],
      costCenterMappingField,
      costCenterPrefixLength,
      costCenterFanOut: { mode: "mapping", mapping: costCenterFanOutMapping },
      tenantId,
      clientId,
      userPrincipalName,
      tokenCachePath,
      datasetId,
      groupId,
      daysPast,
      daysFuture: daysFutureForPlans,
      daxQuery: buildTibitsDaxQuery(budgetHoursExpr, { includeHour: true }),
    } satisfies PowerBIDelegatedSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
