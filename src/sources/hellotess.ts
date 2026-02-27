import type { MetricImport } from "../index";
import axios from "axios";
import logger from "../helper/logger";
import dayjs from "../helper/customDayJs";
import { sendMessageToDiscord } from "../helper/discord";
import type { HelloTESSSourceConfig } from "../config";
import path from "path";
import fs from "fs/promises";

interface HelloTESSInvoice {
  id: string;
  number: string;
  date: string;
  cancelled: boolean;
  articles: Array<{
    id: string;
    articleGroupId: string;
    articleGroupName: string;
    plu: string;
    name: string;
    basePrice: number;
    price: number;
    quantity: number;
    totalPrice: number;
    taxRate: number;
    dateAdded: string;
    isTakeAway: boolean;
  }>;
  totals: {
    gross: number;
    net: number;
    tax: number;
    subvention: number;
    surcharge: number;
  };
  location: {
    store: {
      id: string;
      name: string;
      number: number;
    };
    table?: {
      id: string;
      name: string;
    };
  };
}

// Store historical import status in a file to avoid repeated imports
const HISTORICAL_IMPORT_STATUS_FILE = ".hellotess_historical_import_done";

const checkHistoricalImportDone = async (
  sourceName: string,
  host: string
): Promise<boolean> => {
  try {
    const statusFilePath = path.join(
      process.cwd(),
      `${HISTORICAL_IMPORT_STATUS_FILE}_${sourceName}_${host}`
    );
    await fs.access(statusFilePath);
    return true;
  } catch (error) {
    return false;
  }
};

const markHistoricalImportDone = async (
  sourceName: string,
  host: string
): Promise<void> => {
  try {
    const statusFilePath = path.join(
      process.cwd(),
      `${HISTORICAL_IMPORT_STATUS_FILE}_${sourceName}_${host}`
    );
    await fs.writeFile(statusFilePath, new Date().toISOString());
    logger.info(`[${sourceName}] Historical import marked as completed`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `[${sourceName}] Failed to mark historical import as completed: ${errorMessage}`
    );
  }
};

// Helper function to process invoices and convert to metric imports
const processInvoices = (
  invoices: HelloTESSInvoice[],
  source: HelloTESSSourceConfig,
  timeZone: string
): MetricImport[] => {
  // Group invoices by date and store
  const dailyRevenue = new Map<string, Map<string, number>>();
  const costCenterFrom = source.costCenterFrom || "storeName";

  invoices.forEach((invoice: HelloTESSInvoice) => {
    // Skip cancelled invoices
    if (invoice.cancelled) {
      return;
    }

    const invoiceDate = dayjs(invoice.date).format("YYYY-MM-DD");
    const storeNameRaw = invoice?.location?.store?.name?.trim();
    if (!storeNameRaw) {
      return;
    }
    if (source.storeNameFilter) {
      const filterNormalized = source.storeNameFilter.trim().toLowerCase();
      if (storeNameRaw.toLowerCase() !== filterNormalized) {
        return;
      }
    }
    const storeIdRaw = invoice?.location?.store?.id?.trim();
    const costCenterRaw =
      costCenterFrom === "storeId" ? storeIdRaw : storeNameRaw;
    if (!costCenterRaw) {
      return;
    }
    const costCenter =
      costCenterFrom === "storeName" && source.costCenterNamePrefix
        ? `${source.costCenterNamePrefix}${costCenterRaw}`
        : costCenterRaw;

    // Determine whether to use net or gross revenue based on configuration
    // Default to net if not specified
    const revenueType = source.revenueType || "net";

    // Convert from cents to actual currency value (if needed)
    const amount =
      revenueType === "gross"
        ? invoice?.totals?.gross / 100 || 0
        : invoice?.totals?.net / 100 || 0;

    if (!dailyRevenue.has(invoiceDate)) {
      dailyRevenue.set(invoiceDate, new Map<string, number>());
    }

    const dateMap = dailyRevenue.get(invoiceDate)!;
    const currentTotal = dateMap.get(costCenter) || 0;
    dateMap.set(costCenter, currentTotal + amount);
  });

  // Convert to MetricImport format
  const metricsToImport: MetricImport[] = [];

  dailyRevenue.forEach((storeMap, date) => {
    storeMap.forEach((total, costCenter) => {
      // Round to 2 decimal places
      const roundedTotal = parseFloat(total.toFixed(2));
      metricsToImport.push({
        timestampCompatibleWithGranularity: dayjs
          .tz(date, timeZone)
          .utc()
          .toISOString(),
        costCenter,
        metricType: "Umsatz",
        value: roundedTotal.toString(),
        metricTypeCategory: source.metricTypeCategory,
      });
    });
  });

  return metricsToImport;
};

// Function to fetch invoices for a specific date range
const fetchInvoices = async (
  source: HelloTESSSourceConfig,
  dateFrom: string,
  dateUntil: string
): Promise<HelloTESSInvoice[]> => {
  const url = `https://${source.host}/v1/invoices/period`;

  // Lucky: 2025-05-07: Unsure if we need to convert Zurich or config.timeZone to UTC
  // Add specific time components to the dates (00:00:00 for from, 23:59:59 for until)
  const fromWithTime = `${dateFrom}T00:00:00`;
  const untilWithTime = `${dateUntil}T23:59:59`;

  // Use date format with time as required by the API
  const params = {
    from: fromWithTime,
    until: untilWithTime,
    ...(source.storeId ? { storeId: source.storeId } : {}),
  };

  logger.info(
    `[${source.name}] Requesting URL: ${url} with params: ${JSON.stringify(
      params
    )}`
  );

  const response = await axios.get<HelloTESSInvoice[]>(url, {
    headers: {
      "hellotess-api-key": source.apiKey,
      "Content-Type": "application/json",
    },
    params,
  });

  if (!response.data) {
    throw new Error("No data returned from helloTESS API");
  }

  // Handle response - API returns array directly, not wrapped in a data property
  return Array.isArray(response.data) ? response.data : [];
};

