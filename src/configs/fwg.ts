import { getEnvVar, type AppConfig, type SOURCE } from "../config";

export const appConfigFWG: AppConfig = {
  isDryRun: false,
  sources: {
    activeSource: getEnvVar("SOURCE") as SOURCE | undefined,
    csv: {
      // filePath: "/home/sftp-bindella-user-1/uploads/JD_Umsatz_Gastro.csv",
      filePath: "Final - Group by Day - Correct Table.csv",
      importColumns: ["date", "costCenter", "metricType", "value"],
      transformColumns: [
        // {
        //   outputColumn: "value",
        //   operation: "add",
        //   operands: ["value", "tax"]
        // }
      ],
      dateFormat: "YYYY-MM-DD",
    },
    snowflake: {
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
  FROM
      FACTTRANSAKTIONEN
  WHERE
      DATUM BETWEEN ? AND ?
  GROUP BY
      RESTAURANTID,
      DATUM
  ORDER BY
      RESTAURANTID,
      DATUM;
          `,
    },
  },
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
  ignoredMissingCostCenters: ["308", "309", "312", "314", "1000"],
  autoCreateMetricType: false,
  mergeMetricTypes: {
    enabled: true,
    name: "Umsatz",
  },
  metricTypeMappings: [],
};
