import type { MetricImport } from "../index";
import logger from "../helper/logger";
import dayjs from "../helper/customDayJs";
import { sendMessageToDiscord } from "../helper/discord";
import Imap from "imap";
import { simpleParser, type ParsedMail } from "mailparser";
import { parse } from "csv-parse/sync";
import type { EmailSourceConfig } from "../config";
import { Readable } from "stream";

export const importFromEmail = async (
  source: EmailSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  logger.info(`[${source.name}] Starting Email import...`);

  try {
    // Calculate date range
    const fromDate = dayjs().subtract(source.daysPast, "day").startOf("day");
    logger.info(
      `[${source.name}] Fetching emails from ${fromDate.format("YYYY-MM-DD")}`
    );

    // Connect to IMAP server
    const imap = new Imap({
      user: source.username,
      password: source.password,
      host: source.host,
      port: source.port,
      tls: source.secure,
      tlsOptions: { rejectUnauthorized: false },
    });

    // Process emails and parse CSVs
    const metricsToImport: MetricImport[] = await new Promise<MetricImport[]>(
      (resolve, reject) => {
        const metrics: MetricImport[] = [];

        imap.once("ready", () => {
          imap.openBox("INBOX", false, (err: Error | null, box) => {
            if (err) {
              reject(err);
              return;
            }

            // Search for emails with the specified subject
            const searchCriteria = [
              ["SUBJECT", source.subjectFilter],
              ["SINCE", fromDate.format("MMMM DD, YYYY")],
            ];

            imap.search(
              searchCriteria,
              (err: Error | null, results: number[]) => {
                if (err) {
                  reject(err);
                  return;
                }

                if (results.length === 0) {
                  logger.info(`[${source.name}] No matching emails found`);
                  resolve(metrics);
                  return;
                }

                logger.info(
                  `[${source.name}] Found ${results.length} matching emails`
                );

                const fetch = imap.fetch(results, { bodies: "", struct: true });
                let processedCount = 0;

                fetch.on("message", (msg) => {
                  msg.on("body", (stream) => {
                    // Fix: Convert to a proper stream type that simpleParser can handle
                    const readableStream = Readable.from(stream);

                    simpleParser(readableStream)
                      .then(async (parsed: ParsedMail) => {
                        // Check if there are attachments
                        if (
                          parsed.attachments &&
                          parsed.attachments.length > 0
                        ) {
                          for (const attachment of parsed.attachments) {
                            const filename = attachment.filename || "";
                            if (
                              new RegExp(source.attachmentNamePattern).test(
                                filename
                              )
                            ) {
                              logger.info(
                                `[${source.name}] Processing attachment: ${filename}`
                              );

                              try {
                                // Extract date from filename
                                const dateMatch = new RegExp(
                                  source.dateExtractionRegex
                                ).exec(filename);
                                if (!dateMatch || !dateMatch[1]) {
                                  logger.warn(
                                    `[${source.name}] Could not extract date from filename: ${filename}`
                                  );
                                  continue;
                                }

                                const extractedDate = dateMatch[1];
                                const formattedDate = dayjs(
                                  extractedDate,
                                  source.dateFormat
                                ).format("YYYY-MM-DD");

                                // Parse CSV content
                                const csvContent =
                                  attachment.content.toString("utf-8");
                                const records = parse(csvContent, {
                                  skip_empty_lines: true,
                                  trim: true,
                                });

                                // Extract cost center and value from specified cells
                                const startIndex = source.skipHeader ? 1 : 0;

                                if (
                                  records.length >
                                    source.valueCell.row - startIndex &&
                                  records[source.valueCell.row - startIndex]
                                    .length >= source.valueCell.column
                                ) {
                                  const costCenter =
                                    records[
                                      source.costCenterCell.row - startIndex
                                    ][source.costCenterCell.column - 1];
                                  const value =
                                    records[source.valueCell.row - startIndex][
                                      source.valueCell.column - 1
                                    ];

                                  if (costCenter && value) {
                                    // Apply metric type mappings if needed
                                    const metricTypeMapping =
                                      source.metricTypeMappings.find(
                                        (m) => m.importName === "Umsatz"
                                      );

                                    const metricType = source.mergeMetricTypes
                                      .enabled
                                      ? source.mergeMetricTypes.name
                                      : metricTypeMapping
                                      ? metricTypeMapping.jobdoneName
                                      : "Umsatz";

                                    metrics.push({
                                      timestampCompatibleWithGranularity: dayjs
                                        .tz(formattedDate, timeZone)
                                        .utc()
                                        .toISOString(),
                                      costCenter: costCenter.toString(),
                                      metricType,
                                      value: value.toString(),
                                      metricTypeCategory:
                                        source.metricTypeCategory || "Ist",
                                    });

                                    logger.info(
                                      `[${source.name}] Extracted metric for ${costCenter}: ${value} on ${formattedDate}`
                                    );
                                  } else {
                                    logger.warn(
                                      `[${source.name}] Could not extract costCenter or value from cells`
                                    );
                                  }
                                } else {
                                  logger.warn(
                                    `[${source.name}] CSV structure does not match expected cell positions`
                                  );
                                }
                              } catch (error) {
                                const errorMessage =
                                  error instanceof Error
                                    ? error.message
                                    : String(error);
                                logger.error(
                                  `[${source.name}] Error processing attachment: ${errorMessage}`
                                );
                              }
                            }
                          }
                        } else {
                          logger.info(
                            `[${source.name}] No attachments found in email`
                          );
                        }

                        processedCount++;
                        if (processedCount === results.length) {
                          logger.info(
                            `[${source.name}] Processed all ${results.length} emails`
                          );
                          imap.end();
                          resolve(metrics);
                        }
                      })
                      .catch((err: Error) => {
                        logger.error(
                          `[${source.name}] Error parsing email: ${err.message}`
                        );

                        processedCount++;
                        if (processedCount === results.length) {
                          imap.end();
                          resolve(metrics);
                        }
                      });
                  });
                });

                fetch.once("error", (err: Error) => {
                  logger.error(`[${source.name}] Fetch error: ${err.message}`);
                  reject(err);
                });

                fetch.once("end", () => {
                  logger.info(`[${source.name}] Fetch completed`);
                });
              }
            );
          });
        });

        imap.once("error", (err: Error) => {
          logger.error(
            `[${source.name}] IMAP connection error: ${err.message}`
          );
          reject(err);
        });

        imap.once("end", () => {
          logger.info(`[${source.name}] IMAP connection ended`);
        });

        imap.connect();
      }
    );

    logger.info(
      `[${source.name}] Successfully imported ${metricsToImport.length} metrics`
    );
    return metricsToImport;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = `[${source.name}] Error importing from Email: ${errorMessage}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
    throw error;
  }
};
