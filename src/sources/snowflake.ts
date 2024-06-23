import snowflake from "snowflake-sdk";
import { appConfigs } from "../config";
import dayjs from "dayjs";
import type { MetricImport } from "..";
import logger from "../helper/logger";

export const createSnowflakeConnection = (
  appConfig: (typeof appConfigs)[0]
) => {
  return snowflake.createConnection({
    account: appConfig.sources.snowflake.account,
    username: appConfig.sources.snowflake.username,
    password: appConfig.sources.snowflake.password,
    database: appConfig.sources.snowflake.database,
    schema: appConfig.sources.snowflake.schema,
    warehouse: appConfig.sources.snowflake.warehouse,
    role: appConfig.sources.snowflake.role,
  });
};

export const importFromSnowflake = async (
  appConfig: (typeof appConfigs)[0]
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
                .utc(row.timestamp)
                .toISOString(),
              costCenter: row.costCenter,
              metricType: "financial", // Assuming metric type as "financial" or fetch from config if dynamic
              value: row.value.toString(),
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
