import snowflake from "snowflake-sdk";
import dayjs from "dayjs";
import type { MetricImport } from "..";
import logger from "../helper/logger";
import type { SnowflakeSourceConfig } from "../config";

export const createSnowflakeConnection = (config: SnowflakeSourceConfig) => {
  return snowflake.createConnection({
    account: config.account || "",
    username: config.username || "",
    password: config.password || "",
    database: config.database || "",
    schema: config.schema || "",
    warehouse: config.warehouse || "",
    role: config.role || "",
  });
};

export const importFromSnowflake = async (
  config: SnowflakeSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  const connection = createSnowflakeConnection(config);

  await new Promise((resolve, reject) =>
    connection.connect((err, conn) => {
      if (err) {
        logger.error(`[${config.name}] Unable to connect: ${err.message}`);
        reject(err);
      } else {
        logger.info(`[${config.name}] Successfully connected to Snowflake.`);
        resolve(conn);
      }
    })
  );

  const fromDate = dayjs()
    .subtract(config.daysPast, "day")
    .tz(timeZone)
    .startOf("day")
    .format("YYYY-MM-DD HH:mm:ss");

  const toDate = dayjs()
    .add(config.daysFuture, "day")
    .tz(timeZone)
    .endOf("day")
    .format("YYYY-MM-DD HH:mm:ss");

  logger.info(
    `[${config.name}] Querying Snowflake from ${fromDate} to ${toDate}`
  );

  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: config.query,
      binds: [fromDate, toDate],
      complete: (err, stmt, rows) => {
        if (err) {
          logger.error(
            `[${config.name}] Failed to execute query: ${err.message}`
          );
          reject(err);
        } else {
          if (rows) {
            const mappedMetrics: MetricImport[] = rows.map((row) => {
              const metricTypeMapping = config.metricTypeMappings.find(
                (m) => m.importName === row.metricType
              );

              return {
                timestampCompatibleWithGranularity: dayjs
                  .tz(row.timestamp, "YYYY-MM-DD", timeZone)
                  .utc()
                  .toISOString(),
                costCenter: row.costCenter,
                metricType: metricTypeMapping
                  ? metricTypeMapping.jobdoneName
                  : row.metricType,
                value: row.value.toString(),
                metricTypeCategory: config.metricTypeCategory || "Ist",
              };
            });

            logger.info(
              `[${config.name}] Successfully retrieved ${mappedMetrics.length} metrics from Snowflake`
            );
            resolve(mappedMetrics);
          } else {
            logger.warn(`[${config.name}] No data returned from the query`);
            resolve([]);
          }
        }

        connection.destroy((destroyErr) => {
          if (destroyErr) {
            logger.error(
              `[${config.name}] Failed to destroy connection: ${destroyErr.message}`
            );
          } else {
            logger.info(`[${config.name}] Connection successfully destroyed.`);
          }
        });
      },
    });
  });
};
