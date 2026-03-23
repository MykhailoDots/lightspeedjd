import dayjs from "../src/helper/customDayJs";
import logger from "../src/helper/logger";
import { importFromLightspeed } from "../src/sources/lightspeed";
import type { LightspeedSourceConfig } from "../src/config";
import type { MetricImport } from "../src/index";

const getRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not defined`);
  }
  return value;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  return value.toLowerCase() === "true";
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const parseBusinessLocationIds = (): number[] => {
  const idsFromList = (process.env.LSK_BUSINESS_LOCATION_IDS || "")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);

  if (idsFromList.length > 0) {
    return idsFromList;
  }

  const single = Number(getRequiredEnv("LSK_BUSINESS_LOCATION_ID_1"));
  if (!Number.isFinite(single) || single <= 0) {
    throw new Error("LSK_BUSINESS_LOCATION_ID_1 must be a valid positive number");
  }
  return [single];
};

const summarizeRevenue = (metrics: MetricImport[], timeZone: string) => {
  const rows = metrics
    .filter((m) => m.metricType === "Umsatz")
    .map((m) => ({
      date: dayjs(m.timestampCompatibleWithGranularity).tz(timeZone).format("YYYY-MM-DD"),
      timestampUtc: m.timestampCompatibleWithGranularity,
      costCenter: m.costCenter,
      value: Number(m.value),
      category: m.metricTypeCategory,
    }));

  const total = rows.reduce((acc, row) => acc + row.value, 0);
  return { rows, total };
};

const main = async () => {
  const clientId = getRequiredEnv("LSK_CLIENT_ID");
  const clientSecret = getRequiredEnv("LSK_CLIENT_SECRET");
  const refreshToken = getRequiredEnv("LSK_REFRESH_TOKEN");
  const redirectUri = getRequiredEnv("LSK_REDIRECT_URI");
  const businessLocationIds = parseBusinessLocationIds();

  const timeZone = process.env.LSK_TIME_ZONE || "Europe/Zurich";
  const daysPast = parseNumber(process.env.LSK_DAYS_PAST, 0);
  const daysFuture = parseNumber(process.env.LSK_DAYS_FUTURE, 0);
  const skipIncompleteDays = parseBoolean(process.env.LSK_SKIP_INCOMPLETE_DAYS, false);
  const revenueType = process.env.LSK_REVENUE_TYPE === "gross" ? "gross" : "net";
  const includeCovers = parseBoolean(process.env.LSK_INCLUDE_COVERS, false);
  const includeTransactions = parseBoolean(process.env.LSK_INCLUDE_TRANSACTIONS, false);
  const includeLaborHours = parseBoolean(process.env.LSK_INCLUDE_LABOR_HOURS, false);

  const source: LightspeedSourceConfig = {
    name: "lightspeed-kseries-dry-run",
    type: "lightspeed",
    enabled: true,
    ignoredMissingCostCenters: [],
    autoCreateMetricType: false,
    metricTypeCategory: "Ist",
    mergeMetricTypes: { enabled: false, name: "Umsatz" },
    metricTypeMappings: [],
    costCenterMappingField: "name",
    environment: "demo",
    authVersion: "v2",
    clientId,
    clientSecret,
    refreshToken,
    redirectUri,
    businessLocationIds,
    costCenterFrom: "id",
    daysPast,
    daysFuture,
    salesFetchMode: "daily",
    skipIncompleteDays,
    tokenCachePath:
      process.env.LSK_TOKEN_CACHE_PATH ||
      `/tmp/lightspeed-token-dry-run-${Date.now()}.json`,
    outputs: [
      {
        enabled: true,
        kind: "revenue",
        metricType: "Umsatz",
        metricTypeCategory: "Ist",
        revenueType,
        includeServiceCharge: false,
        includeVoidedLines: false,
      },
      ...(includeCovers
        ? [
            {
              enabled: true,
              kind: "covers" as const,
              metricType: "Covers",
              metricTypeCategory: "Ist",
            },
          ]
        : []),
      ...(includeTransactions
        ? [
            {
              enabled: true,
              kind: "transactions" as const,
              metricType: "Transactions",
              metricTypeCategory: "Ist",
              saleTypesToInclude: ["SALE", "REFUND"] as const,
            },
          ]
        : []),
      ...(includeLaborHours
        ? [
            {
              enabled: true,
              kind: "laborHours" as const,
              metricType: "Arbeitsstunden",
              metricTypeCategory: "Ist",
              roundingDecimals: 2,
            },
          ]
        : []),
    ],
  };

  logger.info("[lightspeed-dry-run] Starting Lightspeed-only dry-run...");
  logger.info(
    `[lightspeed-dry-run] Params: locationIds=${businessLocationIds.join(",")} daysPast=${daysPast} daysFuture=${daysFuture} revenueType=${revenueType} skipIncompleteDays=${skipIncompleteDays}`
  );

  const metrics = await importFromLightspeed(source, timeZone);
  logger.info(`[lightspeed-dry-run] Imported ${metrics.length} metric rows (read-only)`);

  const revenue = summarizeRevenue(metrics, timeZone);
  if (revenue.rows.length === 0) {
    logger.warn(
      `[lightspeed-dry-run] No revenue rows returned. If logs show dataComplete=false, set LSK_SKIP_INCOMPLETE_DAYS=false or run with LSK_DAYS_PAST=1.`
    );
  }
  console.log("=== DAILY REVENUE (LIGHTSPEED, DRY-RUN) ===");
  console.table(revenue.rows);
  console.log(
    JSON.stringify(
      {
        rows: revenue.rows.length,
        totalRevenue: Number(revenue.total.toFixed(2)),
        timeZone,
        businessLocationIds,
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  logger.error(
    `[lightspeed-dry-run] Failed: ${
      error instanceof Error ? error.message : JSON.stringify(error)
    }`
  );
  process.exit(1);
});
