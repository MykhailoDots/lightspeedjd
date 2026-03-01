import type {
  CostCentersByOrganizationIdQuery,
  MetricTypesByOrganizationIdQuery,
  SaveMetricDetailsInput,
} from "../graphql/generated/graphql";
import type { SourceConfigType } from "../config";
import logger from "../helper/logger";
import { sendMessageToDiscord } from "../helper/discord";
import type { MetricImport } from "../index";

export const normalizeCostCenterKey = (
  value: string,
  prefixLength?: number
): string => {
  if (!value) return value;
  if (prefixLength && prefixLength > 0 && value.length > prefixLength) {
    return value.slice(0, prefixLength);
  }
  return value;
};

export const resolveFanOutTargets = (
  metricCostCenter: string,
  sourceConfig: SourceConfigType,
  _existingCostCenterIdsByNameMap?: Map<string, string>
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

export const validateMetricsForSource = async (
  metricsToImport: MetricImport[],
  sourceConfig: SourceConfigType,
  existingCostCenters: CostCentersByOrganizationIdQuery,
  existingMetricTypes: MetricTypesByOrganizationIdQuery
) => {
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

  const getCostCenterKey = (
    cc: CostCentersByOrganizationIdQuery["costCenter"][number]
  ) => {
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
      resolveFanOutTargets(
        m.costCenter,
        sourceConfig,
        existingCostCenterIdsByNameMap
      )
    )
  );
  const metricTypeNamesToImport = new Set(
    metricsToImport.map((m) => m.metricType)
  );

  const notExistingCostCenterNames = Array.from(costCenterNamesToImport)
    .filter(
      (c) =>
        !existingCostCenters.costCenter.some((cc) => {
          const rawKeyStr = getCostCenterKey(cc);
          if (!rawKeyStr) return false;
          const normalized = normalizeCostCenterKey(
            rawKeyStr,
            costCenterPrefixLength
          );
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

  const notExistingMetricTypeCategoryNames = new Set<string>();
  metricsToImport.forEach((m) => {
    const effectiveMetricTypeName = sourceConfig.mergeMetricTypes.enabled
      ? sourceConfig.mergeMetricTypes.name
      : m.metricType;

    const matchingMetricTypes = existingMetricTypes.metricType.filter(
      (mt) => mt.name === effectiveMetricTypeName
    );
    if (matchingMetricTypes.length > 1) {
      throw new Error(
        `[${sourceConfig.name}] Multiple metric types found with name '${effectiveMetricTypeName}'. Metric type names must be unique.`
      );
    }
    if (matchingMetricTypes.length === 0) {
      return;
    }
    const metricTypeObj = matchingMetricTypes[0];
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

  const existingMetricTypeCategoryIdsByNameMap: Map<string, string> = new Map();
  existingMetricTypes.metricType.forEach((mt) => {
    mt.metricTypeCategories.forEach((cat) => {
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

export const formatMetricsForImport = (
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

export const mergeMetrics = (
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

export interface RawMetricBySourceEntry {
  sourceName: string;
  metric: MetricImport;
}

export interface RawConflictEntry {
  key: string;
  entries: RawMetricBySourceEntry[];
}

export const detectRawConflicts = (
  rawMetricsBySource: RawMetricBySourceEntry[]
): RawConflictEntry[] => {
  return Array.from(
    rawMetricsBySource.reduce((acc, entry) => {
      const { metric, sourceName } = entry;
      const dedupeKey = [
        metric.timestampCompatibleWithGranularity,
        metric.costCenter,
        metric.metricType,
        metric.metricTypeCategory,
      ].join("|");

      const list = acc.get(dedupeKey) ?? [];
      list.push({ sourceName, metric });
      acc.set(
        dedupeKey,
        list.sort((a, b) => a.sourceName.localeCompare(b.sourceName))
      );
      return acc;
    }, new Map<string, RawMetricBySourceEntry[]>())
  )
    .filter(([, entries]) => {
      if (entries.length <= 1) {
        return false;
      }
      const uniqueValues = new Set(entries.map((entry) => Number(entry.metric.value)));
      return uniqueValues.size > 1;
    })
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, entries]) => ({ key, entries }));
};

export interface FormattedConflictEntry {
  key: string;
  metrics: SaveMetricDetailsInput[];
}

export const dedupeFormattedMetrics = (
  allFormattedMetricsToImport: SaveMetricDetailsInput[]
): {
  dedupedMetrics: SaveMetricDetailsInput[];
  formattedConflicts: FormattedConflictEntry[];
} => {
  const formattedConflicts: FormattedConflictEntry[] = [];
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
      return;
    }

    formattedConflicts.push({ key, metrics: [existing, metric] });
  });

  return {
    dedupedMetrics: Array.from(dedupedFormattedMetrics.values()),
    formattedConflicts,
  };
};
