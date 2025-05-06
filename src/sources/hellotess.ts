import type { MetricImport } from "../index";
import axios from "axios";
import logger from "../helper/logger";
import dayjs from "../helper/customDayJs";
import { sendMessageToDiscord } from "../helper/discord";
import type { HelloTESSSourceConfig } from "../config";

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

export const importFromHelloTESS = async (
  source: HelloTESSSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  logger.info(`Starting helloTESS import for source: ${source.name}`);

  try {
    // Calculate date range
    const dateFrom = dayjs().subtract(source.daysPast, "day").startOf("day");
    const dateUntil = dayjs().add(source.daysFuture, "day").endOf("day");

    logger.info(
      `Fetching helloTESS invoices from ${dateFrom.format(
        "YYYY-MM-DD"
      )} to ${dateUntil.format("YYYY-MM-DD")}`
    );

    const url = `https://${source.host}/v1/invoices/period`;

    // Use simple YYYY-MM-DD format as required by the API
    const params = {
      from: dateFrom.format("YYYY-MM-DD"),
      until: dateUntil.format("YYYY-MM-DD"),
      ...(source.storeId ? { storeId: source.storeId } : {}),
    };

    logger.info(
      `Requesting URL: ${url} with params: ${JSON.stringify(params)}`
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
    const invoices = Array.isArray(response.data) ? response.data : [];

    logger.info(`Retrieved ${invoices.length} invoices from helloTESS`);

    // Group invoices by date and store
    const dailyRevenue = new Map<string, Map<string, number>>();

    invoices.forEach((invoice: HelloTESSInvoice) => {
      // Skip cancelled invoices
      if (invoice.cancelled) {
        return;
      }

      const invoiceDate = dayjs(invoice.date).format("YYYY-MM-DD");
      const storeName = invoice?.location?.store?.name?.trim();

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
      const currentTotal = dateMap.get(storeName) || 0;
      dateMap.set(storeName, currentTotal + amount);
    });

    // Convert to MetricImport format
    const metricsToImport: MetricImport[] = [];

    dailyRevenue.forEach((storeMap, date) => {
      storeMap.forEach((total, storeName) => {
        // Round to 2 decimal places
        const roundedTotal = parseFloat(total.toFixed(2));
        metricsToImport.push({
          timestampCompatibleWithGranularity: dayjs
            .tz(date, timeZone)
            .utc()
            .toISOString(),
          costCenter: storeName,
          metricType: "Umsatz",
          value: roundedTotal.toString(),
          metricTypeCategory: source.metricTypeCategory,
        });
      });
    });

    logger.info(
      `Processed ${metricsToImport.length} metrics from helloTESS invoices`
    );

    return metricsToImport;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = `Error importing from helloTESS: ${errorMessage}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
    throw error;
  }
};
