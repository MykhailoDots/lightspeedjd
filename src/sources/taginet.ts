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

/**
 * Calculate weight for a child based on their age at the booking date
 * @param birthDate - Child's birth date in YYYY-MM-DD format
 * @param bookingDate - Booking date in YYYY-MM-DD format
 * @returns Weight multiplier based on age rules
 */
export function calculateChildWeight(
  birthDate: string,
  bookingDate: string
): number {
  const birth = dayjs(birthDate);
  const booking = dayjs(bookingDate);
  const ageInMonths = booking.diff(birth, "month");

  // Check if child turns 5 after June 30th in the booking year
  const yearOfBooking = booking.year();
  const fifthBirthday = birth.add(5, "year");
  const june30 = dayjs(`${yearOfBooking}-06-30`);

  if (fifthBirthday.isAfter(june30) && fifthBirthday.year() === yearOfBooking) {
    return 0.5;
  }

  // Age-based weights
  if (ageInMonths < 18) return 1.5;
  if (ageInMonths <= 36) return 1.0;
  return 0.8;
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

    for (const entry of entries) {
      // Check if the entry has a valid date range that overlaps with our query period
      const entryStartDate = dayjs(entry.b_von_datum);
      const entryEndDate = dayjs(entry.b_bis_datum);

      // Skip if the entry's date range doesn't overlap with our query period
      if (entryEndDate.isBefore(dateFrom) || entryStartDate.isAfter(dateTo)) {
        continue;
      }

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
          // Check if this cost center should use unweighted values
          const isUnweighted = source.unweightedCostCenters?.includes(
            entry.mandant
          );

          if (isUnweighted) {
            logger.debug(
              `[${source.name}] Using unweighted values for cost center: ${costCenter}`
            );
          }

          // Calculate weight based on age or use 1 for unweighted centers
          const weight = isUnweighted
            ? 1
            : calculateChildWeight(
                entry.k_geburtsdatum,
                currentDate.format("YYYY-MM-DD")
              );

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

          for (const category of categories) {
            if (category.value > 0) {
              const key = `${currentDate.format("YYYY-MM-DD")}_${costCenter}_${
                category.name
              }`;
              const currentValue = metricsMap.get(key) || 0;
              metricsMap.set(key, currentValue + category.value);
            }
          }
        }

        // Move to next day
        currentDate = currentDate.add(1, "day");
      }
    }

    // Convert the map to MetricImport array
    const metricsToImport: MetricImport[] = [];

    // Group metrics by date and cost center to calculate averages
    const categoryMetricsByDateAndCenter = new Map<
      string,
      Map<string, number>
    >();

    // First populate the grouped metrics map
    for (const [key, value] of metricsMap.entries()) {
      const [date, costCenter, category] = key.split("_");
      const dateAndCenterKey = `${date}_${costCenter}`;

      if (!categoryMetricsByDateAndCenter.has(dateAndCenterKey)) {
        categoryMetricsByDateAndCenter.set(
          dateAndCenterKey,
          new Map<string, number>()
        );
      }

      const categoryMap = categoryMetricsByDateAndCenter.get(dateAndCenterKey)!;
      categoryMap.set(category, value);
    }

    // Now process the grouped metrics and calculate averages
    for (const [
      dateAndCenterKey,
      categoryMap,
    ] of categoryMetricsByDateAndCenter.entries()) {
      const [date, costCenter] = dateAndCenterKey.split("_");
      const timestamp = dayjs.tz(date, timeZone).utc().toISOString();

      // Add each category metric
      for (const [category, value] of categoryMap.entries()) {
        metricsToImport.push({
          timestampCompatibleWithGranularity: timestamp,
          costCenter,
          metricType: "Kinder",
          value: value.toString(),
          metricTypeCategory: category,
        });
      }

      // Calculate and add the average
      if (categoryMap.size > 0) {
        const categoryValues = Array.from(categoryMap.values());
        const sum = categoryValues.reduce((acc, val) => acc + val, 0);
        const average = sum / categoryMap.size;

        metricsToImport.push({
          timestampCompatibleWithGranularity: timestamp,
          costCenter,
          metricType: "Kinder",
          value: average.toFixed(2),
          metricTypeCategory: "Durchschnitt",
        });
      }
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
