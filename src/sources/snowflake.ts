import snowflake from "snowflake-sdk";
import dayjs from "dayjs";
import type { MetricImport } from "..";
import logger from "../helper/logger";
import type { AppConfig } from "../config";

export const createSnowflakeConnection = (appConfig: AppConfig) => {
  return snowflake.createConnection({
    account: appConfig.sources.snowflake.account || "",
    username: appConfig.sources.snowflake.username || "",
    password: appConfig.sources.snowflake.password || "",
    database: appConfig.sources.snowflake.database || "",
    schema: appConfig.sources.snowflake.schema || "",
    warehouse: appConfig.sources.snowflake.warehouse || "",
    role: appConfig.sources.snowflake.role || "",
  });
};

export const importFromSnowflake = async (
  appConfig: AppConfig
): Promise<MetricImport[]> => {
  const connection = createSnowflakeConnection(appConfig);
  await new Promise((resolve, reject) =>
    connection.connect((err, conn) => {
      if (err) {
        logger.error("Unable to connect: " + err.message);
        reject(err);
      } else {
        logger.info("Successfully connected to Snowflake.");
        resolve(conn);
      }
    })
  );

  // Calculate the dynamic dates with timezone adjustments
  const fromDate = dayjs()
    .subtract(appConfig.sources.snowflake.daysPast, "day")
    .tz(appConfig.timeZone)
    .startOf("day")
    .format("YYYY-MM-DD HH:mm:ss");
  const toDate = dayjs()
    .add(appConfig.sources.snowflake.daysFuture, "day")
    .tz(appConfig.timeZone)
    .endOf("day")
    .format("YYYY-MM-DD HH:mm:ss");

  logger.info(`Querying Snowflake from ${fromDate} to ${toDate}`);

  return new Promise((resolve, reject) => {
    const query = appConfig.sources.snowflake.query;
    connection.execute({
      sqlText: query,
      binds: [fromDate, toDate],
      complete: (err, stmt, rows) => {
        if (err) {
          console.error("Failed to execute query: " + err.message);
          reject(err);
        } else {
          if (rows) {
            const mappedMetrics: MetricImport[] = rows.map((row) => ({
              timestampCompatibleWithGranularity: dayjs
                .tz(row.timestamp, "YYYY-MM-DD", appConfig.timeZone)
                .utc()
                .toISOString(),
              costCenter: row.costCenter,
              metricType: row.metricType,
              value: row.value.toString(),
              targetField: "actual",
            }));
            resolve(mappedMetrics);
          } else {
            console.error("No data returned from the query");
            resolve([]);
          }
        }
        connection.destroy((destroyErr) => {
          if (destroyErr) {
            console.error(
              "Failed to destroy connection: " + destroyErr.message
            );
          } else {
            console.log("Connection successfully destroyed.");
          }
        });
      },
    });
  });
};
