import sql from "mssql";
import dayjs from "dayjs";
import type { MetricImport } from "..";
import logger from "../helper/logger";
import type { MssqlSourceConfig } from "../config";

export const createMssqlPool = async (
  config: MssqlSourceConfig
): Promise<sql.ConnectionPool> => {
  const pool = new sql.ConnectionPool({
    user: config.username,
    password: config.password,
    server: config.server,
    database: config.database,
    port: config.port,
    connectionTimeout: config.connectionTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    options: {
      encrypt: config.encrypt ?? false,
      trustServerCertificate: config.trustServerCertificate ?? false,
    },
  });

  return pool.connect();
};

export const importFromMssql = async (
  config: MssqlSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  const fromDate = dayjs()
    .subtract(config.daysPast, "day")
    .tz(timeZone)
    .startOf("day");

  const toDate = dayjs()
    .add(config.daysFuture, "day")
    .tz(timeZone)
    .endOf("day");

  const fromDateFormatted = fromDate.format("YYYY-MM-DD HH:mm:ss");
  const toDateFormatted = toDate.format("YYYY-MM-DD HH:mm:ss");

  logger.info(
    `[${config.name}] Querying MSSQL from ${fromDateFormatted} to ${toDateFormatted}`
  );

  let pool: sql.ConnectionPool | null = null;

  try {
    pool = await createMssqlPool(config);
    logger.info(`[${config.name}] Successfully connected to MSSQL.`);

    const request = pool.request();
    request.input("fromDate", sql.DateTime2, fromDate.toDate());
    request.input("toDate", sql.DateTime2, toDate.toDate());

    const result = await request.query(config.query);

    const rows = result.recordset ?? [];

    if (!rows.length) {
      logger.warn(`[${config.name}] No data returned from the query`);
      return [];
    }

    const mappedMetrics: MetricImport[] = rows.map((row) => {
      const metricTypeMapping = config.metricTypeMappings.find(
        (m) => m.importName === row.metricType
      );
      const rawValue = row.value ?? 0;

      return {
        timestampCompatibleWithGranularity: dayjs
          .tz(row.timestamp, "YYYY-MM-DD", timeZone)
          .utc()
          .toISOString(),
        costCenter: row.costCenter,
        metricType: metricTypeMapping
          ? metricTypeMapping.jobdoneName
          : row.metricType,
        value: rawValue.toString(),
        metricTypeCategory: config.metricTypeCategory || "Ist",
      };
    });

    logger.info(
      `[${config.name}] Successfully retrieved ${mappedMetrics.length} metrics from MSSQL`
    );
    return mappedMetrics;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : JSON.stringify(error);
    logger.error(`[${config.name}] Failed to execute MSSQL query: ${message}`);
    throw error;
  } finally {
    if (pool) {
      try {
        await pool.close();
        logger.info(`[${config.name}] Connection successfully closed.`);
      } catch (closeError) {
        const closeMessage =
          closeError instanceof Error
            ? closeError.message
            : JSON.stringify(closeError);
        logger.error(
          `[${config.name}] Failed to close MSSQL connection: ${closeMessage}`
        );
      }
    }
  }
};
