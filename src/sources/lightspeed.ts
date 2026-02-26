import type { MetricImport } from "../index";
import logger from "../helper/logger";
import dayjs from "../helper/customDayJs";
import { sendMessageToDiscord } from "../helper/discord";
import type {
  LightspeedSourceConfig,
  LightspeedMetricOutput,
  LightspeedRevenueOutput,
  LightspeedTransactionsOutput,
  LightspeedLaborHoursOutput,
  LightspeedCoversOutput,
  LightspeedAuthVersion,
  LightspeedSalesFetchMode,
} from "../config";
import fs from "fs/promises";
import path from "path";

type Json = Record<string, any>;

interface LightspeedTokenCache {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: string; // ISO
  obtained_at?: string; // ISO
  token_type?: string;
  scope?: string;
}

interface BusinessLocationInfo {
  id: number;
  name?: string;
  businessId?: number;
  businessName?: string;
}

interface LightspeedSale {
  timeClosed?: string;
  timeOfOpening?: string;
  cancelled?: boolean;
  type?: string;
  nbCovers?: number;
  salesLines?: LightspeedSaleLine[];
}

interface LightspeedSaleLine {
  totalNetAmountWithTax?: string;
  totalNetAmountWithoutTax?: string;
  taxAmount?: string;
  taxLines?: Array<{ taxIncluded?: boolean }>;
  serviceCharge?: string;
  voidReason?: string;
}

interface SalesExportDto {
  sales: LightspeedSale[];
  nextPageToken?: string;
}

interface SalesDailyExportDto {
  sales: LightspeedSale[];
  nextStartOfDayAsIso8601?: string;
  dataComplete?: boolean;
}

interface ShiftEvent {
  eventType?: string; // CLOCK_IN / CLOCK_OUT / etc
  timestamp?: string; // ISO
}

interface ShiftDto {
  shiftId?: string;
  userId?: number;
  businessLocationId?: number;
  startTime?: string; // ISO
  endTime?: string; // ISO
  shiftEvents?: ShiftEvent[];
}

interface ShiftsResponse {
  data: ShiftDto[];
  meta?: {
    page?: number;
    size?: number;
    totalPages?: number;
    totalElements?: number;
  };
}

const DEFAULT_SCOPES = ["financial-api", "staff-api"];
const DEFAULT_SALES_FETCH_MODE: LightspeedSalesFetchMode = "daily";
const DEFAULT_PAGE_SIZE = 200;
const TOKEN_EXPIRY_SAFETY_SECONDS = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sanitizeFilePart = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const parseAmount = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

const roundTo = (value: number, decimals: number) => {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const fetchWithRetry = async (
  sourceName: string,
  url: string,
  init: RequestInit,
  maxRetries = 5
): Promise<Response> => {
  let attempt = 0;

  while (true) {
    try {
      const resp = await fetch(url, init);

      // Retry on rate limit and transient server errors
      if (
        (resp.status === 429 || (resp.status >= 500 && resp.status <= 599)) &&
        attempt < maxRetries
      ) {
        const retryAfterHeader = resp.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader
          ? Number.parseInt(retryAfterHeader, 10)
          : NaN;

        const backoffMs = Number.isFinite(retryAfterSeconds)
          ? Math.max(1, retryAfterSeconds) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 15000);

        logger.warn(
          `[${sourceName}] HTTP ${resp.status} for ${url}. Retrying in ${backoffMs}ms (attempt ${
            attempt + 1
          }/${maxRetries})...`
        );
        await sleep(backoffMs);
        attempt++;
        continue;
      }

      return resp;
    } catch (err: any) {
      if (attempt >= maxRetries) throw err;

      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 15000);
      logger.warn(
        `[${sourceName}] Fetch error for ${url}: ${String(err?.message ?? err).slice(
          0,
          400
        )}. Retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})...`
      );
      await sleep(backoffMs);
      attempt++;
    }
  }
};

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
};

const writeJsonFile = async (filePath: string, payload: unknown) => {
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
};

