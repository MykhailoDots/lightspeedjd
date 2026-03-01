import { appEnvironment, getAppConfig } from "./config";
import { CronJob } from "cron";
import logger from "./helper/logger";
import dayjs from "./helper/customDayJs";
import type { SaveMetricDetailsInput } from "./graphql/generated/graphql";
import { sendMessageToDiscord } from "./helper/discord";
import { importFromCsv } from "./sources/csv";
import { importFromSnowflake } from "./sources/snowflake";
import { importFromMssql } from "./sources/mssql";
import { importFromPowerBIServicePrincipal } from "./sources/powerbi-service-principal";
import { importFromPowerBIDelegated } from "./sources/powerbi-delegated";
import {
  getCostCenters,
  getMetricTypes,
  refreshAuthTokenBearerToken,
  UpsertMetrics,
} from "./util";
import { importFromClock } from "./sources/clock";
import { importFromTagiNet } from "./sources/taginet";
import { importFromHelloTESS } from "./sources/hellotess";
import { importFromEmail } from "./sources/mail";
import { importFromGmail } from "./sources/gmail";
import { importFromLightspeed } from "./sources/lightspeed";
import {
  dedupeFormattedMetrics,
  detectRawConflicts,
  formatMetricsForImport,
  mergeMetrics,
  validateMetricsForSource,
} from "./core/metric-pipeline";

export interface MetricImport {
  timestampCompatibleWithGranularity: string;
  costCenter: string;
  metricType: string;
  value: string;
  metricTypeCategory: string; // renamed from targetField
}

