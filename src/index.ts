import { parse } from "csv-parse/sync";
import { appConfig } from "./config.ts";
import fs from "fs";
import { CronJob } from "cron";
import logger from "./helper/logger.ts";
import { getCostCenters, getMetricTypes } from "./util.ts";
import dayjs from "./helper/customDayJs.ts";
import type {
  CostCentersByOrganizationIdQuery,
  MetricTypesByOrganizationIdQuery,
  SaveMetricDetailsInput,
} from "./graphql/generated/graphql.ts";
import { checkDiskUsage } from "./helper/diskUsage.ts";
import { sendMessageToDiscord } from "./helper/discord.ts";

export interface MetricCSVImport {
  date: string;
  costCenter: string;
  metricType: string;
  value: string;
}

const parseCsv = async (fileName: string): Promise<MetricCSVImport[]> => {
  // read csv file
  const csv = fs.readFileSync(fileName, "utf8");
  const parsedCsv = parse(csv, {
    columns: [...appConfig.app.importColumns],
    skip_empty_lines: true,
  });

  return parsedCsv;
};

const start = async () => {
  logger.info(`Starting Metric Importer)...`);

  await checkDiskUsage();

  const metricsToImport: MetricCSVImport[] = await parseCsv(
    appConfig.app.filePath
  );

  const existingCostCenters: CostCentersByOrganizationIdQuery =
    await getCostCenters({
      organizationId: appConfig.environment.organization.id,
    });
  const existingMetricTypes: MetricTypesByOrganizationIdQuery =
    await getMetricTypes({
      organizationId: appConfig.environment.organization.id,
    });

  const metricTypeMappings = appConfig.app.metricTypeMappings;

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

  const costCenterNamesToImport = new Set(
    metricsToImport.map((m) => m.costCenter)
  );
  const metricTypeNamesToImport = new Set(
    metricsToImport.map((m) => m.metricType)
  );

  // check by name
  const notExistingCostCenterNames = Array.from(costCenterNamesToImport).filter(
    (c) => !existingCostCenters.costCenter.some((cc) => cc.name === c)
  );
  const notExistingMetricTypeNames = Array.from(metricTypeNamesToImport).filter(
    (m) => !existingMetricTypes.metricType.some((mt) => mt.name === m)
  );

  if (notExistingCostCenterNames.length > 0) {
    const message = `Cost center names not found in JobDone: ${notExistingCostCenterNames.join(
      ", "
    )}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
    return;
  }

  if (notExistingMetricTypeNames.length > 0) {
    const message = `Metric type names not found in JobDone: ${notExistingMetricTypeNames.join(
      ", "
    )}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
    return;
  }

  if (appConfig.app.mergeMetricTypes.enabled) {
    const mergeMetricTypeName = appConfig.app.mergeMetricTypes.name;
    if (
      !existingMetricTypes.metricType.some(
        (mt) => mt.name === mergeMetricTypeName
      )
    ) {
      logger.error(
        `Merge Metric types is enabled and does not exist in JobDone: ${mergeMetricTypeName}`
      );
      throw new Error(
        `Merge Metric types is enabled and does not exist in JobDone: ${mergeMetricTypeName}`
      );
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
      timeZone: appConfig.app.timeZone,
      timestamp: dayjs.tz(m.date, appConfig.app.timeZone).utc().toISOString(),
      value: parseFloat(m.value),
    });
  });

  if (appConfig.app.isDryRun) {
    logger.info("Dry run enabled, not saving metrics...");
    logger.info("Metrics to import:", formattedMetricsToImport);
    logger.info("Metrics unable to import:", metricsUnableToImport);
    return;
  }
};

CronJob.from({
  cronTime: appConfig.app.cron.schedule,
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
