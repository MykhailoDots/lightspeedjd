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
      targetField: 'actual',
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
    },
    {
      name: "monthly_costs",
      type: "snowflake",
      enabled: true,
      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      targetField: 'targetOrBudget',
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
      daysPast: 30,
      daysFuture: 0,
      query: `
WITH filled_gaps AS (
    SELECT 
        OUTLET_ID,
        ART,
        GUELTIG_AB,
        LEAD(GUELTIG_AB, 1) OVER (
            PARTITION BY OUTLET_ID, ART 
            ORDER BY GUELTIG_AB
        ) AS NEXT_GUELTIG_AB,
        MONTAG, DIENSTAG, MITTWOCH, DONNERSTAG, FREITAG, SAMSTAG, SONNTAG
    FROM FACT_ZIELSTELLENPLAN
    WHERE ART = 'Umsatz'
),
date_boundaries AS (
    SELECT
        MIN(GUELTIG_AB) as startDate,
        COALESCE(MAX(NEXT_GUELTIG_AB), CURRENT_DATE()) as endDate
    FROM filled_gaps
),
date_spine AS (
    SELECT DISTINCT
        DATEADD(DAY, seq4(), (SELECT startDate FROM date_boundaries)::DATE) AS date
    FROM TABLE(GENERATOR(ROWCOUNT => 3650))
    WHERE date <= (SELECT endDate FROM date_boundaries)
),
valid_periods AS (
    SELECT 
        d.date,
        f.OUTLET_ID,
        f.ART,
        f.GUELTIG_AB,
        f.MONTAG, f.DIENSTAG, f.MITTWOCH, f.DONNERSTAG, f.FREITAG, f.SAMSTAG, f.SONNTAG
    FROM date_spine d
    CROSS JOIN filled_gaps f
    WHERE d.date >= f.GUELTIG_AB 
    AND (d.date < f.NEXT_GUELTIG_AB OR f.NEXT_GUELTIG_AB IS NULL)
),
unpivoted_values AS (
    SELECT
        date,
        OUTLET_ID,
        ART,
        GUELTIG_AB,
        value,
        CASE weekday 
            WHEN 'MONTAG' THEN 1
            WHEN 'DIENSTAG' THEN 2
            WHEN 'MITTWOCH' THEN 3
            WHEN 'DONNERSTAG' THEN 4
            WHEN 'FREITAG' THEN 5
            WHEN 'SAMSTAG' THEN 6
            WHEN 'SONNTAG' THEN 0
        END as weekdayNumber
    FROM valid_periods
    UNPIVOT (
        value FOR weekday IN (
            MONTAG, 
            DIENSTAG, 
            MITTWOCH, 
            DONNERSTAG, 
            FREITAG, 
            SAMSTAG, 
            SONNTAG
        )
    )
)
SELECT
    TO_CHAR(uv.date, 'YYYY-MM-DD') AS "timestamp",
    uv.OUTLET_ID AS "costCenter",
    'Umsatz Stellenplan' AS "metricType",
    uv.value AS "value"
FROM unpivoted_values uv
WHERE DAYOFWEEK(uv.date) = uv.weekdayNumber
ORDER BY uv.OUTLET_ID, uv.date;
      `,
    },
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
