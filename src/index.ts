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
import { importFromMssql } from "./sources/mssql";
import { importFromPowerBIServicePrincipal } from "./sources/powerbi-service-principal";
import { importFromPowerBIDelegated } from "./sources/powerbi-delegated";
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
import { importFromLightspeed } from "./sources/lightspeed";

export interface MetricImport {
  timestampCompatibleWithGranularity: string;
  costCenter: string;
  metricType: string;
  value: string;
  metricTypeCategory: string; // renamed from targetField
}

const normalizeCostCenterKey = (
  value: string,
  prefixLength?: number
): string => {
  if (!value) return value;
  if (prefixLength && prefixLength > 0 && value.length > prefixLength) {
    return value.slice(0, prefixLength);
  }
  return value;
};

const resolveFanOutTargets = (
  metricCostCenter: string,
  sourceConfig: SourceConfigType,
  existingCostCenterIdsByNameMap: Map<string, string>
): string[] => {
  const normalized = normalizeCostCenterKey(
    metricCostCenter,
    sourceConfig.costCenterPrefixLength
  );
  const fanOut = sourceConfig.costCenterFanOut;
  if (fanOut?.mode === "mapping") {
    const mapped = fanOut.mapping[normalized];
    if (mapped && mapped.length > 0) {
      return mapped;
    }
  }
  return [normalized];
};

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
  const costCenterPrefixLength = sourceConfig.costCenterPrefixLength;
  const existingCostCenterIdsByNameMap: Map<string, string> = new Map();
  const existingMetricTypesIdsByNameMap: Map<string, string> = new Map();
  const metricTypeMappingsByNameMap = new Map();

  // Build the map using the selected field
  const getCostCenterKey = (cc: CostCentersByOrganizationIdQuery["costCenter"][number]) => {
    const raw = cc[costCenterMappingField as keyof typeof cc];
    if (raw) return String(raw);
    if (costCenterMappingField === "customId" && cc.name) {
      return String(cc.name);
    }
    return "";
  };

  const sortedCostCenters = [...existingCostCenters.costCenter].sort((a, b) => {
    const aRaw = getCostCenterKey(a);
    const bRaw = getCostCenterKey(b);

    if (
      costCenterMappingField === "customId" &&
      costCenterPrefixLength &&
      costCenterPrefixLength > 0
    ) {
      const aPref = aRaw.endsWith("00") ? 0 : 1;
      const bPref = bRaw.endsWith("00") ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
    }

    return aRaw.localeCompare(bRaw) || a.id.localeCompare(b.id);
  });

  const duplicateCostCenterKeys: Map<string, string[]> = new Map();
  const normalizedKeys: Map<string, string> = new Map();

  sortedCostCenters.forEach((c) => {
    const rawKeyStr = getCostCenterKey(c);
    if (!rawKeyStr) return;
    const key = normalizeCostCenterKey(rawKeyStr, costCenterPrefixLength);

    if (normalizedKeys.has(key)) {
      const list = duplicateCostCenterKeys.get(key) ?? [];
      list.push(rawKeyStr);
      duplicateCostCenterKeys.set(key, list);
    } else {
      normalizedKeys.set(key, c.id);
      existingCostCenterIdsByNameMap.set(key, c.id);
    }

    // Always register the full key for explicit fan-out mappings.
    existingCostCenterIdsByNameMap.set(rawKeyStr, c.id);
  });

  if (duplicateCostCenterKeys.size > 0) {
    const preview = Array.from(duplicateCostCenterKeys.entries())
      .slice(0, 5)
      .map(([key, values]) => `${key} -> ${values.join(", ")}`)
      .join(" | ");
    logger.warn(
      `[${sourceConfig.name}] Multiple cost centers share the same key after prefixing. ` +
        `Using the first match (prefer customId ending in "00" when available). ` +
        `Examples: ${preview}${duplicateCostCenterKeys.size > 5 ? " ..." : ""}`
    );
  }
  renamedExistingMetricTypes.forEach((m) => {
    existingMetricTypesIdsByNameMap.set(m.name, m.id);
  });
  sourceConfig.metricTypeMappings.forEach((m) => {
    metricTypeMappingsByNameMap.set(m.importName, m.jobdoneName);
  });

  const costCenterNamesToImport = new Set(
    metricsToImport.flatMap((m) =>
      resolveFanOutTargets(m.costCenter, sourceConfig, existingCostCenterIdsByNameMap)
    )
  );
  const metricTypeNamesToImport = new Set(
    metricsToImport.map((m) => m.metricType)
  );

  // Check by selected field excluding ignored cost centers
  const notExistingCostCenterNames = Array.from(costCenterNamesToImport).filter(
    (c) =>
      !existingCostCenters.costCenter.some((cc) => {
        const rawKeyStr = getCostCenterKey(cc);
        if (!rawKeyStr) return false;
        const normalized = normalizeCostCenterKey(rawKeyStr, costCenterPrefixLength);
        return normalized === c || rawKeyStr === c;
      })
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
  const costCenterPrefixLength = sourceConfig.costCenterPrefixLength;

  sourceMetrics.forEach((m) => {
    const targetCostCenters = resolveFanOutTargets(
      m.costCenter,
      sourceConfig,
      existingCostCenterIdsByNameMap
    );
    const metricTypeId = sourceConfig.mergeMetricTypes.enabled
      ? existingMetricTypesIdsByNameMap.get(sourceConfig.mergeMetricTypes.name)
      : existingMetricTypesIdsByNameMap.get(m.metricType);

    let foundAnyCostCenter = false;

    targetCostCenters.forEach((targetKey) => {
      const costCenterId = existingCostCenterIdsByNameMap.get(targetKey);
      if (!costCenterId) {
        if (!sourceConfig.ignoredMissingCostCenters.includes(targetKey)) {
          logger.error(
            `[${sourceConfig.name}] Cost center does not exist: ${targetKey}`
          );
          metricsUnableToImport.push({
            MetricImport: m,
            Reason: `Cost center does not exist: ${targetKey}`,
          });
        }
        return;
      }

      foundAnyCostCenter = true;

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

    if (!foundAnyCostCenter) {
      return;
    }
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

  const duplicateRawMetrics = Array.from(
    rawMetricsBySource.reduce(
      (acc, entry) => {
        const { metric, sourceName } = entry;
        const dedupeKey = [
          metric.timestampCompatibleWithGranularity,
          metric.costCenter,
          metric.metricType,
          metric.metricTypeCategory,
        ].join("|");

        const list = acc.get(dedupeKey) ?? [];
        list.push({ sourceName, metric });
        acc.set(dedupeKey, list.sort((a, b) =>
          a.sourceName.localeCompare(b.sourceName)
        ));
        return acc;
      },
      new Map<
        string,
        { sourceName: string; metric: MetricImport }[]
      >()
    )
  )
    .filter(([, entries]) => {
      if (entries.length <= 1) {
        return false;
      }
      const uniqueValues = new Set(
        entries.map((entry) => Number(entry.metric.value))
      );
      return uniqueValues.size > 1;
    })
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

  if (duplicateRawMetrics.length > 0) {
    logger.warn(
      `Detected ${duplicateRawMetrics.length} conflicting raw metric entries before mapping.`
    );
    logger.warn("----- RAW CONFLICTS BEGIN -----");
    duplicateRawMetrics.forEach(([key, entries], index) => {
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

  const formattedConflicts: Array<{
    key: string;
    metrics: SaveMetricDetailsInput[];
  }> = [];
  const dedupedFormattedMetrics = new Map<string, SaveMetricDetailsInput>();

  allFormattedMetricsToImport.forEach((metric) => {
    const key = [
      metric.timestamp,
      metric.costCenterId,
      metric.metricTypeId,
      metric.metricTypeCategoryId,
    ].join("|");

    const existing = dedupedFormattedMetrics.get(key);
    if (!existing) {
      dedupedFormattedMetrics.set(key, metric);
      return;
    }

    const existingValue = existing.value ?? 0;
    const incomingValue = metric.value ?? 0;
    if (Math.abs(existingValue - incomingValue) < 0.000001) {
      // Identical value from another source, skip silently.
      return;
    }

    formattedConflicts.push({ key, metrics: [existing, metric] });
    // Keep the first occurrence; the later conflicting value is dropped.
  });

  allFormattedMetricsToImport = Array.from(dedupedFormattedMetrics.values());

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
