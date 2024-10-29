import { type AppConfig, type TransformColumn } from "../config";
import { parse } from "csv-parse/sync";
import fs from "fs";
import type { MetricImport } from "..";
import dayjs from "dayjs";
import logger from "../helper/logger";

// TODO: Lucky: 2024-06-23: Make import dynamic based on config to handle different csv files
export interface MetricCSVImport {
  date: string;
  costCenter: string;
  metricType: string;
  value: string;
}

const applyTransformations = (
  data: any[],
  transformations: TransformColumn[]
) => {
  return data.map((row) => {
    console.log("raw row", JSON.stringify(row, null, 2));
    transformations.forEach(({ outputColumn, operation, operands }) => {
      if (operation === "add") {
        // Ensure operands exist
        if (row[operands[0]] && row[operands[1]]) {
          row[outputColumn] = (
            parseFloat(row[operands[0]]) + parseFloat(row[operands[1]])
          ).toFixed(2);
        }
      }
    });
    console.log("transformed row", JSON.stringify(row, null, 2));
    return row;
  });
};

const parseCsv = async (appConfig: AppConfig): Promise<MetricCSVImport[]> => {
  // read csv file
  const csv = fs.readFileSync(appConfig.sources.csv.filePath, "utf8");
  let parsedCsv = parse(csv, {
    columns: [...appConfig.sources.csv.importColumns],
    skip_empty_lines: true,
  });

  if (
    appConfig.sources.csv.transformColumns &&
    appConfig.sources.csv.transformColumns.length
  ) {
    logger.info("Applying transformations to CSV data");
    parsedCsv = applyTransformations(
      parsedCsv,
      appConfig.sources.csv.transformColumns
    );
  }

  if (!parsedCsv) {
    throw new Error("No formatted CSV data");
  }

  return parsedCsv?.map((row: any) => {
    return {
      date: row.date,
      costCenter: row.costCenter,
      metricType: row.metricType,
      value: row.value,
    };
  });
};

export const importFromCsv = async (
  appConfig: AppConfig
): Promise<MetricImport[]> => {
  // check that all appConfig values are set
  if (!appConfig.sources.csv.filePath) {
    throw new Error("appConfig.sources.csv.filePath is not set");
  }
  if (!appConfig.sources.csv.importColumns) {
    throw new Error("appConfig.sources.csv.importColumns is not set");
  }
  if (!appConfig.sources.csv.dateFormat) {
    throw new Error("appConfig.sources.csv.dateFormat is not set");
  }

  const metricsToImport: MetricCSVImport[] = await parseCsv(appConfig);

  // console.log(metricsToImport);

  const mappedMetricsIoImport: MetricImport[] = metricsToImport.map((m) => {
    return {
      timestampCompatibleWithGranularity: dayjs
        .tz(m.date, appConfig.sources.csv.dateFormat, appConfig.timeZone)
        .utc()
        .toISOString(),
      costCenter: m.costCenter,
      metricType: m.metricType,
      value: m.value,
      targetField: "actual",
    };
  });

  return mappedMetricsIoImport;
};
