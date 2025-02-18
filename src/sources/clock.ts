import type { MetricImport } from "../index";
import logger from "../helper/logger";
import dayjs from "../helper/customDayJs";
import DigestFetch from "digest-fetch";
import { appEnvironment, type ClockSourceConfig } from "../config";
import fs from "fs/promises";
import path from "path";

interface ClockState {
  lastUpdatedAt?: string;
}

const clockStateFilePath = path.resolve(process.cwd(), "clock-state.json");

const readClockState = async (): Promise<ClockState> => {
  try {
    const data = await fs.readFile(clockStateFilePath, "utf-8");
    return JSON.parse(data) as ClockState;
  } catch (error: any) {
    logger.warn(`Unable to read clock-state.json: ${error.message}`);
    return {};
  }
};

const writeClockState = async (lastUpdatedAt: string) => {
  const clockState: ClockState = { lastUpdatedAt };
  try {
    await fs.writeFile(clockStateFilePath, JSON.stringify(clockState, null, 2));
    logger.info(
      `Updated lastUpdatedAt in clock-state.json to ${lastUpdatedAt}`
    );
  } catch (error: any) {
    logger.error(`Error writing to clock-state.json: ${error.message}`);
  }
};

export const importFromClock = async (
  config: ClockSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  logger.info(`[${config.name}] Fetching data from Clock API...`);

  const metricsToImport: MetricImport[] = [];

  if (!config.apiUser || !config.apiKey) {
    throw new Error(`[${config.name}] API user or API key not configured`);
  }

  const client = new DigestFetch(config.apiUser, config.apiKey);

  const clockState = await readClockState();
  const lastUpdatedAt = clockState.lastUpdatedAt;

  const api = `https://${config.subscriptionRegion}.clock-software.com/${config.baseApi}/${config.subscriptionId}/${config.accountId}`;
  const bookingsApi = `${api}/bookings`;

  const cacheDir = path.resolve(process.cwd(), "cache");

  if (config.isCacheEnabled) {
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      logger.info(`[${config.name}] Cache directory ensured at ${cacheDir}`);
    } catch (error: any) {
      logger.error(
        `[${config.name}] Error creating cache directory: ${error.message}`
      );
    }
  }

  try {
    let newBookingsUrl = bookingsApi;

    if (lastUpdatedAt) {
      newBookingsUrl += `?updated_at.gteq=${encodeURIComponent(lastUpdatedAt)}`;
      logger.info(
        `[${config.name}] Fetching updated bookings from ${newBookingsUrl}`
      );
    } else {
      logger.info(
        `[${config.name}] Fetching all bookings (no updated_at filter applied) from ${newBookingsUrl}`
      );
    }

    const response = await client.fetch(newBookingsUrl, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Error fetching booking list: ${response.statusText}`);
    }

    let bookingIds: number[] = await response.json();

    logger.info(`[${config.name}] Found ${bookingIds.length} bookings`);
    logger.debug(`[${config.name}] Booking IDs: ${bookingIds.join(", ")}`);

    for (const bookingId of bookingIds) {
      let booking: any;
      const cacheFilePath = path.join(cacheDir, `booking_${bookingId}.json`);

      if (config.isCacheEnabled) {
        try {
          const cachedData = await fs.readFile(cacheFilePath, "utf-8");
          booking = JSON.parse(cachedData);
          logger.info(
            `[${config.name}] Loaded booking ${bookingId} from cache`
          );
        } catch (error) {
          logger.info(
            `[${config.name}] Cache miss for booking ${bookingId}, fetching from API`
          );

          const bookingUrl = `${bookingsApi}/${bookingId}`;
          logger.info(
            `[${config.name}] Fetching booking details from ${bookingUrl}`
          );

          const bookingResponse = await client.fetch(bookingUrl, {
            method: "GET",
          });

          if (!bookingResponse.ok) {
            throw new Error(
              `Error fetching booking details: ${bookingResponse.statusText}`
            );
          }

          booking = await bookingResponse.json();

          await fs.writeFile(cacheFilePath, JSON.stringify(booking, null, 2));
          logger.info(`[${config.name}] Cached booking ${bookingId} data`);
        }
      } else {
        const bookingUrl = `${bookingsApi}/${bookingId}`;
        logger.info(
          `[${config.name}] Fetching booking details from ${bookingUrl}`
        );

        const bookingResponse = await client.fetch(bookingUrl, {
          method: "GET",
        });

        if (!bookingResponse.ok) {
          throw new Error(
            `Error fetching booking details: ${bookingResponse.statusText}`
          );
        }

        booking = await bookingResponse.json();
      }

      logger.debug(
        `[${config.name}] Processing booking ${bookingId}: ${JSON.stringify(
          booking,
          null,
          2
        )}`
      );

      // For Clock import, we now use dynamic category names:
      // - "Ist" for 'checked_in' or 'checked_out'
      // - "Geplant" for 'expected'
      const arrivalDate = dayjs(booking.arrival);
      const departureDate = dayjs(booking.departure);
      const stayDuration = departureDate.diff(arrivalDate, "day");

      if (!config.metricType) {
        throw new Error(`[${config.name}] Metric type not configured`);
      }

      let targetField: string;
      if (booking.status === "checked_in" || booking.status === "checked_out") {
        targetField = "Ist";
      } else if (booking.status === "expected") {
        targetField = "Geplant";
      } else {
        continue;
      }

      if (!config.costCenter) {
        throw new Error(`[${config.name}] Cost center not configured`);
      }

      const metricTypeMapping = config.metricTypeMappings.find(
        (m) => m.importName === config.metricType
      );
      const finalMetricType = metricTypeMapping
        ? metricTypeMapping.jobdoneName
        : config.metricType;

      for (let i = 0; i < stayDuration; i++) {
        const currentDate = arrivalDate
          .add(i, "day")
          .tz(timeZone)
          .utc()
          .toISOString();

        let existingMetric = metricsToImport.find(
          (metric) =>
            metric.timestampCompatibleWithGranularity === currentDate &&
            metric.costCenter === config.costCenter &&
            metric.metricTypeCategory === targetField
        );

        if (existingMetric) {
          logger.debug(
            `[${config.name}] Incrementing existing metric for ${currentDate}`
          );
          existingMetric.value = (
            parseInt(existingMetric.value) + 1
          ).toString();
        } else {
          const metric: MetricImport = {
            timestampCompatibleWithGranularity: currentDate,
            costCenter: config.costCenter,
            metricType: finalMetricType,
            value: "1",
            metricTypeCategory: targetField,
          };
          metricsToImport.push(metric);
        }
      }
    }

    if (!appEnvironment.isDryRun) {
      const newLastUpdatedAt = dayjs().toISOString();
      await writeClockState(newLastUpdatedAt);
    }

    if (config.isCacheEnabled && !config.isDoNotDeleteCacheEnabled) {
      try {
        const files = await fs.readdir(cacheDir);
        for (const file of files) {
          const filePath = path.join(cacheDir, file);
          await fs.unlink(filePath);
        }
        logger.info(`[${config.name}] Cache cleared from ${cacheDir}`);
      } catch (error: any) {
        logger.error(
          `[${config.name}] Error clearing cache directory: ${error.message}`
        );
      }
    }

    logger.info(
      `[${config.name}] Successfully imported ${metricsToImport.length} metrics`
    );
    return metricsToImport;
  } catch (error: any) {
    logger.error(
      `[${config.name}] Error fetching data from Clock API: ${error.message}`
    );
    throw error;
  }
};
