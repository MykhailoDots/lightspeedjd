import fs from "node:fs/promises";
import path from "node:path";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

type QueryValue = string | string[] | undefined;

interface ApiRequestLike {
  method?: string;
  query?: Record<string, QueryValue>;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

interface ApiResponseLike {
  status: (code: number) => ApiResponseLike;
  json: (payload: unknown) => void;
  setHeader: (name: string, value: string) => void;
}

interface TaxLine {
  taxIncluded?: boolean;
}

interface SaleLine {
  totalNetAmountWithTax?: string | number;
  totalNetAmountWithoutTax?: string | number;
  taxAmount?: string | number;
  taxLines?: TaxLine[];
  voidReason?: string;
}

interface Sale {
  cancelled?: boolean;
  type?: string;
  nbCovers?: number;
  salesLines?: SaleLine[];
}

interface SalesDailyDto {
  sales?: Sale[];
  dataComplete?: boolean;
  nextStartOfDayAsIso8601?: string;
}

interface TokenCache {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  obtained_at?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

interface RevenueDetailRow {
  date: string;
  costCenter: string;
  category: string;
  netRevenue: number;
  grossRevenue: number;
  grossMinusNet: number;
  effectiveTaxRatePct: number | null;
  transactions: number;
  covers: number;
  coversPerTransaction: number | null;
  avgNetPerTransaction: number | null;
  avgGrossPerTransaction: number | null;
  avgNetPerCover: number | null;
  avgGrossPerCover: number | null;
}

interface RevenueAggregateSummary {
  totalNetRevenue: number;
  totalGrossRevenue: number;
  totalGrossMinusNet: number;
  effectiveTaxRateTotalPct: number | null;
  totalTransactions: number;
  totalCovers: number;
  averageNetPerTransaction: number | null;
  averageGrossPerTransaction: number | null;
  averageCoversPerTransaction: number | null;
  averageNetPerCover: number | null;
  averageGrossPerCover: number | null;
}

interface RevenueWindowSummary extends RevenueAggregateSummary {
  rows: number;
  startDate: string;
  endDate: string;
}

interface RevenueResponsePayload extends RevenueAggregateSummary {
  timeZone: string;
  businessLocationIds: number[];
  generatedAtUtc: string;
  query: {
    daysPast: number;
    daysFuture: number;
    startDate: string;
    endDate: string;
    fetchDaysPast: number;
    fetchDaysFuture: number;
    fetchStartDate: string;
    fetchEndDate: string;
  };
  rows: number;
  day: RevenueWindowSummary;
  today: RevenueWindowSummary;
  week: RevenueWindowSummary;
  month: RevenueWindowSummary;
  businessDayWindow: {
    businessDate: string;
    basedOnBusinessLocationId: number | null;
    startIso: string | null;
    endIso: string | null;
    startLocal: string | null;
    endLocal: string | null;
  };
  skipIncompleteDays: boolean;
  items: RevenueDetailRow[];
}

interface NormalizedRevenueQuery {
  daysPast: number;
  daysFuture: number;
  skipIncompleteDays: boolean;
}

const DEFAULT_TIME_ZONE = "Europe/Zurich";
const DEFAULT_AUTH_URL = "https://auth.lsk-demo.app/realms/k-series/protocol/openid-connect/token";
const DEFAULT_API_BASE_URL = "https://api.trial.lsk.lightspeed.app";
const TOKEN_SAFETY_SECONDS = 60;
const requestCache = new Map<string, { expiresAt: number; payload: RevenueResponsePayload }>();
const inFlight = new Map<string, Promise<RevenueResponsePayload>>();

const toQueryStringValue = (value: QueryValue): string | undefined => {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return value;
};

const getQueryValue = (req: ApiRequestLike, key: string): string | undefined => {
  const fromQuery = toQueryStringValue(req.query?.[key]);
  if (typeof fromQuery === "string") return fromQuery;

  if (!req.url) return undefined;
  try {
    const hostHeader = toQueryStringValue(req.headers?.host) || "localhost";
    const parsed = new URL(req.url, `http://${hostHeader}`);
    return parsed.searchParams.get(key) || undefined;
  } catch {
    return undefined;
  }
};

const parseBoolean = (value: string | null | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  return value.toLowerCase() === "true";
};

const parseNumber = (value: string | null | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const getRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not defined`);
  }
  return value;
};

const getAuthUrl = (): string => process.env.LSK_AUTH_URL || DEFAULT_AUTH_URL;
const getApiBaseUrl = (): string => process.env.LSK_API_BASE_URL || DEFAULT_API_BASE_URL;
const getTimeZone = (): string => process.env.LSK_TIME_ZONE || DEFAULT_TIME_ZONE;

const getCacheTtlMs = (): number => {
  const seconds = parseNumber(process.env.LSK_WEB_CACHE_TTL_SECONDS, 20);
  return Math.max(0, Math.trunc(seconds)) * 1000;
};

const getRequestTimeoutMs = (): number => {
  const seconds = parseNumber(process.env.LSK_WEB_REQUEST_TIMEOUT_SECONDS, 90);
  return Math.max(10, Math.trunc(seconds)) * 1000;
};

const getTokenCachePath = (): string => {
  const configuredPath = process.env.LSK_TOKEN_CACHE_PATH || "/tmp/lightspeed-token-web.json";
  if (path.isAbsolute(configuredPath)) return configuredPath;
  return path.resolve(process.cwd(), configuredPath);
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
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
};

const isTokenValid = (token: TokenCache | null): boolean => {
  if (!token?.access_token || !token.expires_at) return false;
  const expiresAt = dayjs(token.expires_at);
  if (!expiresAt.isValid()) return false;
  return expiresAt.isAfter(dayjs().add(TOKEN_SAFETY_SECONDS, "second"));
};

const normalizeRevenueQuery = (req: ApiRequestLike): NormalizedRevenueQuery => {
  const daysPastRaw = parseNumber(getQueryValue(req, "daysPast") || process.env.LSK_DAYS_PAST, 0);
  const daysFutureRaw = parseNumber(
    getQueryValue(req, "daysFuture") || process.env.LSK_DAYS_FUTURE,
    0
  );
  const skipIncompleteDays = parseBoolean(
    getQueryValue(req, "skipIncompleteDays") || process.env.LSK_SKIP_INCOMPLETE_DAYS,
    false
  );

  return {
    daysPast: clampNumber(Math.trunc(daysPastRaw), 0, 365),
    daysFuture: clampNumber(Math.trunc(daysFutureRaw), 0, 30),
    skipIncompleteDays,
  };
};

const parseBusinessLocationIds = (): number[] => {
  const idsFromList = (process.env.LSK_BUSINESS_LOCATION_IDS || "")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);

  if (idsFromList.length > 0) return idsFromList;

  const single = Number(getRequiredEnv("LSK_BUSINESS_LOCATION_ID_1"));
  if (!Number.isFinite(single) || single <= 0) {
    throw new Error("LSK_BUSINESS_LOCATION_ID_1 must be a valid positive number");
  }

  return [single];
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithRetry = async (
  url: string,
  init: RequestInit,
  maxRetries = 4
): Promise<Response> => {
  let attempt = 0;

  while (true) {
    try {
      const response = await fetch(url, init);
      if (
        (response.status === 429 || (response.status >= 500 && response.status <= 599)) &&
        attempt < maxRetries
      ) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
        const backoffMs = Number.isFinite(retryAfterSeconds)
          ? Math.max(1, retryAfterSeconds) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 15000);

        await sleep(backoffMs);
        attempt += 1;
        continue;
      }

      return response;
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 15000);
      await sleep(backoffMs);
      attempt += 1;
    }
  }
};

const requestNewToken = async (): Promise<TokenCache> => {
  const clientId = getRequiredEnv("LSK_CLIENT_ID");
  const clientSecret = getRequiredEnv("LSK_CLIENT_SECRET");
  const refreshToken = getRequiredEnv("LSK_REFRESH_TOKEN");

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("refresh_token", refreshToken);

  const response = await fetchWithRetry(getAuthUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const responseText = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const message =
      typeof parsed.error_description === "string"
        ? parsed.error_description
        : responseText || `HTTP ${response.status}`;
    throw new Error(`Lightspeed token refresh failed (${response.status}): ${message}`);
  }

  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (!accessToken) {
    throw new Error("Lightspeed token refresh returned no access_token");
  }

  const expiresIn =
    typeof parsed.expires_in === "number"
      ? parsed.expires_in
      : Number.parseInt(String(parsed.expires_in || "0"), 10);

  const obtainedAt = dayjs();
  const token: TokenCache = {
    access_token: accessToken,
    refresh_token:
      typeof parsed.refresh_token === "string" ? parsed.refresh_token : getRequiredEnv("LSK_REFRESH_TOKEN"),
    expires_in: Number.isFinite(expiresIn) ? expiresIn : undefined,
    expires_at: obtainedAt.add(Number.isFinite(expiresIn) ? expiresIn : 3600, "second").toISOString(),
    obtained_at: obtainedAt.toISOString(),
    token_type: typeof parsed.token_type === "string" ? parsed.token_type : "Bearer",
    scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
  };

  return token;
};

const getAccessToken = async (): Promise<string> => {
  const tokenPath = getTokenCachePath();
  const cached = await readJsonFile<TokenCache>(tokenPath);

  if (isTokenValid(cached)) {
    return cached!.access_token;
  }

  const fresh = await requestNewToken();
  try {
    await writeJsonFile(tokenPath, fresh);
  } catch {
    // Token cache is best-effort in serverless runtime.
  }

  return fresh.access_token;
};

const toNumber = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const aggregateRevenueRows = (rows: RevenueDetailRow[]): RevenueAggregateSummary => {
  const totalNetRevenue = Number(rows.reduce((acc, row) => acc + row.netRevenue, 0).toFixed(2));
  const totalGrossRevenue = Number(rows.reduce((acc, row) => acc + row.grossRevenue, 0).toFixed(2));
  const totalGrossMinusNet = Number((totalGrossRevenue - totalNetRevenue).toFixed(2));
  const totalTransactions = Number(rows.reduce((acc, row) => acc + row.transactions, 0).toFixed(2));
  const totalCovers = Number(rows.reduce((acc, row) => acc + row.covers, 0).toFixed(2));

  const averageNetPerTransaction =
    totalTransactions > 0 ? Number((totalNetRevenue / totalTransactions).toFixed(2)) : null;
  const averageGrossPerTransaction =
    totalTransactions > 0 ? Number((totalGrossRevenue / totalTransactions).toFixed(2)) : null;
  const averageCoversPerTransaction =
    totalTransactions > 0 ? Number((totalCovers / totalTransactions).toFixed(2)) : null;
  const averageNetPerCover = totalCovers > 0 ? Number((totalNetRevenue / totalCovers).toFixed(2)) : null;
  const averageGrossPerCover =
    totalCovers > 0 ? Number((totalGrossRevenue / totalCovers).toFixed(2)) : null;
  const effectiveTaxRateTotalPct =
    Math.abs(totalNetRevenue) > 0.000001
      ? Number(((totalGrossMinusNet / totalNetRevenue) * 100).toFixed(2))
      : null;

  return {
    totalNetRevenue,
    totalGrossRevenue,
    totalGrossMinusNet,
    effectiveTaxRateTotalPct,
    totalTransactions,
    totalCovers,
    averageNetPerTransaction,
    averageGrossPerTransaction,
    averageCoversPerTransaction,
    averageNetPerCover,
    averageGrossPerCover,
  };
};

const summarizeWindowRows = (
  rows: RevenueDetailRow[],
  startDate: string,
  endDate: string
): RevenueWindowSummary => {
  const scopedRows = rows.filter((row) => row.date >= startDate && row.date <= endDate);
  return {
    rows: scopedRows.length,
    startDate,
    endDate,
    ...aggregateRevenueRows(scopedRows),
  };
};

const buildDateList = (startDate: string, endDate: string): string[] => {
  const dates: string[] = [];
  let cursor = dayjs(startDate);
  const end = dayjs(endDate);

  while (cursor.isBefore(end) || cursor.isSame(end, "day")) {
    dates.push(cursor.format("YYYY-MM-DD"));
    cursor = cursor.add(1, "day");
  }

  return dates;
};

const fetchSalesDaily = async (
  accessToken: string,
  businessLocationId: number,
  date: string
): Promise<SalesDailyDto> => {
  const endpoint = `${getApiBaseUrl()}/f/v2/business-location/${businessLocationId}/sales-daily?date=${encodeURIComponent(
    date
  )}`;

  const response = await fetchWithRetry(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const responseText = await response.text();
  let parsed: SalesDailyDto | Record<string, unknown> = {};
  try {
    parsed = responseText ? (JSON.parse(responseText) as SalesDailyDto) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const maybeError = parsed as Record<string, unknown>;
    const detail =
      typeof maybeError.message === "string"
        ? maybeError.message
        : responseText || `HTTP ${response.status}`;
    throw new Error(
      `Lightspeed sales-daily failed (${response.status}) for BLID=${businessLocationId} date=${date}: ${detail}`
    );
  }

  return parsed as SalesDailyDto;
};

const computeRowFromSales = (
  date: string,
  businessLocationId: number,
  sales: Sale[]
): RevenueDetailRow => {
  let netRevenue = 0;
  let grossRevenue = 0;
  let transactions = 0;
  let covers = 0;

  for (const sale of sales) {
    if (sale?.cancelled) continue;

    const saleType = String(sale?.type ?? "SALE");
    if (!["SALE", "REFUND"].includes(saleType)) continue;

    transactions += 1;
    covers += toNumber(sale?.nbCovers);

    const lines = Array.isArray(sale?.salesLines) ? sale.salesLines : [];
    for (const line of lines) {
      if (line?.voidReason) continue;

      const net = toNumber(line?.totalNetAmountWithoutTax);
      netRevenue += net;

      const taxIncluded =
        Array.isArray(line?.taxLines) && line.taxLines.some((taxLine) => taxLine?.taxIncluded === true);
      if (taxIncluded) {
        grossRevenue += toNumber(line?.totalNetAmountWithTax);
      } else {
        grossRevenue += net + toNumber(line?.taxAmount);
      }
    }
  }

  netRevenue = Number(netRevenue.toFixed(2));
  grossRevenue = Number(grossRevenue.toFixed(2));
  transactions = Number(transactions.toFixed(2));
  covers = Number(covers.toFixed(2));

  const grossMinusNet = Number((grossRevenue - netRevenue).toFixed(2));
  const effectiveTaxRatePct =
    Math.abs(netRevenue) > 0.000001 ? Number(((grossMinusNet / netRevenue) * 100).toFixed(2)) : null;
  const coversPerTransaction =
    transactions > 0 ? Number((covers / transactions).toFixed(2)) : null;
  const avgNetPerTransaction =
    transactions > 0 ? Number((netRevenue / transactions).toFixed(2)) : null;
  const avgGrossPerTransaction =
    transactions > 0 ? Number((grossRevenue / transactions).toFixed(2)) : null;
  const avgNetPerCover = covers > 0 ? Number((netRevenue / covers).toFixed(2)) : null;
  const avgGrossPerCover = covers > 0 ? Number((grossRevenue / covers).toFixed(2)) : null;

  return {
    date,
    costCenter: String(businessLocationId),
    category: "Ist",
    netRevenue,
    grossRevenue,
    grossMinusNet,
    effectiveTaxRatePct,
    transactions,
    covers,
    coversPerTransaction,
    avgNetPerTransaction,
    avgGrossPerTransaction,
    avgNetPerCover,
    avgGrossPerCover,
  };
};

const buildPayload = async (query: NormalizedRevenueQuery): Promise<RevenueResponsePayload> => {
  const businessLocationIds = parseBusinessLocationIds();
  const primaryBusinessLocationId = businessLocationIds[0] ?? null;
  const timeZone = getTimeZone();
  const { daysPast, daysFuture, skipIncompleteDays } = query;

  const rangeStart = dayjs().tz(timeZone).subtract(daysPast, "day").format("YYYY-MM-DD");
  const rangeEnd = dayjs().tz(timeZone).add(daysFuture, "day").format("YYYY-MM-DD");
  const todayDate = dayjs().tz(timeZone).format("YYYY-MM-DD");

  const minimumDaysPastForAutoPeriods = 30;
  const fetchDaysPast = Math.max(daysPast, minimumDaysPastForAutoPeriods);
  const fetchDaysFuture = daysFuture;

  const fetchRangeStart = dayjs().tz(timeZone).subtract(fetchDaysPast, "day").format("YYYY-MM-DD");
  const fetchRangeEnd = dayjs().tz(timeZone).add(fetchDaysFuture, "day").format("YYYY-MM-DD");

  const datesToFetch = buildDateList(fetchRangeStart, fetchRangeEnd);
  const accessToken = await getAccessToken();
  const nextStartByDate = new Map<string, string>();

  const rows: RevenueDetailRow[] = [];

  for (const businessLocationId of businessLocationIds) {
    for (const date of datesToFetch) {
      const daily = await fetchSalesDaily(accessToken, businessLocationId, date);
      if (
        businessLocationId === primaryBusinessLocationId &&
        typeof daily.nextStartOfDayAsIso8601 === "string" &&
        daily.nextStartOfDayAsIso8601.trim().length > 0
      ) {
        nextStartByDate.set(date, daily.nextStartOfDayAsIso8601);
      }
      if (skipIncompleteDays && daily.dataComplete === false) {
        continue;
      }

      const sales = Array.isArray(daily.sales) ? daily.sales : [];
      rows.push(computeRowFromSales(date, businessLocationId, sales));
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.costCenter.localeCompare(b.costCenter));

  const itemsInRequestedRange = rows.filter((row) => row.date >= rangeStart && row.date <= rangeEnd);
  const requestedSummary = aggregateRevenueRows(itemsInRequestedRange);
  const businessDate = rangeEnd;
  const businessDatePrev = dayjs(businessDate).subtract(1, "day").format("YYYY-MM-DD");
  const businessDayStartIso = nextStartByDate.get(businessDatePrev) || null;
  const businessDayEndIso = nextStartByDate.get(businessDate) || null;
  const formatLocal = (iso: string | null): string | null =>
    iso ? dayjs(iso).tz(timeZone).format("YYYY-MM-DD HH:mm") : null;
  const daySummary = summarizeWindowRows(rows, businessDate, businessDate);

  const weekSummary = summarizeWindowRows(
    rows,
    dayjs().tz(timeZone).subtract(6, "day").format("YYYY-MM-DD"),
    todayDate
  );
  const monthSummary = summarizeWindowRows(
    rows,
    dayjs().tz(timeZone).subtract(29, "day").format("YYYY-MM-DD"),
    todayDate
  );

  return {
    timeZone,
    businessLocationIds,
    generatedAtUtc: new Date().toISOString(),
    query: {
      daysPast,
      daysFuture,
      startDate: rangeStart,
      endDate: rangeEnd,
      fetchDaysPast,
      fetchDaysFuture,
      fetchStartDate: fetchRangeStart,
      fetchEndDate: fetchRangeEnd,
    },
    rows: itemsInRequestedRange.length,
    totalNetRevenue: requestedSummary.totalNetRevenue,
    totalGrossRevenue: requestedSummary.totalGrossRevenue,
    totalGrossMinusNet: requestedSummary.totalGrossMinusNet,
    effectiveTaxRateTotalPct: requestedSummary.effectiveTaxRateTotalPct,
    totalTransactions: requestedSummary.totalTransactions,
    totalCovers: requestedSummary.totalCovers,
    averageNetPerTransaction: requestedSummary.averageNetPerTransaction,
    averageGrossPerTransaction: requestedSummary.averageGrossPerTransaction,
    averageCoversPerTransaction: requestedSummary.averageCoversPerTransaction,
    averageNetPerCover: requestedSummary.averageNetPerCover,
    averageGrossPerCover: requestedSummary.averageGrossPerCover,
    day: daySummary,
    today: daySummary,
    week: weekSummary,
    month: monthSummary,
    businessDayWindow: {
      businessDate,
      basedOnBusinessLocationId: primaryBusinessLocationId,
      startIso: businessDayStartIso,
      endIso: businessDayEndIso,
      startLocal: formatLocal(businessDayStartIso),
      endLocal: formatLocal(businessDayEndIso),
    },
    skipIncompleteDays,
    items: itemsInRequestedRange,
  };
};

const pruneCache = (nowMs: number) => {
  for (const [key, entry] of requestCache.entries()) {
    if (entry.expiresAt <= nowMs) requestCache.delete(key);
  }
};

const getPayloadWithCache = async (query: NormalizedRevenueQuery): Promise<RevenueResponsePayload> => {
  const cacheKey = `${query.daysPast}|${query.daysFuture}|${query.skipIncompleteDays ? 1 : 0}`;
  const nowMs = Date.now();
  const cacheTtlMs = getCacheTtlMs();

  pruneCache(nowMs);

  const cached = requestCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return cached.payload;
  }

  const inflightRequest = inFlight.get(cacheKey);
  if (inflightRequest) return inflightRequest;

  const promise = withTimeout(buildPayload(query), getRequestTimeoutMs(), "Lightspeed revenue API")
    .then((payload) => {
      if (cacheTtlMs > 0) {
        requestCache.set(cacheKey, {
          expiresAt: Date.now() + cacheTtlMs,
          payload,
        });
      }
      return payload;
    })
    .finally(() => {
      inFlight.delete(cacheKey);
    });

  inFlight.set(cacheKey, promise);
  return promise;
};

export default async function handler(req: ApiRequestLike, res: ApiResponseLike) {
  res.setHeader("Cache-Control", "no-store");

  if ((req.method || "GET").toUpperCase() !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const query = normalizeRevenueQuery(req);
    const payload = await getPayloadWithCache(query);
    res.status(200).json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[lightspeed-api] ${message}`);
    res.status(500).json({ error: message });
  }
}
