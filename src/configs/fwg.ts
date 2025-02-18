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
      metricTypeCategory: "Umsatz Effektiv",
      mergeMetricTypes: {
        enabled: true,
        name: "Umsatz",
      },
      metricTypeMappings: [],
      account: getEnvVar("SNOWFLAKE_ACCOUNT", true),
      username: getEnvVar("SNOWFLAKE_USER", true),
      password: getEnvVar("SNOWFLAKE_PASSWORD", true),
      database: "DWH",
      schema: "DBT_DWH",
      warehouse: "COMPUTE_WH",
      role: "DBT",
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
      metricTypeCategory: "Umsatz gem. Stellenplan",
      mergeMetricTypes: {
        enabled: true,
        name: "Umsatz",
      },
      metricTypeMappings: [],
      account: getEnvVar("SNOWFLAKE_ACCOUNT", true),
      username: getEnvVar("SNOWFLAKE_USER", true),
      password: getEnvVar("SNOWFLAKE_PASSWORD", true),
      database: "DWH",
      schema: "DBT_SHARED_MART",
      warehouse: "COMPUTE_WH",
      role: "DBT",
      daysPast: 30,
      daysFuture: 0,
      // TODO: SCOPE QUERY to X days into the past, right now we import everything
      query: `
WITH date_spine AS (
    -- Generate dates from today for 1 year
    SELECT DISTINCT
        DATEADD(DAY, seq4(), CURRENT_DATE()) AS date
    FROM TABLE(GENERATOR(ROWCOUNT => 366))  -- 366 to include potential leap year
    WHERE date <= DATEADD(YEAR, 1, CURRENT_DATE())
),
valid_periods AS (
    SELECT 
        d.date,
        f.OUTLET_ID,
        f.ART,
        f.GUELTIG_AB,
        f.MONTAG, f.DIENSTAG, f.MITTWOCH, f.DONNERSTAG, f.FREITAG, f.SAMSTAG, f.SONNTAG,
        -- Get the most recent GUELTIG_AB for each date
        ROW_NUMBER() OVER (
            PARTITION BY f.OUTLET_ID, d.date 
            ORDER BY f.GUELTIG_AB DESC
        ) as rn
    FROM date_spine d
    CROSS JOIN FACT_ZIELSTELLENPLAN f
    WHERE f.ART = 'Umsatz'
    AND d.date >= f.GUELTIG_AB  -- Only consider rows where GUELTIG_AB is before or equal to the date
),
filtered_periods AS (
    SELECT *
    FROM valid_periods
    WHERE rn = 1  -- Take only the most recent valid record for each date
),
unpivoted_values AS (
    SELECT
        date,
        OUTLET_ID,
        'Umsatz' as metricType,
        CASE DAYOFWEEK(date)
            WHEN 0 THEN SONNTAG
            WHEN 1 THEN MONTAG
            WHEN 2 THEN DIENSTAG
            WHEN 3 THEN MITTWOCH
            WHEN 4 THEN DONNERSTAG
            WHEN 5 THEN FREITAG
            WHEN 6 THEN SAMSTAG
        END as value
    FROM filtered_periods
)
SELECT
    TO_CHAR(date, 'YYYY-MM-DD') AS "timestamp",
    OUTLET_ID AS "costCenter",
    metricType AS "metricType",
    value AS "value"
FROM unpivoted_values
ORDER BY OUTLET_ID, date;
          `,
    },
    {
      name: "monthly_target",
      type: "snowflake",
      enabled: true,
      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      metricTypeCategory: "Umsatz gem. Monatsziel",
      mergeMetricTypes: {
        enabled: true,
        name: "Umsatz",
      },
      metricTypeMappings: [],
      account: getEnvVar("SNOWFLAKE_ACCOUNT", true),
      username: getEnvVar("SNOWFLAKE_USER", true),
      password: getEnvVar("SNOWFLAKE_PASSWORD", true),
      database: "DWH",
      schema: "DBT_SHARED_MART",
      warehouse: "COMPUTE_WH",
      role: "DBT",
      daysPast: 30,
      daysFuture: 0,
      // TODO: SCOPE QUERY to X days into the past, right now we import everything
      query: `
WITH latest_monthly_targets AS (
    -- Get the latest loaded value for each month and outlet
    SELECT 
        OUTLET_ID,
        DATE_TRUNC('MONTH', DATUM) as month_start,
        LAST_DAY(DATUM) as month_end,
        MONATSZIEL_UMSATZ,
        DAYOFMONTH(LAST_DAY(DATUM)) as days_in_month,
        ROUND(MONATSZIEL_UMSATZ / DAYOFMONTH(LAST_DAY(DATUM)), 2) as daily_target,
        ROW_NUMBER() OVER (
            PARTITION BY OUTLET_ID, DATE_TRUNC('MONTH', DATUM)
            ORDER BY LOADDATE DESC
        ) as rn
    FROM FACT_EINGABE_MONATSZIEL
    WHERE MONATSZIEL_UMSATZ > 0
),
valid_targets AS (
    SELECT *
    FROM latest_monthly_targets
    WHERE rn = 1
),
date_spine AS (
    -- Generate dates from today for 1 year
    SELECT DISTINCT
        DATEADD(DAY, seq4(), CURRENT_DATE()) AS date
    FROM TABLE(GENERATOR(ROWCOUNT => 366))  -- 366 to include potential leap year
    WHERE date <= DATEADD(YEAR, 1, CURRENT_DATE())
),
monthly_values AS (
    -- For each date, find the most recent monthly target
    SELECT 
        d.date,
        v.OUTLET_ID,
        v.daily_target,
        ROW_NUMBER() OVER (
            PARTITION BY d.date, v.OUTLET_ID 
            ORDER BY v.month_start DESC
        ) as latest_target
    FROM date_spine d
    CROSS JOIN valid_targets v
    WHERE v.month_start <= d.date  -- Only consider targets from months before or equal to the date
)
SELECT 
    TO_CHAR(date, 'YYYY-MM-DD') as "timestamp",
    OUTLET_ID as "costCenter",
    'Umsatz' as "metricType",
    daily_target as "value"
FROM monthly_values
WHERE latest_target = 1
    AND daily_target IS NOT NULL
ORDER BY OUTLET_ID, date;
        `,
    },
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
