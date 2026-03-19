import { PublicClientApplication, LogLevel, type AccountInfo } from "@azure/msal-node";
import fs from "node:fs";
import dayjs from "../helper/customDayJs";
import logger from "../helper/logger";
import { sendMessageToDiscord } from "../helper/discord";
import type { PowerBIDelegatedSourceConfig } from "../config";
import type { MetricImport } from "..";

const DEFAULT_SCOPES = ["https://analysis.windows.net/powerbi/api/Dataset.Read.All"];
const DEFAULT_CACHE_PATH = ".msal-pbi-cache.json";

export const buildDaxQuery = (
  config: PowerBIDelegatedSourceConfig,
  timeZone: string
) => {
  const fromDate = dayjs()
    .subtract(config.daysPast, "day")
    .tz(timeZone)
    .startOf("day")
    .format("YYYY-MM-DD");
  const toDate = dayjs()
    .add(config.daysFuture, "day")
    .tz(timeZone)
    .endOf("day")
    .format("YYYY-MM-DD");

  return config.daxQuery
    .replaceAll("{fromDate}", fromDate)
    .replaceAll("{toDate}", toDate);
};

export const loadCache = (pca: PublicClientApplication, path: string) => {
  if (fs.existsSync(path)) {
    const cache = fs.readFileSync(path, "utf8");
    if (cache) {
      pca.getTokenCache().deserialize(cache);
      logger.info(`[${path}] Loaded MSAL cache`);
    }
  }
};

export const saveCache = (pca: PublicClientApplication, path: string) => {
  const cache = pca.getTokenCache().serialize();
  fs.writeFileSync(path, cache, "utf8");
  logger.info(`[${path}] Saved MSAL cache`);
};

export const acquireDelegatedToken = async (
  config: PowerBIDelegatedSourceConfig
): Promise<{ accessToken: string; account: AccountInfo | null }> => {
  const pca = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
    },
    system: {
      loggerOptions: {
        logLevel: LogLevel.Info,
        piiLoggingEnabled: false,
        loggerCallback: (level, message) => {
          if (level <= LogLevel.Info) logger.debug(`[MSAL] ${message}`);
        },
      },
    },
  });

  const cachePath = config.tokenCachePath || DEFAULT_CACHE_PATH;
  loadCache(pca, cachePath);

  const scopes = DEFAULT_SCOPES;

  const accounts = await pca.getTokenCache().getAllAccounts();
  const account =
    accounts.find((a) => a.username?.toLowerCase() === config.userPrincipalName.toLowerCase()) ||
    accounts[0] ||
    null;

  if (account) {
    try {
      const silent = await pca.acquireTokenSilent({ account, scopes });
      if (silent?.accessToken) {
        logger.info(`[${config.name}] acquireTokenSilent succeeded for ${account.username}`);
        saveCache(pca, cachePath);
        return { accessToken: silent.accessToken, account };
      }
    } catch (err) {
      logger.warn(`[${config.name}] acquireTokenSilent failed: ${String(err).slice(0, 400)}`);
    }
  }

  const deviceCodeRequest = {
    deviceCodeCallback: (response: any) => {
      const message = `[${config.name}] Power BI device code login required: visit ${response.verificationUri} and enter code ${response.userCode}`;
      logger.warn(message);
      void sendMessageToDiscord({ message });
    },
    scopes,
  } as const;

  const result = await pca.acquireTokenByDeviceCode(deviceCodeRequest);
  if (!result?.accessToken) {
    throw new Error(`[${config.name}] Failed to acquire delegated token via device code`);
  }

  saveCache(pca, cachePath);
  logger.info(`[${config.name}] Device code completed for ${result.account?.username}`);

  return { accessToken: result.accessToken, account: result.account ?? null };
};

