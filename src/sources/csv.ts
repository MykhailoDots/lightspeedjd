import { type CSVSourceConfig, type TransformColumn } from "../config";
import { parse } from "csv-parse/sync";
import fs from "fs";
import type { MetricImport } from "..";
import dayjs from "dayjs";
import logger from "../helper/logger";

export interface MetricCSVImport {
  date: string;
  costCenter: string;
  metricType: string;
  value: string;
}

const applyTransformations = (
  data: any[],
  transformations: TransformColumn[],
  sourceName: string
) => {
  return data.map((row) => {
    logger.debug(`[${sourceName}] Raw row: ${JSON.stringify(row, null, 2)}`);

    transformations.forEach(({ outputColumn, operation, operands }) => {
      if (!operands.every((operand) => row[operand] !== undefined)) {
        logger.warn(
          `[${sourceName}] Skipping transformation for row due to missing operands: ${JSON.stringify(
            row,
            null,
            2
          )}`
        );
        return row;
      }

      if (operation === "add") {
        row[outputColumn] = operands
          .reduce((sum, operand) => sum + parseFloat(row[operand] || "0"), 0)
          .toFixed(2);
      } else if (operation === "subtract") {
        row[outputColumn] = operands
          .reduce(
            (result, operand, index) =>
              index === 0
                ? parseFloat(row[operand] || "0")
                : result - parseFloat(row[operand] || "0"),
            0
          )
          .toFixed(2);
      }
    });

    logger.debug(
      `[${sourceName}] Transformed row: ${JSON.stringify(row, null, 2)}`
    );
    return row;
  });
};

const parseCsv = async (
  config: CSVSourceConfig
): Promise<MetricCSVImport[]> => {
  try {
    // Check if file exists
    if (!fs.existsSync(config.filePath)) {
      throw new Error(`CSV file not found: ${config.filePath}`);
    }

    // Read and parse CSV file
    const csv = fs.readFileSync(config.filePath, "utf8");
    let parsedCsv = parse(csv, {
      columns: [...config.importColumns],
      skip_empty_lines: true,
      trim: true,
    });

    // Apply transformations if configured
    if (config.transformColumns && config.transformColumns.length > 0) {
      logger.info(
        `[${config.name}] Applying ${config.transformColumns.length} transformations to CSV data`
      );
      parsedCsv = applyTransformations(
        parsedCsv,
        config.transformColumns,
        config.name
      );
    }

    if (!parsedCsv || !parsedCsv.length) {
      logger.warn(`[${config.name}] No data found in CSV file`);
      return [];
    }

    // Map to expected format
    return parsedCsv.map((row: any) => ({
      date: row.date,
      costCenter: row.costCenter,
      metricType: row.metricType,
      value: row.value,
    }));
  } catch (error) {
    logger.error(`[${config.name}] Error parsing CSV: ${error.message}`);
    throw error;
  }
};

export const importFromCsv = async (
  config: CSVSourceConfig
): Promise<MetricImport[]> => {
  // Validate configuration
  if (!config.filePath) {
    throw new Error(`[${config.name}] Source file path is not set`);
  }
  if (!config.importColumns?.length) {
    throw new Error(`[${config.name}] Import columns are not configured`);
  }
  if (!config.dateFormat) {
    throw new Error(`[${config.name}] Date format is not configured`);
  }
  if (!config.targetField) {
    logger.warn(`[${config.name}] Target field not specified, defaulting to "actual"`);
  }

  logger.info(`[${config.name}] Importing CSV from ${config.filePath}`);

  const metricsToImport: MetricCSVImport[] = await parseCsv(config);

  logger.info(
    `[${config.name}] Found ${metricsToImport.length} records in CSV`
  );

  // Map to final format and apply metric type mappings
  const mappedMetricsToImport: MetricImport[] = metricsToImport.map((m) => {
    // Check if there's a mapping for this metric type
    const metricTypeMapping = config.metricTypeMappings.find(
      (mapping) => mapping.importName === m.metricType
    );

    return {
      timestampCompatibleWithGranularity: dayjs
        .tz(m.date, config.dateFormat)
        .utc()
        .toISOString(),
      costCenter: m.costCenter,
      // Use mapped name if exists, otherwise use original
      metricType: metricTypeMapping
        ? metricTypeMapping.jobdoneName
        : m.metricType,
      value: m.value,
      targetField: config.targetField || "actual",
    };
  });

  logger.info(
    `[${config.name}] Successfully processed ${mappedMetricsToImport.length} metrics`
  );

  return mappedMetricsToImport;
};
