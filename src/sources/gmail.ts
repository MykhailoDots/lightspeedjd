import type { MetricImport } from "../index";
import logger from "../helper/logger";
import dayjs from "../helper/customDayJs";
import { sendMessageToDiscord } from "../helper/discord";
import Imap from "imap";
import {
  simpleParser,
  type ParsedMail,
  type HeaderValue,
  type AddressObject,
  type EmailAddress,
} from "mailparser";
import { parse } from "csv-parse/sync";
import type { GmailSourceConfig } from "../config";
import { appEnvironment } from "../config";
import { Readable } from "stream";

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAILBOX_DELIMITER = "/";

export const RECIPIENT_HEADER_PRIORITY = [
  "delivered-to",
  "x-original-to",
  "to",
] as const;

type RoutingAnalysis =
  | {
      status: "match";
      recipient: string;
      costCenterId: string;
      labelName: string;
    }
  | { status: "no-match" }
  | { status: "invalid-alias"; recipients: string[] }
  | { status: "ambiguous"; recipients: string[]; costCenterIds: string[] };

interface ParsedMessage {
  uid: number;
  parsed: ParsedMail;
}

interface MailboxEntry {
  name: string;
  selectable: boolean;
}

type DayjsInstance = ReturnType<typeof dayjs>;

const parseEmailAddress = (value: string): { local: string; domain: string } | null => {
  const trimmed = value.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return null;
  }

  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  if (!local || !domain) {
    return null;
  }

  return { local, domain };
};

const pushRecipient = (target: string[], seen: Set<string>, value: string) => {
  const trimmed = value.trim();
  const normalizedKey = trimmed.toLowerCase();
  if (!trimmed || seen.has(normalizedKey)) {
    return;
  }
  seen.add(normalizedKey);
  target.push(trimmed);
};

const extractEmailsFromString = (value: string): string[] => {
  const matches = value.match(EMAIL_PATTERN);
  if (!matches) {
    return [];
  }
  return matches.map((item) => item.trim());
};

const extractEmailsFromAddressObjects = (addressObject: AddressObject): string[] => {
  const emails: string[] = [];

  const collect = (entry: EmailAddress) => {
    if (entry.address) {
      emails.push(entry.address);
    }
    if (entry.group && entry.group.length > 0) {
      entry.group.forEach(collect);
    }
  };

  addressObject.value.forEach(collect);
  return emails;
};

const extractEmailsFromHeaderValue = (headerValue: HeaderValue | undefined): string[] => {
  if (!headerValue) {
    return [];
  }

  if (typeof headerValue === "string") {
    return extractEmailsFromString(headerValue);
  }

  if (Array.isArray(headerValue)) {
    return headerValue.flatMap((value) =>
      typeof value === "string" ? extractEmailsFromString(value) : []
    );
  }

  if (headerValue instanceof Date) {
    return [];
  }

  if ("value" in headerValue && Array.isArray(headerValue.value)) {
    return extractEmailsFromAddressObjects(headerValue as AddressObject);
  }

  return [];
};

const extractEmailsFromHeaderLines = (
  parsed: ParsedMail,
  headerKey: string
): string[] => {
  return parsed.headerLines
    .filter((line) => line.key.toLowerCase() === headerKey)
    .flatMap((line) => {
      const separatorIndex = line.line.indexOf(":");
      if (separatorIndex < 0) {
        return [];
      }
      const rawValue = line.line.slice(separatorIndex + 1);
      return extractEmailsFromString(rawValue);
    });
};

export const extractRecipientEmailsByPriority = (parsed: ParsedMail): string[] => {
  const recipients: string[] = [];
  const seen = new Set<string>();

  RECIPIENT_HEADER_PRIORITY.forEach((headerName) => {
    const fromParsedHeader = extractEmailsFromHeaderValue(
      parsed.headers.get(headerName)
    );
    fromParsedHeader.forEach((email) => pushRecipient(recipients, seen, email));

    if (fromParsedHeader.length === 0) {
      const fromRawHeader = extractEmailsFromHeaderLines(parsed, headerName);
      fromRawHeader.forEach((email) => pushRecipient(recipients, seen, email));
    }

    if (headerName === "to" && fromParsedHeader.length === 0 && parsed.to) {
      const toAddressList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
      toAddressList
        .flatMap((addressObject) => extractEmailsFromAddressObjects(addressObject))
        .forEach((email) => pushRecipient(recipients, seen, email));
    }
  });

  return recipients;
};

