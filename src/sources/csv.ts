import { appConfigs } from "../config";
import { parse } from "csv-parse/sync";
import fs from "fs";
import type { MetricImport } from "..";
import dayjs from "dayjs";

// TODO: Lucky: 2024-06-23: Make import dynamic based on config to handle different csv files
export interface MetricCSVImport {
  date: string;
  costCenter: string;
  metricType: string;
  value: string;
}

const parseCsv = async (
  appConfig: (typeof appConfigs)[0]
): Promise<MetricCSVImport[]> => {
  // read csv file
  const csv = fs.readFileSync(appConfig.sources.csv.filePath, "utf8");
  const parsedCsv = parse(csv, {
    columns: [...appConfig.sources.csv.importColumns],
    skip_empty_lines: true,
  });

  // console.table(parsedCsv);

  return parsedCsv;
};

export const importFromCsv = async (
  appConfig: (typeof appConfigs)[0]
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

  const mappedMetricsIoImport: MetricImport[] = metricsToImport.map((m) => {
    return {
      timestampCompatibleWithGranularity: dayjs
        .tz(m.date, appConfig.sources.csv.dateFormat, appConfig.timeZone)
        .utc()
        .toISOString(),
      costCenter: m.costCenter,
      metricType: m.metricType,
      value: m.value,
    };
  });

  return mappedMetricsIoImport;
};
