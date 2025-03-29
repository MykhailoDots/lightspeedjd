import axios from "axios";
import type { MetricImport } from "../index";
import type { TagiNetSourceConfig } from "../config";
import logger from "../helper/logger";
import dayjs from "../helper/customDayJs";
import { sendMessageToDiscord } from "../helper/discord";

interface TagiNetResponse {
  view_rep_atomic_beitraege: TagiNetEntry[];
}

interface TagiNetEntry {
  mandant: string;
  b_von_datum: string;
  b_bis_datum: string;
  k_name: string;
  k_vorname: string;
  k_geburtsdatum: string;
  b_von_zeit: string;
  b_bis_zeit: string;
  b_wochentag: string;
  ba_morgenessen: string;
  ba_vormittag: string;
  ba_mittagessen: string;
  ba_nachmittag: string;
  ba_abendessen: string;
  view_rep_atomic_beitraege_fld_id: string;
  view_rep_atomic_kinder_fld_id: string;
  view_rep_atomic_beitraege_block_fld_id: string;
  view_rep_atomic_belegungsarten_fld_id: string;
}

export const importFromTagiNet = async (
  source: TagiNetSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  logger.info(`[${source.name}] Starting TagiNet import...`);

  try {
    // Calculate date range
    const dateFrom = dayjs()
      .subtract(source.daysPast, "day")
      .format("YYYY-MM-DD");
    const dateTo = dayjs().add(source.daysFuture, "day").format("YYYY-MM-DD");

    logger.info(
      `[${source.name}] Fetching TagiNet data from ${dateFrom} to ${dateTo}`
    );

    // Construct the URL with parameters
    const url = `${source.apiUrl}?structure=flat&datefrom=${dateFrom}&dateto=${dateTo}`;

    // Make the API request with basic auth
    const response = await axios.get<TagiNetResponse>(url, {
      auth: {
        username: source.username,
        password: source.password,
      },
    });

    if (!response.data || !response.data.view_rep_atomic_beitraege) {
      throw new Error("No data or invalid data returned from TagiNet API");
    }

    const entries = response.data.view_rep_atomic_beitraege;
    logger.info(
      `[${source.name}] Retrieved ${entries.length} entries from TagiNet`
    );

    // Process the data and convert to MetricImport format
    const metricsMap = new Map<string, number>();

    // For tracking data needed to calculate averages
    const dailySums = new Map<string, number>();
    const dailyCounts = new Map<string, number>();

    for (const entry of entries) {
      // Check if the entry has a valid date range that overlaps with our query period
      const entryStartDate = dayjs(entry.b_von_datum);
      const entryEndDate = dayjs(entry.b_bis_datum);

      // Skip if the entry's date range doesn't overlap with our query period
      if (entryEndDate.isBefore(dateFrom) || entryStartDate.isAfter(dateTo)) {
        continue;
      }

      // Calculate child's age in months
      const birthDate = dayjs(entry.k_geburtsdatum);
      const today = dayjs();
      const ageInMonths = today.diff(birthDate, "month");

      // Determine weight based on age
      const weight =
        ageInMonths <= source.ageWeightThresholdMonths
          ? source.youngChildWeight
          : source.olderChildWeight;

      // Get cost center - either map the mandant name or use directly
      const costCenter =
        source.costCenterMapping?.[entry.mandant] || entry.mandant;

      // Process each day in the date range
      // Use safe way to determine the start date to avoid null
      let currentDate = entryStartDate.isAfter(dateFrom)
        ? entryStartDate
        : dayjs(dateFrom);
      const endDate = entryEndDate.isBefore(dateTo)
        ? entryEndDate
        : dayjs(dateTo);

      while (currentDate.isSameOrBefore(endDate)) {
        // Only process entries for the current weekday
        // b_wochentag values: 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday, 7=Sunday
        // dayjs weekday is 0=Sunday, 1=Monday, etc.
        const dayJsWeekday = currentDate.day();
        const entryWeekday = parseInt(entry.b_wochentag);
        const adjustedDayJsWeekday = dayJsWeekday === 0 ? 7 : dayJsWeekday; // Convert to 1-7 format

        if (adjustedDayJsWeekday === entryWeekday) {
          // Process each category/module
          const categories = [
            {
              name: "Morgenessen",
              value: entry.ba_morgenessen === "1" ? weight : 0,
            },
            {
              name: "Vormittag",
              value: entry.ba_vormittag === "1" ? weight : 0,
            },
            {
              name: "Mittagessen",
              value: entry.ba_mittagessen === "1" ? weight : 0,
            },
            {
              name: "Nachmittag",
              value: entry.ba_nachmittag === "1" ? weight : 0,
            },
            {
              name: "Abendessen",
              value: entry.ba_abendessen === "1" ? weight : 0,
            },
          ];

          // Track daily totals for average calculation
          const dateKey = `${currentDate.format("YYYY-MM-DD")}_${costCenter}`;
          let daySum = 0;
          let categoryCount = 0;

          for (const category of categories) {
            if (category.value > 0) {
              const key = `${currentDate.format("YYYY-MM-DD")}_${costCenter}_${
                category.name
              }`;
              const currentValue = metricsMap.get(key) || 0;
              metricsMap.set(key, currentValue + category.value);

              // Add to daily sum for average calculation
              daySum += category.value;
              categoryCount++;
            }
          }

          // Update totals for average calculation if we have categories with values
          if (categoryCount > 0) {
            const currentSum = dailySums.get(dateKey) || 0;
            const currentCount = dailyCounts.get(dateKey) || 0;

            dailySums.set(dateKey, currentSum + daySum);
            dailyCounts.set(dateKey, currentCount + categoryCount);
          }
        }

        // Move to next day
        currentDate = currentDate.add(1, "day");
      }
    }

    // Convert the map to MetricImport array
    const metricsToImport: MetricImport[] = [];

    // First add all the category-specific metrics
    for (const [key, value] of metricsMap.entries()) {
      const [date, costCenter, metricTypeCategory] = key.split("_");

      metricsToImport.push({
        timestampCompatibleWithGranularity: dayjs
          .tz(date, timeZone)
          .utc()
          .toISOString(),
        costCenter,
        metricType: "Kinder",
        value: value.toString(),
        metricTypeCategory,
      });
    }

    // Now calculate and add the average metrics
    for (const [dateKey, sum] of dailySums.entries()) {
      const count = dailyCounts.get(dateKey) || 1; // Avoid division by zero
      const average = sum / count;

      const [date, costCenter] = dateKey.split("_");

      metricsToImport.push({
        timestampCompatibleWithGranularity: dayjs
          .tz(date, timeZone)
          .utc()
          .toISOString(),
        costCenter,
        metricType: "Kinder",
        value: average.toFixed(2), // Round to 2 decimal places
        metricTypeCategory: "Durchschnitt",
      });
    }

    logger.info(
      `[${source.name}] Successfully processed ${metricsToImport.length} metrics`
    );

    return metricsToImport;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = `[${source.name}] Error importing from TagiNet: ${errorMessage}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
    throw error;
  }
};