export const buildOrgCostCenterLabel = (
  organizationId: string,
  costCenterId: string
): string => `${organizationId}/${costCenterId}`;

export const analyzeRoutingFromRecipients = (
  recipients: string[],
  aliasBaseAddress: string,
  expectedOrganizationId: string
): RoutingAnalysis => {
  const baseAddress = parseEmailAddress(aliasBaseAddress);
  if (!baseAddress) {
    return { status: "no-match" };
  }

  const expectedOrgIdLower = expectedOrganizationId.toLowerCase();
  const baseDomainLower = baseAddress.domain.toLowerCase();
  const baseLocalLower = baseAddress.local.toLowerCase();
  const matchedRecipients: string[] = [];
  const costCenterIds = new Set<string>();
  const invalidRecipients: string[] = [];

  recipients.forEach((recipient) => {
    const parsedRecipient = parseEmailAddress(recipient);
    if (!parsedRecipient) {
      return;
    }

    if (parsedRecipient.domain.toLowerCase() !== baseDomainLower) {
      return;
    }

    const plusIndex = parsedRecipient.local.indexOf("+");
    if (plusIndex <= 0) {
      return;
    }

    const localPrefix = parsedRecipient.local.slice(0, plusIndex).toLowerCase();
    if (localPrefix !== baseLocalLower) {
      return;
    }

    const suffix = parsedRecipient.local.slice(plusIndex + 1);
    const tokens = suffix.split("+");

    if (tokens.length === 0) {
      return;
    }

    const [organizationToken, costCenterToken] = tokens;
    if (!organizationToken) {
      return;
    }

    if (organizationToken.toLowerCase() !== expectedOrgIdLower) {
      return;
    }

    if (tokens.length !== 2 || !costCenterToken) {
      invalidRecipients.push(recipient);
      return;
    }

    matchedRecipients.push(recipient);
    costCenterIds.add(costCenterToken);
  });

  if (costCenterIds.size === 0) {
    if (invalidRecipients.length > 0) {
      return { status: "invalid-alias", recipients: invalidRecipients };
    }
    return { status: "no-match" };
  }

  if (costCenterIds.size > 1) {
    return {
      status: "ambiguous",
      recipients: matchedRecipients,
      costCenterIds: Array.from(costCenterIds).sort(),
    };
  }

  const [costCenterId] = Array.from(costCenterIds);
  return {
    status: "match",
    recipient: matchedRecipients[0],
    costCenterId,
    labelName: buildOrgCostCenterLabel(expectedOrganizationId, costCenterId),
  };
};

