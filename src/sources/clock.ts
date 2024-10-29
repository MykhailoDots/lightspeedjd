import type { MetricImport } from "../index.ts";
import logger from "../helper/logger.ts";
import dayjs from "../helper/customDayJs.ts";
import DigestFetch from "digest-fetch"; // Import the digest-fetch library
import type { AppConfig } from "../config.ts";
import fs from "fs/promises"; // Import Node.js file system module for promises
import path from "path";

const clockStateFilePath = path.resolve(process.cwd(), "clock-state.json");

interface ClockState {
  lastUpdatedAt?: string; // Optional in case it doesn't exist
}

// Helper function to read the clock state
const readClockState = async (): Promise<ClockState> => {
  try {
    const data = await fs.readFile(clockStateFilePath, "utf-8");
    return JSON.parse(data) as ClockState;
  } catch (error: any) {
    logger.warn(`Unable to read clock-state.json: ${error.message}`);
    // Return an empty object if the file doesn't exist or can't be read
    return {};
  }
};

// Helper function to write the clock state
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

// Helper function to sleep for a given number of milliseconds
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const importFromClock = async (
  appConfig: AppConfig
): Promise<MetricImport[]> => {
  logger.info("Fetching data from Clock API...");

  const metricsToImport: MetricImport[] = [];
  const clockConfig = appConfig.sources.clock;

  if (!clockConfig?.apiUser || !clockConfig?.apiKey) {
    throw new Error("API user or API key not configured in appConfig");
  }

  // Set up digest authentication
  const client = new DigestFetch(clockConfig?.apiUser, clockConfig?.apiKey);

  // Read lastUpdatedAt from clock-state.json
  const clockState = await readClockState();
  const lastUpdatedAt = clockState.lastUpdatedAt; // May be undefined if the file doesn't exist

  const api = `https://${clockConfig.subscriptionRegion}.clock-software.com/${clockConfig.baseApi}/${clockConfig.subscriptionId}/${clockConfig.accountId}`;
  const bookingsApi = `${api}/bookings`;

  // Define the cache directory path
  const cacheDir = path.resolve(process.cwd(), "cache");

  // Create the cache directory if it doesn't exist
  if (appConfig?.sources?.clock?.isCacheEnabled) {
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      logger.info(`Cache directory ensured at ${cacheDir}`);
    } catch (error: any) {
      logger.error(`Error creating cache directory: ${error.message}`);
    }
  }

  try {
    // Conditionally construct the URL
    let newBookingsUrl = bookingsApi;

    if (lastUpdatedAt) {
      newBookingsUrl += `?updated_at.gteq=${encodeURIComponent(lastUpdatedAt)}`;
      logger.info(`Fetching updated bookings from ${newBookingsUrl}`);
    } else {
      logger.info(
        `Fetching all bookings (no updated_at filter applied) from ${newBookingsUrl}`
      );
    }

    // Fetch the list of booking IDs
    const response = await client.fetch(newBookingsUrl, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Error fetching booking list: ${response.statusText}`);
    }

    let bookingIds: number[] = await response.json();

    console.log(`Found ${bookingIds.length} bookings`);
    console.debug(`Booking IDs: ${bookingIds.join(", ")}`);

    // if (appConfig.isDryRun) {
    //   bookingIds = bookingIds.slice(0, 5);
    // }

    // Process each booking ID
    for (const bookingId of bookingIds) {
      let booking: any;

      // Path to the cache file for this booking
      const cacheFilePath = path.join(cacheDir, `booking_${bookingId}.json`);

      if (appConfig?.sources?.clock?.isCacheEnabled) {
        // Check if the booking data is in cache
        try {
          const cachedData = await fs.readFile(cacheFilePath, "utf-8");
          booking = JSON.parse(cachedData);
          logger.info(`Loaded booking ${bookingId} from cache`);
        } catch (error) {
          // Cache miss or error reading cache, proceed to fetch from API
          logger.info(`Cache miss for booking ${bookingId}, fetching from API`);

          const bookingUrl = `${bookingsApi}/${bookingId}`;
          logger.info(`Fetching booking details from ${bookingUrl}`);

          const bookingResponse = await client.fetch(bookingUrl, {
            method: "GET",
          });

          if (!bookingResponse.ok) {
            throw new Error(
              `Error fetching booking details: ${bookingResponse.statusText}`
            );
          }

          booking = await bookingResponse.json();

          // Save the booking data to cache
          await fs.writeFile(cacheFilePath, JSON.stringify(booking, null, 2));
          logger.info(`Cached booking ${bookingId} data`);
        }
      } else {
        // Cache is not enabled, fetch from API
        const bookingUrl = `${bookingsApi}/${bookingId}`;
        logger.info(`Fetching booking details from ${bookingUrl}`);

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

      console.debug(
        `Processing booking ${bookingId}: ${JSON.stringify(booking, null, 2)}`
      );

      /**
       * Status: The Booking status can be: 'expected', 'checked_in', 'checked_out', 'canceled' or 'no_show'.
       * Bookings having the last two statuses ('canceled' or 'no_show') are considered not to be valid bookings.
       * Such bookings are not taken into availability.
       * The status is fully reversible and can be changed at any time (examples: from 'cancelled' to 'expected'; from 'checked_out' to 'checked_in', etc.)
       *
       * arrival: 2024-01-01
       * departure: 2024-01-08
       */

      /**
       * metricType: actual = 'checked_in', 'checked_out',
       * metricType: scheduled = 'expected'
       */

      // Calculate the number of days the user stays
      const arrivalDate = dayjs(booking.arrival);
      const departureDate = dayjs(booking.departure);
      const stayDuration = departureDate.diff(arrivalDate, "day");

      const metricType = appConfig?.sources?.clock?.metricType;

      if (!metricType) {
        throw new Error("Metric type not configured in appConfig");
      }

      // Determine the targetField based on the booking status
      let targetField: string;
      if (booking.status === "checked_in" || booking.status === "checked_out") {
        targetField = "actual";
      } else if (booking.status === "expected") {
        targetField = "scheduled";
      } else {
        continue; // Skip invalid statuses like 'canceled' or 'no_show'
      }

      const costCenter = appConfig?.sources?.clock?.costCenter;
      if (!costCenter) {
        throw new Error("Cost center not configured in appConfig");
      }

      // Loop through each day of the stay and create a metric
      for (let i = 0; i < stayDuration; i++) {
        const currentDate = arrivalDate
          .add(i, "day")
          .tz(appConfig.timeZone)
          .toISOString();

        // Check if metricsToImport already has a metric for this day
        let existingMetric = metricsToImport.find(
          (metric) =>
            metric.timestampCompatibleWithGranularity === currentDate &&
            metric.costCenter === costCenter &&
            metric.targetField === targetField
        );

        if (existingMetric) {
          console.log("Incrementing existing metric");
          // Increment the value if the metric already exists
          existingMetric.value = (
            parseInt(existingMetric.value) + 1
          ).toString();
        } else {
          // Create a new metric if it doesn't exist
          const metric: MetricImport = {
            timestampCompatibleWithGranularity: currentDate,
            costCenter: costCenter,
            metricType: metricType,
            value: "1",
            targetField: targetField,
          };
          metricsToImport.push(metric);
        }
      }

      // Sleep for 500 ms before fetching the next booking
      //   await sleep(500);
    }

    // Update the lastUpdatedAt to the current time after successful import
    const newLastUpdatedAt = dayjs().toISOString();

    if (!appConfig.isDryRun) {
      await writeClockState(newLastUpdatedAt);
    }

    // Clear the cache if cache is enabled and we do not skip deletion
    if (
      appConfig?.sources?.clock?.isCacheEnabled &&
      !appConfig?.sources?.clock?.isDoNotDeleteCacheEnabled
    ) {
      try {
        const files = await fs.readdir(cacheDir);
        for (const file of files) {
          const filePath = path.join(cacheDir, file);
          await fs.unlink(filePath);
        }
        logger.info(`Cache cleared from ${cacheDir}`);
      } catch (error: any) {
        logger.error(`Error clearing cache directory: ${error.message}`);
      }
    }

    console.table(metricsToImport);

    return metricsToImport;
  } catch (error: any) {
    logger.error(`Error fetching data from Clock API: ${error.message}`);
    throw error;
  }
};