const isTokenValid = (token: LightspeedTokenCache | null): boolean => {
  if (!token?.access_token) return false;
  if (!token.expires_at) return false;

  const expiresAt = dayjs(token.expires_at);
  if (!expiresAt.isValid()) return false;

  return expiresAt.isAfter(dayjs().add(TOKEN_EXPIRY_SAFETY_SECONDS, "second"));
};

const inferAuthVersion = (config: LightspeedSourceConfig): LightspeedAuthVersion => {
  if (config.authVersion) return config.authVersion;
  // Common convention: new client IDs start with "devp-v2"
  if (config.clientId?.startsWith("devp-v2")) return "v2";
  return "v1";
};

const resolveApiBaseUrl = (config: LightspeedSourceConfig): string => {
  if (config.apiBaseUrl) return config.apiBaseUrl.replace(/\/+$/, "");
  return config.environment === "demo"
    ? "https://api.trial.lsk.lightspeed.app"
    : "https://api.lsk.lightspeed.app";
};

const resolveAuthBaseUrl = (config: LightspeedSourceConfig): string => {
  if (config.authBaseUrl) return config.authBaseUrl.replace(/\/+$/, "");
  // Default Keycloak hosts for v2; can be overridden via authBaseUrl
  return config.environment === "demo"
    ? "https://auth.lsk-demo.app"
    : "https://auth.lsk.lightspeed.app";
};

const getTokenCachePath = (config: LightspeedSourceConfig): string => {
  if (config.tokenCachePath) return path.resolve(process.cwd(), config.tokenCachePath);

  const safeName = sanitizeFilePart(config.name);
  const safeEnv = sanitizeFilePart(config.environment);
  return path.resolve(process.cwd(), `.lightspeed-token-${safeName}-${safeEnv}.json`);
};

const buildAuthorizationUrlForLogging = (config: LightspeedSourceConfig): string => {
  const authVersion = inferAuthVersion(config);
  const apiBaseUrl = resolveApiBaseUrl(config);

  const scopes = (config.scopes?.length ? config.scopes : DEFAULT_SCOPES).slice();

  const url =
    authVersion === "v2"
      ? `${resolveAuthBaseUrl(config)}/realms/k-series/protocol/openid-connect/auth`
      : `${apiBaseUrl}/oauth/authorize`;

  const qp = new URL(url);
  qp.searchParams.set("client_id", config.clientId);
  qp.searchParams.set("response_type", "code");
  qp.searchParams.set("redirect_uri", config.redirectUri);

  if (authVersion === "v2") {
    // Ensure refresh token issuance (offline_access) for OIDC clients
    const scope = ["openid", "offline_access", ...scopes].join(" ");
    qp.searchParams.set("scope", scope);
  } else {
    qp.searchParams.set("scope", scopes.join(" "));
  }

  // Optional but helpful
  qp.searchParams.set("state", `jobdone-${Date.now()}`);

  return qp.toString();
};

const requestToken = async (
  sourceName: string,
  tokenUrl: string,
  bodyParams: Record<string, string>
): Promise<LightspeedTokenCache> => {
  const body = new URLSearchParams(bodyParams);

  const resp = await fetchWithRetry(sourceName, tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? (JSON.parse(text) as any) : null;
  } catch {
    // ignore JSON parse error
  }

  if (!resp.ok) {
    const details =
      (json && (json.error_description || json.error || json.message)) ||
      text?.slice(0, 1000) ||
      resp.statusText;

    throw new Error(
      `[${sourceName}] OAuth token request failed (${resp.status}): ${details}`
    );
  }

  const accessToken = json?.access_token;
  if (!accessToken) {
    throw new Error(
      `[${sourceName}] OAuth token response did not include access_token`
    );
  }

  const expiresIn = Number(json?.expires_in ?? 0);
  const obtainedAt = dayjs();
  const expiresAt = expiresIn
    ? obtainedAt.add(expiresIn, "second").subtract(30, "second").toISOString()
    : obtainedAt.add(50, "minute").toISOString(); // fallback

  const cache: LightspeedTokenCache = {
    access_token: accessToken,
    refresh_token: json?.refresh_token,
    expires_in: expiresIn || undefined,
    obtained_at: obtainedAt.toISOString(),
    expires_at: expiresAt,
    token_type: json?.token_type,
    scope: json?.scope,
  };

  return cache;
};

