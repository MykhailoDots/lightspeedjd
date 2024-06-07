import { parse } from "csv-parse/sync";
import type {GroupedMetric, MetricCSVImport} from "./types.ts";
import {appConfig} from "./config.ts";
import fs from "fs";
import {CronJob} from 'cron';
import logger from "./logger.ts";
import {getCostCenters, getMetricTypes, saveMetric} from "./util.ts";
import dayjs from "./customDayJs.ts";

const parseCsv = async (
  fileName: string
): Promise<MetricCSVImport[]> => {
  // read csv file
  const csv = fs.readFileSync(fileName, "utf8");
  const parsedCsv = parse(csv, {
    columns: appConfig.importer.columns,
    skip_empty_lines: true,
  });

  return parsedCsv;
};

const start = async () => {
  const metricsToImport: MetricCSVImport[] = await parseCsv(
      appConfig.importer.filePath
  );

  const existingCostCenters = getCostCenters();
  const existingMetricTypes = getMetricTypes();

  const costCenters = new Set(metricsToImport.map((m) => m.costCenter));
  const metricTypes = new Set(metricsToImport.map((m) => m.metricType));

  const notExistingCostCenters = Array.from(costCenters).filter(
        (c) => !existingCostCenters.includes(c)
    );

  const notExistingMetricTypes = Array.from(metricTypes).filter(
        (m) => !existingMetricTypes.includes(m)
    );

    if (notExistingCostCenters.length > 0) {
        logger.error(
            `Cost centers do not exist: ${notExistingCostCenters.join(", ")}`
        );
        return;
    }

    if (notExistingMetricTypes.length > 0) {
        logger.error(
            `Metric types do not exist: ${notExistingMetricTypes.join(", ")}`
        );
        return;
    }

  const groupedMetrics: GroupedMetric[] = [];

  costCenters.forEach((costCenter) => {
    if(appConfig.importer.mergeMetricTypes.enabled) {
      const metrics = metricsToImport.filter(
          (m) => m.costCenter === costCenter
      );
      const dates = metrics.map((m) => m.date);
      const uniqueDates = new Set(dates);
        uniqueDates.forEach((date) => {
            const sum = metrics
                .filter((m) => m.date === date)
                .reduce((acc, curr) => acc + parseFloat(curr.value), 0);
            groupedMetrics.push({
            date,
            costCenter,
            metricType: appConfig.importer.mergeMetricTypes.name,
            value: sum,
            });
        });
    } else {
      metricTypes.forEach((metricType) => {
        const metrics = metricsToImport.filter(
            (m) => m.costCenter === costCenter && m.metricType === metricType
        );

        const dates = metrics.map((m) => m.date);
        const uniqueDates = new Set(dates);

        uniqueDates.forEach((date) => {
          const sum = metrics
              .filter((m) => m.date === date)
              .reduce((acc, curr) => acc + parseFloat(curr.value), 0);

          groupedMetrics.push({
            date,
            costCenter,
            metricType,
            value: sum,
          });
        });
      });
    }
  });

  const metrics = groupedMetrics.map((m) => {
    return {
      costCenterId: existingCostCenters[m.costCenter]
      description: m.metricType,
      field: m.metricType,
      metricTypeId: existingMetricTypes[m.metricType],
      timeZone: appConfig.importer.timeZone,
      timestamp: dayjs.tz(m.date, appConfig.importer.timeZone).utc().toISOString(),
      value: m.value,
    };
  });

  for(const metric of metrics) {
    logger.info(`Importing metric: ${JSON.stringify(metric, null, 2)}`);
    if(!appConfig.importer.isDryRun) {
      await saveMetric(metric);
    } else {
      logger.info(`Dry run, not importing metric`);
    }
  }
}


CronJob.from({
  cronTime: appConfig.importer.cron.schedule,
  onTick: async () => {
    try {
      await start();
    } catch (e) {
      logger.error(`Import crashed, Error: ${JSON.stringify(e, null, 2)}`);
    }
  },
  start: true,
  timeZone: 'Europe/Zurich',
  runOnInit: true,
});

/**
 * Gracefully handle SIGINT
 */
process.on("SIGINT", async () => {
  logger.warn("Importer aborted...");
  process.exit();
});