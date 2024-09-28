import { SOURCE, appConfigs, appEnvironment } from "./config.ts";
import { CronJob } from "cron";
import logger from "./helper/logger.ts";
import dayjs from "./helper/customDayJs.ts";
import type {
  CostCentersByOrganizationIdQuery,
  MetricTypesByOrganizationIdQuery,
  SaveMetricDetailsInput,
} from "./graphql/generated/graphql.ts";
import { sendMessageToDiscord } from "./helper/discord.ts";
import { importFromCsv } from "./sources/csv.ts";
import { importFromSnowflake } from "./sources/snowflake.ts";
import {
  getCostCenters,
  getMetricTypes,
  refreshAuthTokenBearerToken,
  UpsertMetrics,
} from "./util.ts";

export interface MetricImport {
  timestampCompatibleWithGranularity: string;
  costCenter: string;
  metricType: string;
  value: string;
}

const start = async () => {
  logger.info(`Starting Metric Importer at ${dayjs().format()}`);

  await refreshAuthTokenBearerToken();

  for (const appConfig of appConfigs) {
    logger.info(
      `Importing metrics from ${appConfig.sources.activeSource} for ${appEnvironment.organization.name} (${appEnvironment.organization.id})...`
    );
    let metricsToImport: MetricImport[] = [];

    if (appConfig.sources.activeSource === SOURCE.CSV) {
      logger.info(`Importing metrics from CSV...`);
      metricsToImport = await importFromCsv(appConfig);
    } else if (appConfig.sources.activeSource === SOURCE.SNOWFLAKE) {
      logger.info(`Importing metrics from Snowflake...`);
      metricsToImport = await importFromSnowflake(appConfig);
    } else {
      const message = `Unknown source: ${appConfig.sources.activeSource}, aborting...`;
      logger.error(message);
      await sendMessageToDiscord({ message });
    }

    const existingCostCenters: CostCentersByOrganizationIdQuery =
      await getCostCenters({
        organizationId: appEnvironment.organization.id,
      });
    const existingMetricTypes: MetricTypesByOrganizationIdQuery =
      await getMetricTypes({
        organizationId: appEnvironment.organization.id,
      });

    const metricTypeMappings = appConfig.metricTypeMappings;
    const renamedExistingMetricTypes = existingMetricTypes.metricType.map(
      (c) => {
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
      }
    );

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
    const notExistingCostCenterNames = Array.from(costCenterNamesToImport)
      .filter(
        (c) => !existingCostCenters.costCenter.some((cc) => cc.name === c)
      )
      .filter((c) => !appConfig.ignoredMissingCostCenters.includes(c));
    const notExistingMetricTypeNames = Array.from(
      metricTypeNamesToImport
    ).filter(
      (m) => !existingMetricTypes.metricType.some((mt) => mt.name === m)
    );

    if (notExistingCostCenterNames.length > 0) {
      const message = `Cost center names not found in JobDone: ${notExistingCostCenterNames.join(
        ", "
      )}`;
      logger.error(message);
      await sendMessageToDiscord({ message });
      // return;
    }

    if (!appConfig.mergeMetricTypes && notExistingMetricTypeNames.length > 0) {
      const message = `Metric type names not found in JobDone: ${notExistingMetricTypeNames.join(
        ", "
      )}`;
      logger.error(message);
      await sendMessageToDiscord({ message });
      // return;
    }

    if (appConfig.mergeMetricTypes.enabled) {
      const mergeMetricTypeName = appConfig.mergeMetricTypes.name;
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
      MetricCSVImport: MetricImport;
      Reason: string;
    }[] = [];

    metricsToImport.forEach((m) => {
      const costCenterId = existingCostCenterIdsByNameMap.get(m.costCenter);
      const metricTypeId = appConfig.mergeMetricTypes.enabled
        ? existingMetricTypesIdsByNameMap.get(appConfig.mergeMetricTypes.name)
        : existingMetricTypesIdsByNameMap.get(m.metricType);
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
        if (appConfig.mergeMetricTypes.enabled) {
          logger.error(
            `Merge Metric type does not exist: ${appConfig.mergeMetricTypes.name}`
          );
          metricsUnableToImport.push({
            MetricCSVImport: m,
            Reason: `Merge Metric type does not exist: ${appConfig.mergeMetricTypes.name}`,
          });
          return;
        } else {
          logger.error(`Metric type does not exist: ${m.metricType}`);
          metricsUnableToImport.push({
            MetricCSVImport: m,
            Reason: `Metric type does not exist: ${m.metricType}`,
          });
          return;
        }
      }

      if (!appConfig.mergeMetricTypes.enabled && !metricTypeMapping) {
        logger.error(
          `Merge Metric type mapping does not exist: ${appConfig.mergeMetricTypes.name}`
        );
        metricsUnableToImport.push({
          MetricCSVImport: m,
          Reason: `Merge Metric type mapping does not exist: ${appConfig.mergeMetricTypes.name}`,
        });
        return;
      }

      formattedMetricsToImport.push({
        costCenterId,
        metricTypeId,
        field: appConfig.mergeMetricTypes.enabled
          ? appConfig.mergeMetricTypes.targetField
          : metricTypeMapping.targetField,
        description: null,
        timeZone: appConfig.timeZone,
        timestamp: m.timestampCompatibleWithGranularity,
        value: parseFloat(parseFloat(m.value).toFixed(2)),
      });
    });

    // if appConfig.mergeMetricTypes.enabled is enabled, sum the value of metrics that have the same timestamp, costCenterId, and metricTypeId
    if (appConfig.mergeMetricTypes.enabled) {
      const mergedMetrics = new Map();
      formattedMetricsToImport.forEach((metric) => {
        const key = `${metric.timestamp}-${metric.costCenterId}-${metric.metricTypeId}`;
        if (!mergedMetrics.has(key)) {
          mergedMetrics.set(key, { ...metric, value: 0 });
        }
        mergedMetrics.get(key).value += metric.value;
        mergedMetrics.get(key).value = parseFloat(
          mergedMetrics.get(key).value.toFixed(2)
        );
      });
      formattedMetricsToImport.length = 0;
      formattedMetricsToImport.push(...Array.from(mergedMetrics.values()));
    }

    // order by timestamp
    formattedMetricsToImport.sort((a, b) => {
      return dayjs(a.timestamp).isAfter(dayjs(b.timestamp)) ? 1 : -1;
    });

    logger.info(
      `Metrics to import: ${formattedMetricsToImport.length}, Metrics unable to import: ${metricsUnableToImport.length}`
    );
    // logger.info(
    //   "Metrics to import:",
    //   JSON.stringify(formattedMetricsToImport, null, 2)
    // );
    // console.table(formattedMetricsToImport);
    logger.info(
      "Metrics unable to import:",
      JSON.stringify(metricsUnableToImport, null, 2)
    );
    console.table(metricsUnableToImport);

    if (appConfig.isDryRun) {
      logger.info("Dry run enabled, not saving metrics...");
      return;
    } else {
      // save in batches of 100
      const batchSize = 100;

      for (let i = 0; i < formattedMetricsToImport.length; i += batchSize) {
        logger.info(`Saving metrics: ${i} to ${i + batchSize}`);
        const batch = formattedMetricsToImport.slice(i, i + batchSize);
        await UpsertMetrics({
          input: {
            details: batch,
          },
        });
      }
    }
  }
};

logger.info(`Cron time: ${appEnvironment.cronTime}`);

CronJob.from({
  cronTime: appEnvironment.cronTime,
  onTick: async () => {
    try {
      await start();
    } catch (e) {
      console.log(e);
      logger.error(
        `Metric Importer crashed, Error: ${JSON.stringify(e, null, 2)}`
      );
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
