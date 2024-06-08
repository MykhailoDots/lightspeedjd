import { parse } from "csv-parse/sync";
import type { GroupedMetric, MetricCSVImport } from "./types.ts";
import { appConfig } from "./config.ts";
import fs from "fs";
import { CronJob } from "cron";
import logger from "./helper/logger.ts";
import { getCostCenters, getMetricTypes } from "./util.ts";
import dayjs from "./customDayJs.ts";
import type {
  CostCentersByOrganizationIdQuery,
  MetricTypesByOrganizationIdQuery,
  SaveMetricDetailsInput,
} from "./graphql/generated/graphql.ts";

const parseCsv = async (fileName: string): Promise<MetricCSVImport[]> => {
  // read csv file
  const csv = fs.readFileSync(fileName, "utf8");
  const parsedCsv = parse(csv, {
    columns: [...appConfig.importer.importColumns],
    skip_empty_lines: true,
  });

  return parsedCsv;
};

const start = async () => {
  const metricsToImport: MetricCSVImport[] = await parseCsv(
    appConfig.importer.filePath
  );

  const existingCostCenters: CostCentersByOrganizationIdQuery =
    await getCostCenters({ organizationId: appConfig.jobdone.organization.id });
  const existingMetricTypes: MetricTypesByOrganizationIdQuery =
    await getMetricTypes({ organizationId: appConfig.jobdone.organization.id });

  const metricTypeMappings = appConfig.importer.metricTypeMappings;

  const renamedExistingMetricTypes = existingMetricTypes.metricType.map((c) => {
    const metricTypeMapping = metricTypeMappings.find(
      (m) => m.importName === c.name
    );

    if (metricTypeMapping) {
      return {
        ...c,
        name: metricTypeMapping.jobdoneName,
      };
    }
    return c;
  });

  const existingCostCenterIdsByNameMap: Map<string, string> = new Map();
  const existingMetricTypesIdsByNameMap: Map<string, string> = new Map();
  const metricTypeMappingsByNameMap = new Map();

  existingCostCenters.costCenter.forEach((c) => {
    existingCostCenterIdsByNameMap.set(c.name, c.id);
  });
  renamedExistingMetricTypes.forEach((m) => {
    existingMetricTypesIdsByNameMap.set(m.name, m.id);
  });
  metricTypeMappings.forEach((m) => {
    metricTypeMappingsByNameMap.set(m.importName, m.jobdoneName);
  });

  const costCentersToImport = new Set(metricsToImport.map((m) => m.costCenter));
  const metricTypesToImport = new Set(metricsToImport.map((m) => m.metricType));

  // check by name
  const notExistingCostCenters = Array.from(costCentersToImport).filter(
    (c) => !existingCostCenters.costCenter.some((cc) => cc.name === c)
  );

  const notExistingMetricTypes = Array.from(metricTypesToImport).filter(
    (m) => !existingMetricTypes.metricType.some((mt) => mt.name === m)
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

  if (appConfig.importer.mergeMetricTypes.enabled) {
    const metricType = appConfig.importer.mergeMetricTypes.name;
    if (!existingMetricTypes.metricType.some((mt) => mt.name === metricType)) {
      logger.error(`Merge Metric type does not exist: ${metricType}`);
      return;
    }
  }

  const formattedMetricsToImport: SaveMetricDetailsInput[] = [];
  const metricsUnableToImport: {
    MetricCSVImport: MetricCSVImport;
    Reason: string;
  }[] = [];

  metricsToImport.forEach((m) => {
    const costCenterId = existingCostCenterIdsByNameMap.get(m.costCenter);
    const metricTypeId = existingMetricTypesIdsByNameMap.get(m.metricType);
    const metricTypeMapping = metricTypeMappingsByNameMap.get(m.metricType);

    if (!costCenterId) {
      logger.error(`Cost center does not exist: ${m.costCenter}`);
      metricsUnableToImport.push({
        MetricCSVImport: m,
        Reason: `Cost center does not exist: ${m.costCenter}`,
      });
      return;
    }

    if (!metricTypeId) {
      logger.error(`Metric type does not exist: ${m.metricType}`);
      metricsUnableToImport.push({
        MetricCSVImport: m,
        Reason: `Metric type does not exist: ${m.metricType}`,
      });
      return;
    }

    if (!metricTypeMapping) {
      logger.error(`Metric type mapping does not exist: ${m.metricType}`);
      metricsUnableToImport.push({
        MetricCSVImport: m,
        Reason: `Metric type mapping does not exist: ${m.metricType}`,
      });
      return;
    }

    formattedMetricsToImport.push({
      costCenterId,
      metricTypeId,
      field: metricTypeMapping.targetField,
      description: null,
      timeZone: appConfig.importer.timeZone,
      timestamp: dayjs
        .tz(m.date, appConfig.importer.timeZone)
        .utc()
        .toISOString(),
      value: parseFloat(m.value),
    });
  });

  if (appConfig.importer.isDryRun) {
    logger.info("Dry run enabled, not saving metrics...");
    logger.info("Metrics to import:", formattedMetricsToImport);
    logger.info("Metrics unable to import:", metricsUnableToImport);
    return;
  }
};

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
  timeZone: "Europe/Zurich",
  runOnInit: true,
});

/**
 * Gracefully handle SIGINT
 */
process.on("SIGINT", async () => {
  logger.warn("Importer aborted...");
  process.exit();
});
