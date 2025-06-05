import { appEnvironment, getAppConfig } from "./config";
import { CronJob } from "cron";
import logger from "./helper/logger";
import dayjs from "./helper/customDayJs";
import type {
  CostCentersByOrganizationIdQuery,
  MetricTypesByOrganizationIdQuery,
  SaveMetricDetailsInput,
} from "./graphql/generated/graphql";
import { sendMessageToDiscord } from "./helper/discord";
import { importFromCsv } from "./sources/csv";
import { importFromSnowflake } from "./sources/snowflake";
import {
  getCostCenters,
  getMetricTypes,
  refreshAuthTokenBearerToken,
  UpsertMetrics,
} from "./util";
import type { SourceConfigType } from "./config";
import { importFromClock } from "./sources/clock";
import { importFromTagiNet } from "./sources/taginet";
import { importFromHelloTESS } from "./sources/hellotess";
import { importFromEmail } from "./sources/mail";

export interface MetricImport {
  timestampCompatibleWithGranularity: string;
  costCenter: string;
  metricType: string;
  value: string;
  metricTypeCategory: string; // renamed from targetField
}

const validateMetricsForSource = async (
  metricsToImport: MetricImport[],
  sourceConfig: SourceConfigType,
  existingCostCenters: CostCentersByOrganizationIdQuery,
  existingMetricTypes: MetricTypesByOrganizationIdQuery
) => {
  // Apply metric type mappings for metric types
  const renamedExistingMetricTypes = existingMetricTypes.metricType.map((c) => {
    const metricTypeMapping = sourceConfig.metricTypeMappings.find(
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

  const costCenterMappingField = sourceConfig.costCenterMappingField;
  const existingCostCenterIdsByNameMap: Map<string, string> = new Map();
  const existingMetricTypesIdsByNameMap: Map<string, string> = new Map();
  const metricTypeMappingsByNameMap = new Map();

  // Build the map using the selected field
  existingCostCenters.costCenter.forEach((c) => {
    const key = c[costCenterMappingField as keyof typeof c];
    if (key) {
      existingCostCenterIdsByNameMap.set(key as string, c.id);
    }
  });
  renamedExistingMetricTypes.forEach((m) => {
    existingMetricTypesIdsByNameMap.set(m.name, m.id);
  });
  sourceConfig.metricTypeMappings.forEach((m) => {
    metricTypeMappingsByNameMap.set(m.importName, m.jobdoneName);
  });

  const costCenterNamesToImport = new Set(
    metricsToImport.map((m) => m.costCenter)
  );
  const metricTypeNamesToImport = new Set(
    metricsToImport.map((m) => m.metricType)
  );

  // Check by selected field excluding ignored cost centers
  const notExistingCostCenterNames = Array.from(costCenterNamesToImport)
    .filter(
      (c) =>
        !existingCostCenters.costCenter.some(
          (cc) => cc[costCenterMappingField as keyof typeof cc] === c
        )
    )
    .filter((c) => !sourceConfig.ignoredMissingCostCenters.includes(c));

  const notExistingMetricTypeNames = Array.from(metricTypeNamesToImport).filter(
    (m) => !existingMetricTypes.metricType.some((mt) => mt.name === m)
  );

  if (notExistingCostCenterNames.length > 0) {
    const message = `[${
      sourceConfig.name
    }] Cost center names not found in JobDone: ${notExistingCostCenterNames.join(
      ", "
    )}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
  }

  if (notExistingMetricTypeNames.length > 0) {
    const message = `[${
      sourceConfig.name
    }] Metric type names not found in JobDone: ${notExistingMetricTypeNames.join(
      ", "
    )}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
  }

  // Validate metric type category for each metric import
  // (We now need to ensure that the category belongs to the effective metric type.)
  const notExistingMetricTypeCategoryNames = new Set<string>();
  metricsToImport.forEach((m) => {
    // Determine the effective metric type name.
    // When mergeMetricTypes is enabled, we always require the merge metric type.
    const effectiveMetricTypeName = sourceConfig.mergeMetricTypes.enabled
      ? sourceConfig.mergeMetricTypes.name
      : m.metricType;

    // Find all metric types matching this name.
    const matchingMetricTypes = existingMetricTypes.metricType.filter(
      (mt) => mt.name === effectiveMetricTypeName
    );
    if (matchingMetricTypes.length > 1) {
      // Metric type names should be unique.
      throw new Error(
        `[${sourceConfig.name}] Multiple metric types found with name '${effectiveMetricTypeName}'. Metric type names must be unique.`
      );
    }
    if (matchingMetricTypes.length === 0) {
      // This error will be handled by the earlier check.
      return;
    }
    const metricTypeObj = matchingMetricTypes[0];
    // Now check if the metric import's category exists within this metric type.
    if (
      !metricTypeObj.metricTypeCategories.some(
        (cat) => cat.name === m.metricTypeCategory
      )
    ) {
      notExistingMetricTypeCategoryNames.add(m.metricTypeCategory);
    }
  });

  if (notExistingMetricTypeCategoryNames.size > 0) {
    const message = `[${
      sourceConfig.name
    }] The following metric type categories do not belong to the effective metric type: ${Array.from(
      notExistingMetricTypeCategoryNames
    ).join(", ")}`;
    logger.error(message);
    throw new Error(message);
  }

  const mergeMetricTypeName = sourceConfig.mergeMetricTypes.name;
  if (
    sourceConfig.mergeMetricTypes.enabled &&
    !existingMetricTypes.metricType.some(
      (mt) => mt.name === mergeMetricTypeName
    )
  ) {
    const message = `[${sourceConfig.name}] Merge Metric type is enabled but does not exist in JobDone: ${mergeMetricTypeName}`;
    logger.error(message);
    throw new Error(message);
  }

  // Build a mapping of metric type category names to IDs for later use.
  // (Note that these names may not be unique across metric types, but our checks above ensure we use the correct one.)
  const existingMetricTypeCategoryIdsByNameMap: Map<string, string> = new Map();
  existingMetricTypes.metricType.forEach((mt) => {
    mt.metricTypeCategories.forEach((cat) => {
      // Only add if this category belongs to the effective metric type for merged metrics.
      if (sourceConfig.mergeMetricTypes.enabled) {
        if (mt.name === sourceConfig.mergeMetricTypes.name) {
          existingMetricTypeCategoryIdsByNameMap.set(cat.name, cat.id);
        }
      } else {
        existingMetricTypeCategoryIdsByNameMap.set(cat.name, cat.id);
      }
    });
  });

  return {
    existingCostCenterIdsByNameMap,
    existingMetricTypesIdsByNameMap,
    metricTypeMappingsByNameMap,
    existingMetricTypeCategoryIdsByNameMap,
  };
};

const formatMetricsForImport = (
  sourceMetrics: MetricImport[],
  sourceConfig: SourceConfigType,
  existingCostCenterIdsByNameMap: Map<string, string>,
  existingMetricTypesIdsByNameMap: Map<string, string>,
  existingMetricTypeCategoryIdsByNameMap: Map<string, string>,
  timeZone: string
): SaveMetricDetailsInput[] => {
  const formattedMetrics: SaveMetricDetailsInput[] = [];
  const metricsUnableToImport: {
    MetricImport: MetricImport;
    Reason: string;
  }[] = [];

  sourceMetrics.forEach((m) => {
    const costCenterId = existingCostCenterIdsByNameMap.get(m.costCenter);
    const metricTypeId = sourceConfig.mergeMetricTypes.enabled
      ? existingMetricTypesIdsByNameMap.get(sourceConfig.mergeMetricTypes.name)
      : existingMetricTypesIdsByNameMap.get(m.metricType);

    if (!costCenterId) {
      if (!sourceConfig.ignoredMissingCostCenters.includes(m.costCenter)) {
        logger.error(
          `[${sourceConfig.name}] Cost center does not exist: ${m.costCenter}`
        );
        metricsUnableToImport.push({
          MetricImport: m,
          Reason: `Cost center does not exist: ${m.costCenter}`,
        });
      }
      return;
    }

    if (!metricTypeId) {
      if (sourceConfig.mergeMetricTypes.enabled) {
        logger.error(
          `[${sourceConfig.name}] Merge Metric type does not exist: ${sourceConfig.mergeMetricTypes.name}`
        );
        metricsUnableToImport.push({
          MetricImport: m,
          Reason: `Merge Metric type does not exist: ${sourceConfig.mergeMetricTypes.name}`,
        });
      } else {
        logger.error(
          `[${sourceConfig.name}] Metric type does not exist: ${m.metricType}`
        );
        metricsUnableToImport.push({
          MetricImport: m,
          Reason: `Metric type does not exist: ${m.metricType}`,
        });
      }
      return;
    }

    const metricTypeCategoryId = existingMetricTypeCategoryIdsByNameMap.get(
      m.metricTypeCategory
    );
    if (!metricTypeCategoryId) {
      logger.error(
        `[${sourceConfig.name}] Metric type category does not exist: ${m.metricTypeCategory}`
      );
      metricsUnableToImport.push({
        MetricImport: m,
        Reason: `Metric type category does not exist: ${m.metricTypeCategory}`,
      });
      return;
    }

    formattedMetrics.push({
      costCenterId,
      metricTypeId,
      metricTypeCategoryId,
      // description: null, // IMPORTANT: Removing entierly, to not overwrite existing descriptions from users!
      timeZone,
      timestamp: m.timestampCompatibleWithGranularity,
      value: parseFloat(parseFloat(m.value).toFixed(2)),
    });
  });

  if (metricsUnableToImport.length > 0) {
    logger.info(
      `[${sourceConfig.name}] Metrics unable to import:`,
      JSON.stringify(metricsUnableToImport, null, 2)
    );
    console.table(metricsUnableToImport);
  }

  return formattedMetrics;
};

const mergeMetrics = (
  metrics: SaveMetricDetailsInput[]
): SaveMetricDetailsInput[] => {
  const mergedMetrics = new Map<string, SaveMetricDetailsInput>();

  metrics.forEach((metric) => {
    const key = `${metric.timestamp}-${metric.costCenterId}-${metric.metricTypeId}`;
    if (!mergedMetrics.has(key)) {
      mergedMetrics.set(key, { ...metric, value: 0 });
    }

    const existingMetric = mergedMetrics.get(key);
    if (existingMetric) {
      const currentValue = existingMetric.value || 0;
      const newValue = metric.value || 0;
      existingMetric.value = parseFloat((currentValue + newValue).toFixed(2));
    }
  });

  return Array.from(mergedMetrics.values());
};

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

process.on("SIGINT", async () => {
  logger.warn("Importer aborted...");
  process.exit();
});