const acquireAccessToken = async (
  config: LightspeedSourceConfig,
  opts?: { forceRefresh?: boolean }
): Promise<{ accessToken: string }> => {
  const tokenCachePath = getTokenCachePath(config);
  const authVersion = inferAuthVersion(config);

  const apiBaseUrl = resolveApiBaseUrl(config);
  const tokenUrl =
    authVersion === "v2"
      ? `${resolveAuthBaseUrl(config)}/realms/k-series/protocol/openid-connect/token`
      : `${apiBaseUrl}/oauth/token`;

  const cached = await readJsonFile<LightspeedTokenCache>(tokenCachePath);

  if (!opts?.forceRefresh && isTokenValid(cached)) {
    return { accessToken: cached!.access_token };
  }

  const refreshToken = cached?.refresh_token || config.refreshToken;
  const authCode = config.authorizationCode;

  let newToken: LightspeedTokenCache;

  if (refreshToken) {
    logger.info(`[${config.name}] Refreshing Lightspeed access token...`);
    newToken = await requestToken(config.name, tokenUrl, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
  } else if (authCode) {
    logger.info(`[${config.name}] Exchanging authorization code for tokens...`);
    newToken = await requestToken(config.name, tokenUrl, {
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
  } else {
    const authUrl = buildAuthorizationUrlForLogging(config);
    throw new Error(
      `[${config.name}] Missing Lightspeed refreshToken/authorizationCode. ` +
        `Provide a refreshToken (preferred) or a one-time authorizationCode. ` +
        `Authorization URL (for generating a code): ${authUrl}`
    );
  }

  // Persist token cache (refresh token may rotate)
  try {
    await writeJsonFile(tokenCachePath, newToken);
    logger.info(`[${config.name}] Updated Lightspeed token cache at ${tokenCachePath}`);
  } catch (err: any) {
    logger.warn(
      `[${config.name}] Failed to write token cache to ${tokenCachePath}: ${String(
        err?.message ?? err
      ).slice(0, 300)}`
    );
  }

  return { accessToken: newToken.access_token };
};

const authedGetJson = async <T>(
  config: LightspeedSourceConfig,
  url: string,
  opts?: { retryOn401?: boolean }
): Promise<T> => {
  const { accessToken } = await acquireAccessToken(config);

  const resp = await fetchWithRetry(config.name, url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (resp.status === 401 && (opts?.retryOn401 ?? true)) {
    logger.warn(`[${config.name}] Received 401 from Lightspeed, forcing token refresh and retry...`);
    const refreshed = await acquireAccessToken(config, { forceRefresh: true });
    const retryResp = await fetchWithRetry(config.name, url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${refreshed.accessToken}`,
        Accept: "application/json",
      },
    });

    if (!retryResp.ok) {
      const body = (await retryResp.text()).slice(0, 1200);
      throw new Error(
        `[${config.name}] Lightspeed GET failed after refresh (${retryResp.status}): ${body}`
      );
    }

    return (await retryResp.json()) as T;
  }

  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 1200);
    throw new Error(`[${config.name}] Lightspeed GET failed (${resp.status}): ${body}`);
  }

  return (await resp.json()) as T;
};

const resolveBusinessLocations = async (
  config: LightspeedSourceConfig
): Promise<BusinessLocationInfo[]> => {
  const apiBaseUrl = resolveApiBaseUrl(config);

  let locations: BusinessLocationInfo[] = [];

  try {
    const url = `${apiBaseUrl}/f/data/businesses`;
    const businesses = await authedGetJson<any>(config, url);

    // Expected shape: Array<{ id, name, businessLocations: Array<{id,name}> }>
    const businessList: any[] = Array.isArray(businesses)
      ? businesses
      : Array.isArray(businesses?.data)
      ? businesses.data
      : [];

    const parsed: BusinessLocationInfo[] = [];
    for (const b of businessList) {
      const businessId = typeof b?.id === "number" ? b.id : undefined;
      const businessName = typeof b?.name === "string" ? b.name : undefined;

      const bl = b?.businessLocations;
      const businessLocations: any[] = Array.isArray(bl)
        ? bl
        : Array.isArray(b?.businesslocations)
        ? b.businesslocations
        : [];

      for (const loc of businessLocations) {
        const id = typeof loc?.id === "number" ? loc.id : Number(loc?.id);
        if (!Number.isFinite(id)) continue;

        parsed.push({
          id,
          name: typeof loc?.name === "string" ? loc.name : undefined,
          businessId,
          businessName,
        });
      }
    }

    locations = parsed;
    logger.info(`[${config.name}] Discovered ${locations.length} business locations via /f/data/businesses`);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    logger.warn(
      `[${config.name}] Failed to fetch business locations via /f/data/businesses: ${msg.slice(
        0,
        600
      )}`
    );

    // Fallback: if explicit IDs are configured, proceed with those (names unknown)
    if (config.businessLocationIds?.length) {
      locations = config.businessLocationIds.map((id) => ({ id }));
    } else {
      throw err;
    }
  }

  if (config.businessLocationIds?.length) {
    const wanted = new Set(config.businessLocationIds.map((n) => Number(n)));
    locations = locations.filter((l) => wanted.has(Number(l.id)));
  }

  if (!locations.length) {
    throw new Error(
      `[${config.name}] No business locations resolved. Provide businessLocationIds or ensure the token can access /f/data/businesses.`
    );
  }

  return locations;
};

const resolveCostCenter = (
  config: LightspeedSourceConfig,
  location: BusinessLocationInfo
): string => {
  const idStr = String(location.id);

  // Explicit mapping wins
  const mapped = config.costCenterByBusinessLocationId?.[idStr];
  if (mapped) return mapped;

  const from = config.costCenterFrom ?? "name";
  if (from === "id") return idStr;

  // from === "name"
  if (location.name) return location.name;

  // Fallback
  return idStr;
};

const getMappedMetricTypeName = (config: LightspeedSourceConfig, raw: string): string => {
  const mapping = config.metricTypeMappings.find((m) => m.importName === raw);
  return mapping ? mapping.jobdoneName : raw;
};

const getEffectiveMetricTypeName = (config: LightspeedSourceConfig, output: LightspeedMetricOutput): string => {
  if (config.mergeMetricTypes.enabled) return config.mergeMetricTypes.name;
  return getMappedMetricTypeName(config, output.metricType);
};

const getEffectiveMetricCategory = (config: LightspeedSourceConfig, output: LightspeedMetricOutput): string => {
  return output.metricTypeCategory || config.metricTypeCategory || "Ist";
};

const buildDateStringsRange = (timeZone: string, daysPast: number, daysFuture: number): string[] => {
  const start = dayjs().subtract(daysPast, "day").tz(timeZone).startOf("day");
  const end = dayjs().add(daysFuture, "day").tz(timeZone).startOf("day");

  const out: string[] = [];
  let cursor = start;

  while (cursor.isSameOrBefore(end, "day")) {
    out.push(cursor.format("YYYY-MM-DD"));
    cursor = cursor.add(1, "day");
  }

  return out;
};

const computeRevenueForSales = (
  sales: LightspeedSale[],
  output: LightspeedRevenueOutput
): number => {
  const allowedTypes = output.saleTypesToInclude?.length
    ? new Set(output.saleTypesToInclude)
    : new Set(["SALE", "REFUND"]);

  const includeVoidedLines = output.includeVoidedLines ?? false;
  const includeServiceCharge = output.includeServiceCharge ?? false;

  let sum = 0;

  for (const sale of sales) {
    if (sale?.cancelled) continue;

    const saleType = (sale?.type ?? "SALE").toString();
    if (!allowedTypes.has(saleType as any)) continue;

    const lines = Array.isArray(sale?.salesLines) ? sale.salesLines : [];

    for (const line of lines) {
      if (!includeVoidedLines && line?.voidReason) continue;

      const netWithoutTax = parseAmount(line?.totalNetAmountWithoutTax);

      if (output.revenueType === "net") {
        sum += netWithoutTax;
        if (includeServiceCharge) sum += parseAmount(line?.serviceCharge);
        continue;
      }

      // gross
      const taxIncluded = Array.isArray(line?.taxLines)
        ? line.taxLines.some((t) => t?.taxIncluded === true)
        : false;

      if (taxIncluded) {
        sum += parseAmount(line?.totalNetAmountWithTax);
        if (includeServiceCharge) sum += parseAmount(line?.serviceCharge);
      } else {
        const taxAmount = parseAmount(line?.taxAmount);
        sum += netWithoutTax + taxAmount;
        if (includeServiceCharge) sum += parseAmount(line?.serviceCharge);
      }
    }
  }

  return sum;
};

const computeCoversForSales = (sales: LightspeedSale[], _output: LightspeedCoversOutput): number => {
  // Default approach: sum nbCovers for non-cancelled SALE receipts.
  let covers = 0;
  for (const sale of sales) {
    if (sale?.cancelled) continue;
    const saleType = (sale?.type ?? "SALE").toString();
    if (saleType !== "SALE") continue;
    covers += parseAmount(sale?.nbCovers);
  }
  return covers;
};

const computeTransactionsForSales = (
  sales: LightspeedSale[],
  output: LightspeedTransactionsOutput
): number => {
  const allowedTypes = output.saleTypesToInclude?.length
    ? new Set(output.saleTypesToInclude)
    : new Set(["SALE"]);

  let count = 0;
  for (const sale of sales) {
    if (sale?.cancelled) continue;
    const saleType = (sale?.type ?? "SALE").toString();
    if (!allowedTypes.has(saleType as any)) continue;
    count++;
  }
  return count;
};

const fetchSalesDaily = async (
  config: LightspeedSourceConfig,
  businessLocationId: number,
  date: string
): Promise<SalesDailyExportDto> => {
  const apiBaseUrl = resolveApiBaseUrl(config);
  const url = new URL(`${apiBaseUrl}/f/v2/business-location/${businessLocationId}/sales-daily`);
  url.searchParams.set("date", date);

  return authedGetJson<SalesDailyExportDto>(config, url.toString());
};

const fetchSalesRangeAggregates = async (
  config: LightspeedSourceConfig,
  businessLocationId: number,
  timeZone: string,
  outputs: LightspeedMetricOutput[]
): Promise<Map<string, Map<string, number>>> => {
  const apiBaseUrl = resolveApiBaseUrl(config);
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;

  const from = dayjs().subtract(config.daysPast, "day").tz(timeZone).startOf("day").utc().toISOString();
  const to = dayjs().add(config.daysFuture, "day").tz(timeZone).endOf("day").utc().toISOString();

  // outputKey -> (date -> value)
  const values = new Map<string, Map<string, number>>();

  const makeKey = (o: LightspeedMetricOutput) =>
    `${o.kind}::${o.metricType}::${o.metricTypeCategory ?? ""}`;

  outputs.forEach((o) => {
    values.set(makeKey(o), new Map<string, number>());
  });

  const addValue = (outputKey: string, dateKey: string, delta: number) => {
    const m = values.get(outputKey)!;
    m.set(dateKey, (m.get(dateKey) ?? 0) + delta);
  };

  const outputsRevenue = outputs.filter((o) => o.enabled && o.kind === "revenue") as LightspeedRevenueOutput[];
  const outputsCovers = outputs.filter((o) => o.enabled && o.kind === "covers") as LightspeedCoversOutput[];
  const outputsTx = outputs.filter((o) => o.enabled && o.kind === "transactions") as LightspeedTransactionsOutput[];

  let nextPageToken: string | undefined = undefined;

  while (true) {
    const url = new URL(`${apiBaseUrl}/f/v2/business-location/${businessLocationId}/sales`);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("pageSize", String(pageSize));
    if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);

    const page = await authedGetJson<SalesExportDto>(config, url.toString());
    const sales = Array.isArray(page?.sales) ? page.sales : [];

    for (const sale of sales) {
      // group by calendar date in configured timeZone
      const ts = sale?.timeClosed || sale?.timeOfOpening;
      if (!ts) continue;

      const dateKey = dayjs(ts).tz(timeZone).format("YYYY-MM-DD");

      // Revenue outputs (may have different sale-type/void settings)
      for (const o of outputsRevenue) {
        const outputKey = makeKey(o);

        // Compute revenue contribution for THIS sale only (avoid scanning whole day list)
        const allowedTypes = o.saleTypesToInclude?.length
          ? new Set(o.saleTypesToInclude)
          : new Set(["SALE", "REFUND"]);

        if (sale?.cancelled) continue;
        const saleType = (sale?.type ?? "SALE").toString();
        if (!allowedTypes.has(saleType as any)) continue;

        const includeVoidedLines = o.includeVoidedLines ?? false;
        const includeServiceCharge = o.includeServiceCharge ?? false;

        let delta = 0;
        const lines = Array.isArray(sale?.salesLines) ? sale.salesLines : [];
        for (const line of lines) {
          if (!includeVoidedLines && line?.voidReason) continue;

          const netWithoutTax = parseAmount(line?.totalNetAmountWithoutTax);

          if (o.revenueType === "net") {
            delta += netWithoutTax;
            if (includeServiceCharge) delta += parseAmount(line?.serviceCharge);
            continue;
          }

          const taxIncluded = Array.isArray(line?.taxLines)
            ? line.taxLines.some((t) => t?.taxIncluded === true)
            : false;

          if (taxIncluded) {
            delta += parseAmount(line?.totalNetAmountWithTax);
            if (includeServiceCharge) delta += parseAmount(line?.serviceCharge);
          } else {
            delta += netWithoutTax + parseAmount(line?.taxAmount);
            if (includeServiceCharge) delta += parseAmount(line?.serviceCharge);
          }
        }

        if (delta !== 0) addValue(outputKey, dateKey, delta);
      }

      // Covers outputs
      for (const o of outputsCovers) {
        const outputKey = makeKey(o);
        if (sale?.cancelled) continue;
        const saleType = (sale?.type ?? "SALE").toString();
        if (saleType !== "SALE") continue;
        const delta = parseAmount(sale?.nbCovers);
        if (delta !== 0) addValue(outputKey, dateKey, delta);
      }

      // Transactions outputs
      for (const o of outputsTx) {
        const outputKey = makeKey(o);
        if (sale?.cancelled) continue;

        const allowedTypes = o.saleTypesToInclude?.length
          ? new Set(o.saleTypesToInclude)
          : new Set(["SALE"]);

        const saleType = (sale?.type ?? "SALE").toString();
        if (!allowedTypes.has(saleType as any)) continue;

        addValue(outputKey, dateKey, 1);
      }
    }

    nextPageToken = page?.nextPageToken;
    if (!nextPageToken) break;
  }

  return values;
};

const fetchLaborHoursByDate = async (
  config: LightspeedSourceConfig,
  businessLocationId: number,
  timeZone: string
): Promise<Map<string, number>> => {
  const apiBaseUrl = resolveApiBaseUrl(config);

  // Staff shifts endpoint expects date-time range
  const from = dayjs().subtract(config.daysPast, "day").tz(timeZone).startOf("day").utc().toISOString();
  const to = dayjs().add(config.daysFuture, "day").tz(timeZone).endOf("day").utc().toISOString();

  const size = 100;
  let page = 0;
  let totalPages: number | undefined = undefined;

  const hoursByDate = new Map<string, number>();

  const addHoursSegmented = (startIso: string, endIso: string) => {
    const startLocal = dayjs(startIso).tz(timeZone);
    const endLocal = dayjs(endIso).tz(timeZone);

    if (!startLocal.isValid() || !endLocal.isValid()) return;
    if (!endLocal.isAfter(startLocal)) return;

    let cursor = startLocal;

    while (cursor.isBefore(endLocal)) {
      const dayStart = cursor.startOf("day");
      const nextDayStart = dayStart.add(1, "day");
      const segmentEnd = endLocal.isBefore(nextDayStart) ? endLocal : nextDayStart;

      const hours = segmentEnd.diff(cursor, "millisecond") / 3600000;
      const dateKey = dayStart.format("YYYY-MM-DD");
      hoursByDate.set(dateKey, (hoursByDate.get(dateKey) ?? 0) + hours);

      cursor = segmentEnd;
    }
  };

  while (true) {
    const url = new URL(`${apiBaseUrl}/staff/v1/businessLocations/${businessLocationId}/shifts`);
    url.searchParams.set("startTime", from);
    url.searchParams.set("endTime", to);
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("sortBy", "START_TIME");
    url.searchParams.set("sortDirection", "ASC");

    const resp = await authedGetJson<ShiftsResponse>(config, url.toString());
    const shifts = Array.isArray(resp?.data) ? resp.data : [];

    // Pagination
    totalPages =
      typeof resp?.meta?.totalPages === "number" ? resp.meta.totalPages : totalPages;

    for (const shift of shifts) {
      const events = Array.isArray(shift?.shiftEvents) ? shift.shiftEvents : [];

      // Find newest CLOCK_IN and newest CLOCK_OUT (per Lightspeed guidance)
      const clockIn = events
        .filter((e) => e?.eventType === "CLOCK_IN" && e?.timestamp)
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0]?.timestamp;

      const clockOut = events
        .filter((e) => e?.eventType === "CLOCK_OUT" && e?.timestamp)
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0]?.timestamp;

      // Fallback to shift start/end if events missing
      const startIso = clockIn || shift?.startTime;
      const endIso = clockOut || shift?.endTime;

      if (!startIso || !endIso) continue;

      addHoursSegmented(startIso, endIso);
    }

    page++;

    if (totalPages === undefined) {
      // If meta missing, break when we get less than requested size
      if (shifts.length < size) break;
    } else {
      if (page >= totalPages) break;
    }
  }

  return hoursByDate;
};

export const importFromLightspeed = async (
  config: LightspeedSourceConfig,
  timeZone: string
): Promise<MetricImport[]> => {
  logger.info(`[${config.name}] Starting Lightspeed (K-Series) import...`);

  try {
    const enabledOutputs = (config.outputs ?? []).filter((o) => o.enabled);
    if (!enabledOutputs.length) {
      logger.warn(`[${config.name}] No enabled outputs configured; returning 0 metrics`);
      return [];
    }

    // Resolve locations
    const locations = await resolveBusinessLocations(config);

    const salesFetchMode: LightspeedSalesFetchMode =
      config.salesFetchMode ?? DEFAULT_SALES_FETCH_MODE;

    const wantsFinancial = enabledOutputs.some((o) =>
      ["revenue", "covers", "transactions"].includes(o.kind)
    );
    const wantsLabor = enabledOutputs.some((o) => o.kind === "laborHours");

    const revenueOutputs = enabledOutputs.filter((o) => o.kind === "revenue") as LightspeedRevenueOutput[];
    const coversOutputs = enabledOutputs.filter((o) => o.kind === "covers") as LightspeedCoversOutput[];
    const txOutputs = enabledOutputs.filter((o) => o.kind === "transactions") as LightspeedTransactionsOutput[];
    const laborOutputs = enabledOutputs.filter((o) => o.kind === "laborHours") as LightspeedLaborHoursOutput[];

    const metrics: MetricImport[] = [];

    for (const loc of locations) {
      const businessLocationId = loc.id;
      const costCenter = resolveCostCenter(config, loc);

      logger.info(
        `[${config.name}] Processing businessLocationId=${businessLocationId} costCenter='${costCenter}'`
      );

      // Financial outputs
      if (wantsFinancial) {
        if (salesFetchMode === "daily") {
          const dates = buildDateStringsRange(timeZone, config.daysPast, config.daysFuture);

          for (const date of dates) {
            let daily: SalesDailyExportDto | null = null;

            try {
              daily = await fetchSalesDaily(config, businessLocationId, date);
            } catch (err: any) {
              logger.warn(
                `[${config.name}] Failed to fetch sales-daily for location=${businessLocationId} date=${date}: ${String(
                  err?.message ?? err
                ).slice(0, 500)}`
              );
              continue;
            }

            const sales = Array.isArray(daily?.sales) ? daily!.sales : [];
            const dataComplete = daily?.dataComplete;

            if (config.skipIncompleteDays && dataComplete === false) {
              logger.info(
                `[${config.name}] Skipping incomplete business day (dataComplete=false) for location=${businessLocationId} date=${date}`
              );
              continue;
            }

            if (!sales.length) continue;

            const ts = dayjs.tz(date, timeZone).utc().toISOString();

            // Revenue metrics
            for (const o of revenueOutputs) {
              const metricType = getEffectiveMetricTypeName(config, o);
              const metricTypeCategory = getEffectiveMetricCategory(config, o);
              const value = computeRevenueForSales(sales, o);

              // Skip zeros (align with other sources)
              if (Math.abs(value) < 0.000001) continue;

              metrics.push({
                timestampCompatibleWithGranularity: ts,
                costCenter,
                metricType,
                value: roundTo(value, 2).toFixed(2),
                metricTypeCategory,
              });
            }

            // Covers metrics
            for (const o of coversOutputs) {
              const metricType = getEffectiveMetricTypeName(config, o);
              const metricTypeCategory = getEffectiveMetricCategory(config, o);
              const value = computeCoversForSales(sales, o);

              if (Math.abs(value) < 0.000001) continue;

              metrics.push({
                timestampCompatibleWithGranularity: ts,
                costCenter,
                metricType,
                value: roundTo(value, 2).toFixed(2),
                metricTypeCategory,
              });
            }

            // Transactions metrics
            for (const o of txOutputs) {
              const metricType = getEffectiveMetricTypeName(config, o);
              const metricTypeCategory = getEffectiveMetricCategory(config, o);
              const value = computeTransactionsForSales(sales, o);

              if (!value) continue;

              metrics.push({
                timestampCompatibleWithGranularity: ts,
                costCenter,
                metricType,
                value: value.toString(),
                metricTypeCategory,
              });
            }
          }
        } else {
          // range mode (paged) => aggregate by local calendar date
          const aggregated = await fetchSalesRangeAggregates(
            config,
            businessLocationId,
            timeZone,
            enabledOutputs.filter((o) =>
              ["revenue", "covers", "transactions"].includes(o.kind)
            )
          );

          // Build metrics from outputKey maps
          for (const o of enabledOutputs.filter((o) =>
            ["revenue", "covers", "transactions"].includes(o.kind)
          )) {
            const outputKey = `${o.kind}::${o.metricType}::${o.metricTypeCategory ?? ""}`;
            const byDate = aggregated.get(outputKey);
            if (!byDate) continue;

            for (const [date, value] of byDate.entries()) {
              if (Math.abs(value) < 0.000001) continue;

              const ts = dayjs.tz(date, timeZone).utc().toISOString();
              const metricType = getEffectiveMetricTypeName(config, o);
              const metricTypeCategory = getEffectiveMetricCategory(config, o);

              // Transactions already counted as integers; revenue/covers are numeric.
              const isIntegerLike = o.kind === "transactions";
              metrics.push({
                timestampCompatibleWithGranularity: ts,
                costCenter,
                metricType,
                value: isIntegerLike ? Math.round(value).toString() : roundTo(value, 2).toFixed(2),
                metricTypeCategory,
              });
            }
          }
        }
      }

      // Labor outputs
      if (wantsLabor) {
        const hoursByDate = await fetchLaborHoursByDate(
          config,
          businessLocationId,
          timeZone
        );

        for (const o of laborOutputs) {
          const metricType = getEffectiveMetricTypeName(config, o);
          const metricTypeCategory = getEffectiveMetricCategory(config, o);
          const roundingDecimals = o.roundingDecimals ?? 2;

          for (const [date, hours] of hoursByDate.entries()) {
            if (Math.abs(hours) < 0.000001) continue;

            const ts = dayjs.tz(date, timeZone).utc().toISOString();
            metrics.push({
              timestampCompatibleWithGranularity: ts,
              costCenter,
              metricType,
              value: roundTo(hours, roundingDecimals).toFixed(roundingDecimals),
              metricTypeCategory,
            });
          }
        }
      }
    }

    logger.info(`[${config.name}] Successfully imported ${metrics.length} metrics from Lightspeed`);
    return metrics;
  } catch (error: any) {
    const message = `[${config.name}] Error importing from Lightspeed: ${String(
      error?.message ?? error
    )}`;
    logger.error(message);
    await sendMessageToDiscord({ message });
    throw error;
  }
};