export const importFromHelloTESS = async (
  source: HelloTESSSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  logger.info(`Starting helloTESS import for source: ${source.name}`);

  try {
    let allMetricsToImport: MetricImport[] = [];

    // Check if we need to do a historical import
    const shouldRunHistoricalImport =
      source.historicalImport?.enabled &&
      !(await checkHistoricalImportDone(source.name, source.host));

    if (shouldRunHistoricalImport) {
      logger.info(
        `[${source.name}] Starting historical data import from ${
          source.historicalImport!.startDate
        }`
      );

      const startDate = dayjs(source.historicalImport!.startDate);
      const endDate = dayjs().subtract(1, "day").endOf("day"); // Yesterday end of day

      // Use batchSizeInDays or default to 30 days per request
      const batchSizeInDays = source.historicalImport!.batchSizeInDays || 30;

      // Get rate limit delay in ms (default: 1000ms)
      const rateLimitDelay = source.historicalImport!.rateLimitDelayMs || 1000;

      // Calculate number of batches needed
      let currentDate = startDate;

      while (currentDate.isBefore(endDate)) {
        const batchEndDate = dayjs(currentDate).add(
          batchSizeInDays - 1,
          "days"
        );
        const actualEndDate = batchEndDate.isAfter(endDate)
          ? endDate
          : batchEndDate;

        logger.info(
          `[${source.name}] Historical import batch: ${currentDate.format(
            "YYYY-MM-DD"
          )} to ${actualEndDate.format("YYYY-MM-DD")}`
        );

        const invoices = await fetchInvoices(
          source,
          currentDate.format("YYYY-MM-DD"),
          actualEndDate.format("YYYY-MM-DD")
        );

        logger.info(
          `[${source.name}] Retrieved ${invoices.length} historical invoices from helloTESS`
        );

        // Process the invoices
        const batchMetrics = processInvoices(invoices, source, timeZone);
        allMetricsToImport = [...allMetricsToImport, ...batchMetrics];

        // Move to next batch
        currentDate = actualEndDate.add(1, "day");

        // Wait after each batch to avoid rate limits
        logger.debug(
          `[${source.name}] Waiting ${rateLimitDelay}ms to avoid rate limits`
        );
        await new Promise((resolve) => setTimeout(resolve, rateLimitDelay));
      }

      logger.info(
        `[${source.name}] Historical import completed: ${allMetricsToImport.length} metrics imported`
      );

      // Mark historical import as done
      await markHistoricalImportDone(source.name, source.host);
    }

    // Regular import for recent data
    // Calculate date range for regular sync
    const dateFrom = dayjs().subtract(source.daysPast, "day").startOf("day");
    const dateUntil = dayjs().add(source.daysFuture, "day").endOf("day");

    // Buffer: fetch one extra day into the past to avoid partial-day boundary issues
    const bufferedDateFrom = dayjs(dateFrom).subtract(1, "day");

    logger.info(
      `[${source.name}] Fetching recent helloTESS invoices from ${bufferedDateFrom.format(
        "YYYY-MM-DD"
      )} to ${dateUntil.format("YYYY-MM-DD")}`
    );

    const recentInvoices = await fetchInvoices(
      source,
      bufferedDateFrom.format("YYYY-MM-DD"),
      dateUntil.format("YYYY-MM-DD")
    );

    logger.info(
      `[${source.name}] Retrieved ${recentInvoices.length} recent invoices from helloTESS`
    );

    // Process recent invoices
    const recentMetricsAll = processInvoices(recentInvoices, source, timeZone);

    // Keep only metrics whose business day is within [dateFrom, dateUntil] inclusive.
    // Use an exclusive upper bound at the start of (dateUntil + 1 day) in business TZ.
    const lowerBoundISO = dayjs
      .tz(dateFrom.format("YYYY-MM-DD"), timeZone) // 00:00 local on dateFrom
      .utc()
      .toISOString();

    const upperBoundExclusiveISO = dayjs
      .tz(dateUntil.add(1, "day").format("YYYY-MM-DD"), timeZone) // 00:00 local on the day after dateUntil
      .utc()
      .toISOString();

    const recentMetrics = recentMetricsAll.filter((m) => {
      const ts = m.timestampCompatibleWithGranularity; // ISO string at 00:00 local for that business day (in UTC)
      return ts >= lowerBoundISO && ts < upperBoundExclusiveISO;
    });

    // Combine historical and recent metrics, avoiding duplicates
    const seenKeys = new Set();
    const uniqueMetrics: MetricImport[] = [];

    [...allMetricsToImport, ...recentMetrics].forEach((metric) => {
      const key = `${metric.timestampCompatibleWithGranularity}_${metric.costCenter}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        uniqueMetrics.push(metric);
      }
    });

    logger.info(
      `[${source.name}] Total metrics to import: ${uniqueMetrics.length}`
    );

    return uniqueMetrics;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = `Error importing from helloTESS: ${errorMessage}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
    throw error;
  }
};