const openBoxAsync = (
  imap: Imap,
  mailboxName: string,
  readOnly: boolean
): Promise<void> =>
  new Promise((resolve, reject) => {
    imap.openBox(mailboxName, readOnly, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const searchAsync = (imap: Imap, criteria: unknown[]): Promise<number[]> =>
  new Promise((resolve, reject) => {
    imap.search(criteria, (error: Error | null, results: number[]) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(results);
    });
  });

const moveAsync = (imap: Imap, uid: number, mailboxName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    imap.move(uid, mailboxName, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const getBoxesAsync = (imap: Imap): Promise<Imap.MailBoxes> =>
  new Promise((resolve, reject) => {
    imap.getBoxes((error: Error | null, boxes: Imap.MailBoxes) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(boxes);
    });
  });

const addBoxAsync = (imap: Imap, mailboxName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    imap.addBox(mailboxName, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const fetchParsedMessages = async (
  imap: Imap,
  messageUids: number[],
  sourceName: string
): Promise<ParsedMessage[]> => {
  if (messageUids.length === 0) {
    return [];
  }

  return new Promise((resolve, reject) => {
    const parsedMessages: ParsedMessage[] = [];
    const messageTasks: Promise<void>[] = [];

    const fetchRequest = imap.fetch(messageUids, { bodies: "", struct: true });

    fetchRequest.on("message", (message) => {
      const task = new Promise<void>((resolveMessage) => {
        let uid: number | null = null;
        let parsePromise: Promise<ParsedMail> | null = null;

        message.on("attributes", (attributes: Imap.ImapMessageAttributes) => {
          uid = attributes.uid;
        });

        message.on("body", (stream) => {
          parsePromise = simpleParser(Readable.from(stream));
        });

        message.once("end", async () => {
          if (!parsePromise) {
            logger.warn(`[${sourceName}] Message was fetched without body stream`);
            resolveMessage();
            return;
          }

          try {
            const parsed = await parsePromise;
            if (!uid) {
              logger.warn(`[${sourceName}] Message was fetched without UID`);
              resolveMessage();
              return;
            }
            parsedMessages.push({ uid, parsed });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            logger.error(`[${sourceName}] Error parsing email: ${errorMessage}`);
          }

          resolveMessage();
        });
      });

      messageTasks.push(task);
    });

    fetchRequest.once("error", (error: Error) => {
      reject(error);
    });

    fetchRequest.once("end", async () => {
      await Promise.all(messageTasks);
      resolve(parsedMessages);
    });
  });
};

const collectMailboxEntries = (
  boxes: Imap.MailBoxes,
  parentPath = "",
  parentDelimiter = MAILBOX_DELIMITER
): MailboxEntry[] => {
  const entries: MailboxEntry[] = [];

  Object.entries(boxes).forEach(([name, folder]) => {
    const delimiter = folder.delimiter || parentDelimiter || MAILBOX_DELIMITER;
    const fullName = parentPath ? `${parentPath}${delimiter}${name}` : name;
    const selectable = !folder.attribs.includes("NOSELECT");

    entries.push({ name: fullName, selectable });

    const childBoxes = folder.children;
    if (childBoxes && Object.keys(childBoxes).length > 0) {
      entries.push(...collectMailboxEntries(childBoxes, fullName, delimiter));
    }
  });

  return entries;
};

const listMailboxEntries = async (imap: Imap): Promise<MailboxEntry[]> => {
  const boxes = await getBoxesAsync(imap);
  return collectMailboxEntries(boxes);
};

const isMailboxExistsError = (error: unknown): boolean => {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("exists") || message.includes("already");
};

const ensureMailboxExists = async (
  imap: Imap,
  mailboxName: string,
  knownMailboxes: Set<string>,
  createLabelsIfMissing: boolean,
  sourceName: string
) => {
  if (knownMailboxes.has(mailboxName)) {
    return;
  }

  if (!createLabelsIfMissing) {
    throw new Error(`Mailbox '${mailboxName}' does not exist and auto-create is disabled`);
  }

  const segments = mailboxName.split(MAILBOX_DELIMITER).filter(Boolean);
  let currentPath = "";

  for (const segment of segments) {
    currentPath = currentPath
      ? `${currentPath}${MAILBOX_DELIMITER}${segment}`
      : segment;

    if (knownMailboxes.has(currentPath)) {
      continue;
    }

    try {
      await addBoxAsync(imap, currentPath);
      logger.info(`[${sourceName}] Created Gmail label '${currentPath}'`);
    } catch (error) {
      if (!isMailboxExistsError(error)) {
        throw error;
      }
    }

    knownMailboxes.add(currentPath);
  }
};

export const buildSearchCriteria = (
  source: Pick<GmailSourceConfig, "subjectFilter">,
  fromDate: DayjsInstance
): unknown[] => [
  ["SUBJECT", source.subjectFilter],
  ["SINCE", fromDate.format("MMMM DD, YYYY")],
];

const getEffectiveAliasBaseAddress = (source: GmailSourceConfig): string =>
  source.aliasBaseAddress || source.username;

const resolveMetricType = (source: GmailSourceConfig): string => {
  const mapping = source.metricTypeMappings.find((item) => item.importName === "Umsatz");
  if (source.mergeMetricTypes.enabled) {
    return source.mergeMetricTypes.name;
  }
  return mapping ? mapping.jobdoneName : "Umsatz";
};

export const extractMetricsFromParsedMail = (
  parsedMail: ParsedMail,
  source: GmailSourceConfig,
  timeZone: string,
  costCenterId: string
): MetricImport[] => {
  const metrics: MetricImport[] = [];

  if (!parsedMail.attachments || parsedMail.attachments.length === 0) {
    return metrics;
  }

  for (const attachment of parsedMail.attachments) {
    const filename = attachment.filename || "";
    if (!new RegExp(source.attachmentNamePattern).test(filename)) {
      continue;
    }

    try {
      const dateMatch = new RegExp(source.dateExtractionRegex).exec(filename);
      if (!dateMatch || !dateMatch[1]) {
        logger.warn(
          `[${source.name}] Could not extract date from filename: ${filename}`
        );
        continue;
      }

      const extractedDate = dateMatch[1];
      const formattedDate = dayjs(extractedDate, source.dateFormat).format("YYYY-MM-DD");
      const csvContent = attachment.content.toString("utf-8");
      const records = parse(csvContent, {
        skip_empty_lines: true,
        trim: true,
      }) as string[][];

      const startIndex = source.skipHeader ? 1 : 0;
      const valueRowIndex = source.valueCell.row - startIndex;
      const valueColumnIndex = source.valueCell.column - 1;

      if (valueRowIndex < 0 || valueColumnIndex < 0) {
        logger.warn(
          `[${source.name}] Invalid valueCell configuration row=${source.valueCell.row} column=${source.valueCell.column}`
        );
        continue;
      }

      if (
        records.length <= valueRowIndex ||
        records[valueRowIndex].length <= valueColumnIndex
      ) {
        logger.warn(
          `[${source.name}] CSV structure does not match expected valueCell position`
        );
        continue;
      }

      const value = records[valueRowIndex][valueColumnIndex];
      if (!value) {
        logger.warn(`[${source.name}] Extracted empty value from attachment ${filename}`);
        continue;
      }

      metrics.push({
        timestampCompatibleWithGranularity: dayjs
          .tz(formattedDate, timeZone)
          .utc()
          .toISOString(),
        costCenter: costCenterId,
        metricType: resolveMetricType(source),
        value: value.toString(),
        metricTypeCategory: source.metricTypeCategory || "Ist",
      });

      logger.info(
        `[${source.name}] Extracted metric for ${costCenterId}: ${value} on ${formattedDate}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[${source.name}] Error processing attachment: ${errorMessage}`);
    }
  }

  return metrics;
};

const routeInboxMessages = async (
  imap: Imap,
  source: GmailSourceConfig,
  fromDate: DayjsInstance,
  organizationId: string,
  knownMailboxes: Set<string>
) => {
  await openBoxAsync(imap, "INBOX", false);
  const searchResults = await searchAsync(imap, buildSearchCriteria(source, fromDate));

  if (searchResults.length === 0) {
    logger.info(`[${source.name}] No matching emails found in INBOX for routing`);
    return;
  }

  logger.info(
    `[${source.name}] Found ${searchResults.length} candidate emails in INBOX for routing`
  );

  const parsedMessages = await fetchParsedMessages(imap, searchResults, source.name);
  const aliasBaseAddress = getEffectiveAliasBaseAddress(source);
  const createLabelsIfMissing = source.createLabelsIfMissing !== false;

  let movedCount = 0;

  for (const message of parsedMessages) {
    const recipients = extractRecipientEmailsByPriority(message.parsed);
    const routing = analyzeRoutingFromRecipients(
      recipients,
      aliasBaseAddress,
      organizationId
    );

    if (routing.status === "no-match") {
      continue;
    }

    if (routing.status === "invalid-alias") {
      logger.warn(
        `[${source.name}] Skipping UID ${message.uid}. Invalid alias for org '${organizationId}': ${routing.recipients.join(
          ", "
        )}`
      );
      continue;
    }

    if (routing.status === "ambiguous") {
      logger.warn(
        `[${source.name}] Skipping UID ${message.uid}. Ambiguous aliases for org '${organizationId}': costCenterIds=${routing.costCenterIds.join(
          ", "
        )} recipients=${routing.recipients.join(", ")}`
      );
      continue;
    }

    try {
      await ensureMailboxExists(
        imap,
        routing.labelName,
        knownMailboxes,
        createLabelsIfMissing,
        source.name
      );
      await moveAsync(imap, message.uid, routing.labelName);
      movedCount++;
      logger.info(
        `[${source.name}] Routed UID ${message.uid} to '${routing.labelName}' from recipient '${routing.recipient}'`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        `[${source.name}] Failed to route UID ${message.uid} to '${routing.labelName}': ${errorMessage}`
      );
    }
  }

  logger.info(`[${source.name}] Routed ${movedCount} emails from INBOX`);
};

const listOrganizationCostCenterLabels = async (
  imap: Imap,
  organizationId: string
): Promise<string[]> => {
  const allEntries = await listMailboxEntries(imap);
  const prefix = `${organizationId}${MAILBOX_DELIMITER}`;

  return allEntries
    .filter((entry) => entry.selectable && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
};

const processOrganizationLabels = async (
  imap: Imap,
  source: GmailSourceConfig,
  fromDate: DayjsInstance,
  organizationId: string,
  timeZone: string
): Promise<MetricImport[]> => {
  const labels = await listOrganizationCostCenterLabels(imap, organizationId);
  if (labels.length === 0) {
    logger.info(
      `[${source.name}] No organization labels found for prefix '${organizationId}/'`
    );
    return [];
  }

  logger.info(
    `[${source.name}] Processing ${labels.length} organization cost center labels`
  );

  const aliasBaseAddress = getEffectiveAliasBaseAddress(source);
  const metrics: MetricImport[] = [];

  for (const labelName of labels) {
    await openBoxAsync(imap, labelName, true);
    const searchResults = await searchAsync(imap, buildSearchCriteria(source, fromDate));

    if (searchResults.length === 0) {
      logger.info(`[${source.name}] No matching emails found in label '${labelName}'`);
      continue;
    }

    logger.info(
      `[${source.name}] Found ${searchResults.length} emails in label '${labelName}'`
    );

    const parsedMessages = await fetchParsedMessages(imap, searchResults, source.name);
    for (const message of parsedMessages) {
      const recipients = extractRecipientEmailsByPriority(message.parsed);
      const routing = analyzeRoutingFromRecipients(
        recipients,
        aliasBaseAddress,
        organizationId
      );

      if (routing.status === "no-match") {
        logger.warn(
          `[${source.name}] Skipping UID ${message.uid} in '${labelName}'. No matching org alias found`
        );
        continue;
      }

      if (routing.status === "invalid-alias") {
        logger.warn(
          `[${source.name}] Skipping UID ${message.uid} in '${labelName}'. Invalid alias for org '${organizationId}': ${routing.recipients.join(
            ", "
          )}`
        );
        continue;
      }

      if (routing.status === "ambiguous") {
        logger.warn(
          `[${source.name}] Skipping UID ${message.uid} in '${labelName}'. Ambiguous aliases for org '${organizationId}': costCenterIds=${routing.costCenterIds.join(
            ", "
          )} recipients=${routing.recipients.join(", ")}`
        );
        continue;
      }

      const extractedMetrics = extractMetricsFromParsedMail(
        message.parsed,
        source,
        timeZone,
        routing.costCenterId
      );
      metrics.push(...extractedMetrics);
    }
  }

  return metrics;
};

export const importFromGmail = async (
  source: GmailSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  logger.info(`[${source.name}] Starting Gmail import...`);

  try {
    const organizationId = appEnvironment.organization.id;
    if (!organizationId) {
      throw new Error("JOBDONE_ORGANIZATION_ID is required for Gmail routing");
    }

    if (source.orgIdSource && source.orgIdSource !== "env") {
      throw new Error(`Unsupported orgIdSource '${source.orgIdSource}'`);
    }

    const fromDate = dayjs().subtract(source.daysPast, "day").startOf("day");
    logger.info(
      `[${source.name}] Fetching Gmail emails from ${fromDate.format("YYYY-MM-DD")}`
    );

    const imap = new Imap({
      user: source.username,
      password: source.password,
      host: source.host || "imap.gmail.com",
      port: source.port ?? 993,
      tls: source.secure ?? true,
      tlsOptions: { rejectUnauthorized: false },
    });

    const metricsToImport = await new Promise<MetricImport[]>((resolve, reject) => {
      imap.once("ready", async () => {
        try {
          const knownMailboxes = new Set<string>(
            (await listMailboxEntries(imap)).map((entry) => entry.name)
          );

          await routeInboxMessages(
            imap,
            source,
            fromDate,
            organizationId,
            knownMailboxes
          );

          const metrics = await processOrganizationLabels(
            imap,
            source,
            fromDate,
            organizationId,
            timeZone
          );

          resolve(metrics);
        } catch (error) {
          reject(error);
        } finally {
          imap.end();
        }
      });

      imap.once("error", (error: Error) => {
        logger.error(`[${source.name}] IMAP connection error: ${error.message}`);
        reject(error);
      });

      imap.once("end", () => {
        logger.info(`[${source.name}] IMAP connection ended`);
      });

      imap.connect();
    });

    logger.info(
      `[${source.name}] Successfully imported ${metricsToImport.length} metrics from Gmail`
    );
    return metricsToImport;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = `[${source.name}] Error importing from Gmail: ${errorMessage}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
    throw error;
  }
};