export const importFromPowerBIDelegated = async (
  config: PowerBIDelegatedSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  const daxQuery = buildDaxQuery(config, timeZone);
  logger.info(
    `[${config.name}] Starting Power BI fetch (delegated/device code); tenant=${config.tenantId}, dataset=${config.datasetId}, group=${config.groupId ?? "(myorg)"}`
  );
  logger.info(`[${config.name}] Full DAX query:\n${daxQuery}`);

  const { accessToken, account } = await acquireDelegatedToken(config);
  logger.info(
    `[${config.name}] Delegated token acquired for ${account?.username ?? "(unknown account)"}, executing query...`
  );

  const baseUrl = "https://api.powerbi.com/v1.0/myorg";
  const groupPath = config.groupId ? `/groups/${config.groupId}` : "";
  const url = `${baseUrl}${groupPath}/datasets/${config.datasetId}/executeQueries`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      queries: [{ query: daxQuery }],
      serializerSettings: { includeNulls: true },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      `[${config.name}] Power BI delegated query failed (${response.status}): ${errorText.slice(0, 1000)}`
    );
    throw new Error(`Power BI delegated query failed: ${response.status}`);
  }

  const data = (await response.json()) as any;
  const rows: any[] = data?.results?.[0]?.tables?.[0]?.rows ?? [];

  logger.info(
    `[${config.name}] ExecuteQueries returned ${rows.length} rows${
      rows[0] ? "; first row keys: " + Object.keys(rows[0]).join(", ") : ""
    }`
  );
  if (rows[0]) {
    logger.info(`[${config.name}] First row sample: ${JSON.stringify(rows[0]).slice(0, 800)}`);
  }

  if (!rows.length) {
    logger.warn(`[${config.name}] Power BI returned no rows`);
    return [];
  }

  const getRowValue = (row: Record<string, any>, keys: string[]) => {
    for (const key of keys) {
      const value = row[key];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
    return undefined;
  };

  const mappedMetrics: MetricImport[] = rows.map((row) => {
    const rawTimestamp =
      getRowValue(row, [
        "timestamp",
        "[timestamp]",
        "Timestamp",
        "[Timestamp]",
        "date",
        "Date",
        "DateTime",
        "[date]",
        "[Date]",
        "[DateTime]",
      ]) ?? row["timestamp"];
    const timestamp = dayjs(rawTimestamp).tz(timeZone);

    if (!timestamp.isValid()) {
      throw new Error(
        `[${config.name}] Invalid timestamp value from Power BI row: ${rawTimestamp}`
      );
    }

    const metricTypeFromRow =
      row.metricType ?? row.MetricType ?? row["metricType"] ?? "";
    const metricTypeMapping = config.metricTypeMappings.find(
      (m) => m.importName === metricTypeFromRow
    );

    const metricType = config.mergeMetricTypes.enabled
      ? config.mergeMetricTypes.name
      : metricTypeMapping
      ? metricTypeMapping.jobdoneName
      : metricTypeFromRow;

    const metricTypeCategoryFromRow =
      row.metricTypeCategory ??
      row.MetricTypeCategory ??
      row["metricTypeCategory"] ??
      row.Category ??
      row["category"];

    const valueFromRow =
      getRowValue(row, [
        "value",
        "[value]",
        "Value",
        "[Value]",
        "Amount",
        "[Amount]",
        "Budget",
        "[Budget]",
        "Revenue",
        "[Revenue]",
        "NetRevenue",
        "[NetRevenue]",
        "NetSales",
        "[NetSales]",
        "GrossSales",
        "[GrossSales]",
      ]) ?? 0;

    const costCenterValue =
      getRowValue(row, [
        "costCenter",
        "[costCenter]",
        "CostCenter",
        "[CostCenter]",
        "OutletId",
        "[OutletId]",
        "Outlet",
        "[Outlet]",
        "RestaurantId",
        "[RestaurantId]",
        "Restaurant",
        "[Restaurant]",
        "Location",
        "[Location]",
      ]) ?? row["costCenter"];

    if (costCenterValue === undefined || costCenterValue === null || costCenterValue === "") {
      throw new Error(
        `[${config.name}] Missing costCenter value from Power BI row: ${JSON.stringify(row).slice(0, 800)}`
      );
    }

    return {
      timestampCompatibleWithGranularity: timestamp.utc().toISOString(),
      costCenter: String(costCenterValue),
      metricType,
      value: valueFromRow.toString(),
      metricTypeCategory: metricTypeCategoryFromRow || config.metricTypeCategory || "Ist",
    } satisfies MetricImport;
  });

  logger.info(
    `[${config.name}] Successfully retrieved ${mappedMetrics.length} metrics from Power BI`
  );

  return mappedMetrics;
};
