import type { HelloTESSSourceConfig } from "../configs/seerose";
import type { MetricImport } from "../index";
import axios from "axios";
import logger from "../helper/logger";
import dayjs from "../helper/customDayJs";
import { sendMessageToDiscord } from "../helper/discord";

interface HelloTESSInvoice {
  id: string;
  number: string;
  date: string;
  cancelled: boolean;
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

    const params = {
      from: dateFrom.toISOString(),
      until: dateUntil.toISOString(),
      ...(source.storeId ? { storeId: source.storeId } : {}),
    };

    const response = await axios.get<{ data: HelloTESSInvoice[] }>(url, {
      headers: {
        "hellotess-api-key": source.apiKey,
        "Content-Type": "application/json",
      },
      params,
    });

    if (!response.data) {
      throw new Error("No data returned from helloTESS API");
    }

    const invoices = Array.isArray(response.data)
      ? response.data
      : (response.data as any).data || [];

    logger.info(`Retrieved ${invoices.length} invoices from helloTESS`);

    // Group invoices by date and store
    const dailyRevenue = new Map<string, Map<string, number>>();

    invoices.forEach((invoice: HelloTESSInvoice) => {
      // Skip cancelled invoices
      if (invoice.cancelled) {
        return;
      }

      const invoiceDate = dayjs(invoice.date).format("YYYY-MM-DD");
      const storeId = invoice.location.store.id;
      const storeName = invoice.location.store.name;
      const grossAmount = invoice.totals.gross;

      if (!dailyRevenue.has(invoiceDate)) {
        dailyRevenue.set(invoiceDate, new Map<string, number>());
      }

      const dateMap = dailyRevenue.get(invoiceDate)!;
      const currentTotal = dateMap.get(storeName) || 0;
      dateMap.set(storeName, currentTotal + grossAmount);
    });

    // Convert to MetricImport format
    const metricsToImport: MetricImport[] = [];

    dailyRevenue.forEach((storeMap, date) => {
      storeMap.forEach((total, storeName) => {
        metricsToImport.push({
          timestampCompatibleWithGranularity: date,
          costCenter: storeName,
          metricType: "Umsatz",
          value: total.toString(),
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
