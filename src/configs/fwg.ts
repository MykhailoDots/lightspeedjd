import type { AppConfig, SnowflakeSourceConfig } from "../config";
import { getEnvVar } from "../config";

export const appConfigFWG: AppConfig = {
  sources: [
    {
      name: "daily_revenue",
      type: "snowflake",
      enabled: true,
      ignoredMissingCostCenters: ["308", "309", "312", "314", "1000"],
      autoCreateMetricType: false,
      mergeMetricTypes: {
        enabled: true,
        name: "Umsatz",
      },
      metricTypeMappings: [],
      account: getEnvVar("SNOWFLAKE_ACCOUNT"),
      username: getEnvVar("SNOWFLAKE_USER"),
      password: getEnvVar("SNOWFLAKE_PASSWORD"),
      database: getEnvVar("SNOWFLAKE_DATABASE"),
      schema: getEnvVar("SNOWFLAKE_SCHEMA"),
      warehouse: getEnvVar("SNOWFLAKE_WAREHOUSE"),
      role: getEnvVar("SNOWFLAKE_ROLE"),
      daysPast: 7,
      daysFuture: 0,
      query: `
        SELECT
          TO_VARCHAR(DATUM, 'YYYY-MM-DD') AS "timestamp",
          TRIM(TO_VARCHAR(RESTAURANTID)) AS "costCenter",
          'Umsatz' AS "metricType",
          SUM(NETTOTAL_TOTALFC) AS "value"
        FROM FACTTRANSAKTIONEN
        WHERE DATUM BETWEEN ? AND ?
        GROUP BY RESTAURANTID, DATUM
        ORDER BY RESTAURANTID, DATUM;
      `,
    } satisfies SnowflakeSourceConfig,
    // {
    //   name: "monthly_costs",
    //   type: SOURCE.SNOWFLAKE,
    //   enabled: true,
    //   ignoredMissingCostCenters: ["308", "309", "312", "314", "1000"],
    //   autoCreateMetricType: false,
    //   mergeMetricTypes: {
    //     enabled: true,
    //     name: "Kosten",
    //   },
    //   metricTypeMappings: [
    //     {
    //       importName: "raw_cost",
    //       jobdoneName: "Kosten",
    //     },
    //   ],
    //   account: getEnvVar("SNOWFLAKE_ACCOUNT"),
    //   username: getEnvVar("SNOWFLAKE_USER"),
    //   password: getEnvVar("SNOWFLAKE_PASSWORD"),
    //   database: getEnvVar("SNOWFLAKE_DATABASE"),
    //   schema: getEnvVar("SNOWFLAKE_SCHEMA"),
    //   warehouse: getEnvVar("SNOWFLAKE_WAREHOUSE"),
    //   role: getEnvVar("SNOWFLAKE_ROLE"),
    //   daysPast: 30,
    //   daysFuture: 0,
    //   query: `
    //     SELECT
    //       TO_VARCHAR(DATUM, 'YYYY-MM-DD') AS "timestamp",
    //       TRIM(TO_VARCHAR(RESTAURANTID)) AS "costCenter",
    //       'raw_cost' AS "metricType",
    //       SUM(COST_AMOUNT) AS "value"
    //     FROM FACTKOSTEN
    //     WHERE DATUM BETWEEN ? AND ?
    //     GROUP BY RESTAURANTID, DATUM
    //     ORDER BY RESTAURANTID, DATUM;
    //   `,
    // },
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
