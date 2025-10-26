import type { AppConfig } from "../config";
import { getEnvVar } from "../config";

const toOptionalNumber = (value: string): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const toOptionalBoolean = (value: string): boolean | undefined => {
  if (!value) {
    return undefined;
  }
  return value.toLowerCase() === "true";
};

const baseRevenueSource = {
  type: "mssql" as const,
  enabled: true,
  ignoredMissingCostCenters: [] as string[],
  autoCreateMetricType: false,
  metricTypeCategory: "Ist",
  mergeMetricTypes: {
    enabled: true,
    name: "Umsatz",
  },
  metricTypeMappings: [] as never[],
  costCenterMappingField: "customId" as const,
  encrypt: toOptionalBoolean(getEnvVar("MSSQL_ENCRYPT", true)),
  trustServerCertificate: toOptionalBoolean(
    getEnvVar("MSSQL_TRUST_SERVER_CERTIFICATE", true)
  ),
  connectionTimeoutMs: toOptionalNumber(
    getEnvVar("MSSQL_CONNECTION_TIMEOUT_MS", true)
  ),
  requestTimeoutMs: toOptionalNumber(
    getEnvVar("MSSQL_REQUEST_TIMEOUT_MS", true)
  ),
  daysPast: 365,
  daysFuture: 0,
  query: `
SELECT
    CONVERT(varchar(10), CONVERT(date, [Datum]), 120) AS timestamp,
    LTRIM(RTRIM(CAST([Betr] AS nvarchar(50)))) AS costCenter,
    'Umsatz' AS metricType,
    SUM(COALESCE(CAST([Betrag] AS decimal(18, 2)), 0)) AS value
FROM dbo.Kasse
WHERE [Datum] BETWEEN @fromDate AND @toDate
GROUP BY CONVERT(date, [Datum]), CAST([Betr] AS nvarchar(50))
ORDER BY CONVERT(date, [Datum]), CAST([Betr] AS nvarchar(50));
  `,
};

export const appConfigRemimag: AppConfig = {
  sources: [
    {
      ...baseRevenueSource,
      name: "revenue-actual-db-RemimagMIS",
      server: getEnvVar("MSSQL_SERVER"),
      port: toOptionalNumber(getEnvVar("MSSQL_PORT", true)),
      database: "DB_RemimagMIS",
      username: getEnvVar("MSSQL_USERNAME"),
      password: getEnvVar("MSSQL_PASSWORD"),
    },
    {
      ...baseRevenueSource,
      name: "revenue-actual-db-RemimagMIS_68",
      server: getEnvVar("MSSQL_SERVER"),
      port: toOptionalNumber(getEnvVar("MSSQL_PORT", true)),
      database: "DB_RemimagMIS_68",
      username: getEnvVar("MSSQL_USERNAME"),
      password: getEnvVar("MSSQL_PASSWORD"),
    },
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
