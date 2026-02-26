import { ConfidentialClientApplication } from "@azure/msal-node";
import dayjs from "../helper/customDayJs";
import logger from "../helper/logger";
import type { PowerBIServicePrincipalSourceConfig } from "../config";
import type { MetricImport } from "..";

const POWER_BI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";

const getAccessToken = async (
  config: PowerBIServicePrincipalSourceConfig
): Promise<string> => {
  const app = new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientSecret: config.clientSecret,
    },
  });

  const result = await app.acquireTokenByClientCredential({ scopes: [POWER_BI_SCOPE] });

  if (!result?.accessToken) {
    throw new Error(`[${config.name}] Unable to acquire Power BI access token`);
  }

  return result.accessToken;
};

const buildDaxQuery = (config: PowerBIServicePrincipalSourceConfig, timeZone: string) => {
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

export const importFromPowerBIServicePrincipal = async (
  config: PowerBIServicePrincipalSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  const daxQuery = buildDaxQuery(config, timeZone);
  logger.info(
    `[${config.name}] Starting Power BI fetch (service principal); tenant=${config.tenantId}, dataset=${config.datasetId}, group=${config.groupId ?? "(myorg)"}`
  );

  logger.info(`[${config.name}] Acquiring Power BI token...`);
  const accessToken = await getAccessToken(config);
  logger.info(`[${config.name}] Token acquired, enumerating workspace/datasets...`);

  const baseUrl = "https://api.powerbi.com/v1.0/myorg";
  const groupPath = config.groupId ? `/groups/${config.groupId}` : "";
  const url = `${baseUrl}${groupPath}/datasets/${config.datasetId}/executeQueries`;

  if (config.groupId) {
    try {
      const workspaceResp = await fetch(`${baseUrl}/groups/${config.groupId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (workspaceResp.ok) {
        const ws = await workspaceResp.json();
        logger.info(
          `[${config.name}] Workspace resolved: ${ws?.name ?? "(no name)"} (${ws?.id ?? config.groupId})`
        );
      } else {
        logger.warn(
          `[${config.name}] Workspace lookup failed (${workspaceResp.status}). Skipping workspace details.`
        );
      }
    } catch (err) {
      logger.warn(`[${config.name}] Workspace lookup threw: ${String(err).slice(0, 400)}`);
    }
  } else {
    logger.info(`[${config.name}] No groupId supplied; using myorg (My workspace) scope.`);
  }

  try {
    const datasetsUrl = `${baseUrl}${groupPath}/datasets`;
    const dsResp = await fetch(datasetsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (dsResp.ok) {
      const dsJson = await dsResp.json();
      const list = dsJson?.value ?? dsJson?.datasets ?? [];
      const preview = list.slice(0, 5).map((d: any) => `${d.id}:${d.name}`).join(" | ");
      logger.info(
        `[${config.name}] Datasets visible (${list.length}): ${preview || "(none)"}`
      );
    } else {
      logger.warn(
        `[${config.name}] Dataset listing failed (${dsResp.status}). Skipping dataset list.`
      );
    }
  } catch (err) {
    logger.warn(`[${config.name}] Dataset listing threw: ${String(err).slice(0, 400)}`);
  }

  const datasetUrl = `${baseUrl}${groupPath}/datasets/${config.datasetId}`;
  const datasetResp = await fetch(datasetUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!datasetResp.ok) {
    const body = await datasetResp.text();
    logger.error(
      `[${config.name}] Dataset check failed (${datasetResp.status}). Response: ${body.slice(0, 800)}`
    );
    throw new Error(`Power BI dataset connectivity failed (${datasetResp.status})`);
  }

  logger.info(
    `[${config.name}] Dataset reachable (status ${datasetResp.status}), executing DAX...`
  );

  try {
    const tablesResp = await fetch(`${datasetUrl}/tables`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (tablesResp.ok) {
      const tablesJson = await tablesResp.json();
      const tables = tablesJson?.value ?? tablesJson?.tables ?? [];
      const preview = tables
        .slice(0, 5)
        .map((t: any) => `${t.name}${t.columns ? `(${t.columns.length} cols)` : ""}`)
        .join(" | ");
      logger.info(
        `[${config.name}] Tables preview: ${preview || "(none)"} (${tables.length} total)`
      );
    } else {
      logger.warn(
        `[${config.name}] Table listing failed (${tablesResp.status}). Skipping table list.`
      );
    }
  } catch (err) {
    logger.warn(`[${config.name}] Table listing threw: ${String(err).slice(0, 400)}`);
  }

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
      `[${config.name}] Power BI query failed with status ${response.status}: ${errorText.slice(
        0,
        1200
      )}`
    );
    throw new Error(`Power BI query failed: ${response.status}`);
  }

  const data = (await response.json()) as any;
  const rows: any[] = data?.results?.[0]?.tables?.[0]?.rows ?? [];

  logger.info(
    `[${config.name}] ExecuteQueries returned ${rows.length} rows${
      rows[0] ? "; first row keys: " + Object.keys(rows[0]).join(", ") : ""
    }`
  );
  if (rows[0]) {
    logger.info(
      `[${config.name}] First row sample: ${JSON.stringify(rows[0]).slice(0, 800)}`
    );
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