const start = async () => {
  logger.info(`Starting Metric Importer at ${dayjs().format()}`);

  await refreshAuthTokenBearerToken();

  const appConfig = getAppConfig();

  logger.info(
    `Importing metrics for ${appEnvironment.organization.name} (${appEnvironment.organization.id})...`
  );

  const existingCostCenters = await getCostCenters({
    organizationId: appEnvironment.organization.id,
  });

  const existingMetricTypes = await getMetricTypes({
    organizationId: appEnvironment.organization.id,
  });

  let allFormattedMetricsToImport: SaveMetricDetailsInput[] = [];
  const rawMetricsBySource: { sourceName: string; metric: MetricImport }[] = [];

  for (const source of appConfig.sources) {
    if (!source.enabled) {
      logger.info(`Skipping disabled source: ${source.name}`);
      continue;
    }

    logger.info(`Processing source: ${source.name} (${source.type})`);

    try {
      let sourceMetrics: MetricImport[] = [];

      switch (source.type) {
        case "csv":
          sourceMetrics = await importFromCsv(source, appConfig.timeZone);
          break;
        case "snowflake":
          sourceMetrics = await importFromSnowflake(source, appConfig.timeZone);
          break;
        case "mssql":
          sourceMetrics = await importFromMssql(source, appConfig.timeZone);
          break;
        case "clock":
          sourceMetrics = await importFromClock(source, appConfig.timeZone);
          break;
        case "hellotess":
          sourceMetrics = await importFromHelloTESS(source, appConfig.timeZone);
          break;
        case "taginet":
          sourceMetrics = await importFromTagiNet(source, appConfig.timeZone);
          break;
        case "email":
          sourceMetrics = await importFromEmail(source, appConfig.timeZone);
          break;
        case "gmail":
          sourceMetrics = await importFromGmail(source, appConfig.timeZone);
          break;
        case "lightspeed":
          sourceMetrics = await importFromLightspeed(source, appConfig.timeZone);
          break;
        case "powerbi-sp":
          sourceMetrics = await importFromPowerBIServicePrincipal(
            source,
            appConfig.timeZone
          );
          break;
        case "powerbi-delegated":
          sourceMetrics = await importFromPowerBIDelegated(
            source,
            appConfig.timeZone
          );
          break;
        default: {
          const unknownSource = source as { name?: string; type: string };
          const sourceName = unknownSource.name || "Unknown source";
          const sourceType = unknownSource.type || "Unknown type";
          const message = `Unknown source type: ${sourceType} for ${sourceName}, skipping...`;
          logger.error(message);
          await sendMessageToDiscord({ message });
          continue;
        }
      }

      logger.info(
        `Retrieved ${sourceMetrics.length} metrics from ${source.name}`
      );

      sourceMetrics.forEach((metric) => {
        rawMetricsBySource.push({ sourceName: source.name, metric });
      });

      const {
        existingCostCenterIdsByNameMap,
        existingMetricTypesIdsByNameMap,
        metricTypeMappingsByNameMap,
        existingMetricTypeCategoryIdsByNameMap,
      } = await validateMetricsForSource(
        sourceMetrics,
        source,
        existingCostCenters,
        existingMetricTypes
      );

      const formattedMetrics = formatMetricsForImport(
        sourceMetrics,
        source,
        existingCostCenterIdsByNameMap,
        existingMetricTypesIdsByNameMap,
        existingMetricTypeCategoryIdsByNameMap,
        appConfig.timeZone
      );

      const mergedMetrics = source.mergeMetricTypes.enabled
        ? mergeMetrics(formattedMetrics)
        : formattedMetrics;

      allFormattedMetricsToImport = [
        ...allFormattedMetricsToImport,
        ...mergedMetrics,
      ];
    } catch (error) {
      const message = `Error processing source ${source.name}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      logger.error(message);
      await sendMessageToDiscord({ message });
      continue;
    }
  }

  rawMetricsBySource.sort((a, b) => {
    const left = a.metric;
    const right = b.metric;
    return (
      left.timestampCompatibleWithGranularity.localeCompare(
        right.timestampCompatibleWithGranularity
      ) ||
      left.costCenter.localeCompare(right.costCenter) ||
      left.metricType.localeCompare(right.metricType) ||
      left.metricTypeCategory.localeCompare(right.metricTypeCategory) ||
      a.sourceName.localeCompare(b.sourceName)
    );
  });

  const duplicateRawMetrics = detectRawConflicts(rawMetricsBySource);

  if (duplicateRawMetrics.length > 0) {
    logger.warn(
      `Detected ${duplicateRawMetrics.length} conflicting raw metric entries before mapping.`
    );
    logger.warn("----- RAW CONFLICTS BEGIN -----");
    duplicateRawMetrics.forEach(({ key, entries }, index) => {
      logger.warn(
        `Raw conflict key=${key} sources=${entries
          .map((entry) => `${entry.sourceName}:${entry.metric.value}`)
          .join(", ")}`
      );
      if (index < duplicateRawMetrics.length - 1) {
        logger.warn("-----");
      }
    });
    logger.warn("----- RAW CONFLICTS END -----");
  }

  const { dedupedMetrics, formattedConflicts } = dedupeFormattedMetrics(
    allFormattedMetricsToImport
  );
  allFormattedMetricsToImport = dedupedMetrics;

  if (formattedConflicts.length > 0) {
    logger.warn(
      `Detected ${formattedConflicts.length} conflicting formatted metric entries across sources.`
    );
    logger.warn("----- FORMATTED CONFLICTS BEGIN -----");
    formattedConflicts.forEach(({ key, metrics }, index) => {
      logger.warn(
        `Formatted conflict key=${key} values=${metrics
          .map((metric) => metric.value)
          .join(", ")}`
      );
      if (index < formattedConflicts.length - 1) {
        logger.warn("-----");
      }
    });
    logger.warn("----- FORMATTED CONFLICTS END -----");
  }

  allFormattedMetricsToImport.sort((a, b) => {
    return dayjs(a.timestamp).isAfter(dayjs(b.timestamp)) ? 1 : -1;
  });

  logger.info(`Total metrics to import: ${allFormattedMetricsToImport.length}`);
  console.table(allFormattedMetricsToImport);

  if (appEnvironment.isDryRun) {
    logger.info("Dry run enabled, not saving metrics...");
    return;
  }

  const batchSize = 100;
  for (let i = 0; i < allFormattedMetricsToImport.length; i += batchSize) {
    logger.info(`Saving metrics: ${i} to ${i + batchSize}`);
    const batch = allFormattedMetricsToImport.slice(i, i + batchSize);
    await UpsertMetrics({
      input: {
        details: batch,
      },
    });
  }
};

const runOnce = process.env.RUN_ONCE === "true";

if (runOnce) {
  start()
    .then(() => {
      logger.info("Run-once completed.");
      process.exit(0);
    })
    .catch((e) => {
      console.log(e);
      logger.error(
        `Run-once failed, Error: ${JSON.stringify(e, null, 2)}`
      );
      process.exit(1);
    });
} else {
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
}

process.on("SIGINT", async () => {
  logger.warn("Importer aborted...");
  process.exit();
});
