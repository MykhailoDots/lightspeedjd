import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dayjs from "../src/helper/customDayJs";
import logger from "../src/helper/logger";
import { importFromLightspeed } from "../src/sources/lightspeed";
import type { LightspeedSourceConfig } from "../src/config";
import type { MetricImport } from "../src/index";

const loadEnvFile = (filePath: string) => {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};

const preloadEnv = () => {
  const cwdEnv = path.join(process.cwd(), ".env");
  loadEnvFile(cwdEnv);
  const cwdEnvLocal = path.join(process.cwd(), ".env.local");
  loadEnvFile(cwdEnvLocal);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRootEnv = path.join(scriptDir, "..", ".env");
  if (repoRootEnv !== cwdEnv) {
    loadEnvFile(repoRootEnv);
  }
  const repoRootEnvLocal = path.join(scriptDir, "..", ".env.local");
  if (repoRootEnvLocal !== cwdEnvLocal) {
    loadEnvFile(repoRootEnvLocal);
  }
};

const getRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not defined`);
  }
  return value;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  return value.toLowerCase() === "true";
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const parseBusinessLocationIds = (): number[] => {
  const idsFromList = (process.env.LSK_BUSINESS_LOCATION_IDS || "")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);

  if (idsFromList.length > 0) {
    return idsFromList;
  }

  const single = Number(getRequiredEnv("LSK_BUSINESS_LOCATION_ID_1"));
  if (!Number.isFinite(single) || single <= 0) {
    throw new Error("LSK_BUSINESS_LOCATION_ID_1 must be a valid positive number");
  }
  return [single];
};

interface NormalizedRevenueQuery {
  daysPast: number;
  daysFuture: number;
  skipIncompleteDays: boolean;
}

const normalizeRevenueQuery = (params: URLSearchParams): NormalizedRevenueQuery => {
  const daysPastRaw = parseNumber(params.get("daysPast") || process.env.LSK_DAYS_PAST, 0);
  const daysFutureRaw = parseNumber(
    params.get("daysFuture") || process.env.LSK_DAYS_FUTURE,
    0
  );
  const skipIncompleteDays = parseBoolean(
    params.get("skipIncompleteDays") || process.env.LSK_SKIP_INCOMPLETE_DAYS,
    false
  );

  return {
    // Guardrails against accidentally huge windows that can overload API/runtime.
    daysPast: clampNumber(Math.trunc(daysPastRaw), 0, 365),
    daysFuture: clampNumber(Math.trunc(daysFutureRaw), 0, 30),
    skipIncompleteDays,
  };
};

const getRevenueCacheTtlMs = (): number => {
  const seconds = parseNumber(process.env.LSK_WEB_CACHE_TTL_SECONDS, 20);
  return Math.max(0, Math.trunc(seconds)) * 1000;
};

const getRevenueRequestTimeoutMs = (): number => {
  const seconds = parseNumber(process.env.LSK_WEB_REQUEST_TIMEOUT_SECONDS, 90);
  return Math.max(10, Math.trunc(seconds)) * 1000;
};

const getRevenueCacheKey = (query: NormalizedRevenueQuery): string =>
  `${query.daysPast}|${query.daysFuture}|${query.skipIncompleteDays ? 1 : 0}`;

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

const METRIC_NET = "Umsatz Netto";
const METRIC_GROSS = "Umsatz Brutto";
const METRIC_TX = "Transactions";
const METRIC_COVERS = "Covers";

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

const aggregateRevenueRows = (rows: RevenueDetailRow[]): RevenueAggregateSummary => {
  const totalNetRevenue = Number(
    rows.reduce((acc, row) => acc + row.netRevenue, 0).toFixed(2)
  );
  const totalGrossRevenue = Number(
    rows.reduce((acc, row) => acc + row.grossRevenue, 0).toFixed(2)
  );
  const totalGrossMinusNet = Number((totalGrossRevenue - totalNetRevenue).toFixed(2));
  const totalTransactions = Number(
    rows.reduce((acc, row) => acc + row.transactions, 0).toFixed(2)
  );
  const totalCovers = Number(rows.reduce((acc, row) => acc + row.covers, 0).toFixed(2));

  const averageNetPerTransaction =
    totalTransactions > 0
      ? Number((totalNetRevenue / totalTransactions).toFixed(2))
      : null;
  const averageGrossPerTransaction =
    totalTransactions > 0
      ? Number((totalGrossRevenue / totalTransactions).toFixed(2))
      : null;
  const averageCoversPerTransaction =
    totalTransactions > 0 ? Number((totalCovers / totalTransactions).toFixed(2)) : null;
  const averageNetPerCover =
    totalCovers > 0 ? Number((totalNetRevenue / totalCovers).toFixed(2)) : null;
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

const summarizeRevenueDetails = (metrics: MetricImport[], timeZone: string) => {
  const byKey = new Map<string, RevenueDetailRow>();

  for (const metric of metrics) {
    const value = Number(metric.value);
    if (!Number.isFinite(value)) continue;

    const date = dayjs(metric.timestampCompatibleWithGranularity)
      .tz(timeZone)
      .format("YYYY-MM-DD");
    const key = `${date}|${metric.costCenter}|${metric.metricTypeCategory}`;

    let row = byKey.get(key);
    if (!row) {
      row = {
        date,
        costCenter: metric.costCenter,
        category: metric.metricTypeCategory,
        netRevenue: 0,
        grossRevenue: 0,
        grossMinusNet: 0,
        effectiveTaxRatePct: null,
        transactions: 0,
        covers: 0,
        coversPerTransaction: null,
        avgNetPerTransaction: null,
        avgGrossPerTransaction: null,
        avgNetPerCover: null,
        avgGrossPerCover: null,
      };
      byKey.set(key, row);
    }

    if (metric.metricType === METRIC_NET) row.netRevenue += value;
    if (metric.metricType === METRIC_GROSS) row.grossRevenue += value;
    if (metric.metricType === METRIC_TX) row.transactions += value;
    if (metric.metricType === METRIC_COVERS) row.covers += value;
  }

  const rows = Array.from(byKey.values())
    .map((row) => {
      const tx = row.transactions;
      const covers = row.covers;
      const grossMinusNet = row.grossRevenue - row.netRevenue;
      return {
        ...row,
        netRevenue: Number(row.netRevenue.toFixed(2)),
        grossRevenue: Number(row.grossRevenue.toFixed(2)),
        grossMinusNet: Number(grossMinusNet.toFixed(2)),
        effectiveTaxRatePct:
          Math.abs(row.netRevenue) > 0.000001
            ? Number(((grossMinusNet / row.netRevenue) * 100).toFixed(2))
            : null,
        transactions: Number(row.transactions.toFixed(2)),
        covers: Number(row.covers.toFixed(2)),
        coversPerTransaction:
          tx > 0 ? Number((covers / tx).toFixed(2)) : null,
        avgNetPerTransaction:
          tx > 0 ? Number((row.netRevenue / tx).toFixed(2)) : null,
        avgGrossPerTransaction:
          tx > 0 ? Number((row.grossRevenue / tx).toFixed(2)) : null,
        avgNetPerCover:
          covers > 0 ? Number((row.netRevenue / covers).toFixed(2)) : null,
        avgGrossPerCover:
          covers > 0 ? Number((row.grossRevenue / covers).toFixed(2)) : null,
      };
    })
    .sort((a, b) => {
      return a.date.localeCompare(b.date) || a.costCenter.localeCompare(b.costCenter);
    });

  return {
    rows,
    ...aggregateRevenueRows(rows),
  };
};

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Lightspeed Revenue Console</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&display=swap");

      :root {
        --background: 0 0% 100%;
        --foreground: 0 0% 3.9%;
        --card: 0 0% 100%;
        --card-foreground: 0 0% 3.9%;
        --popover: 0 0% 100%;
        --popover-foreground: 0 0% 3.9%;
        --primary: 218 82% 52%;
        --primary-foreground: 0 0% 98%;
        --secondary: 0 0% 96.1%;
        --secondary-foreground: 0 0% 9%;
        --muted: 0 0% 96.1%;
        --muted-foreground: 0 0% 45.1%;
        --accent: 0 0% 96.1%;
        --accent-foreground: 0 0% 9%;
        --destructive: 0 84.2% 60.2%;
        --destructive-foreground: 0 0% 98%;
        --border: 0 0% 89.8%;
        --input: 0 0% 89.8%;
        --ring: 0 0% 3.9%;
        --radius: 0.75rem;
        --electric: 188 88% 42%;
        --violet: 258 86% 62%;
        --warm: 30 94% 56%;
      }

      * {
        box-sizing: border-box;
        border-color: hsl(var(--border));
      }

      @keyframes jd-fade-up {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes jd-float {
        0% {
          transform: translate3d(0, 0, 0) scale(1);
        }
        50% {
          transform: translate3d(0, -14px, 0) scale(1.04);
        }
        100% {
          transform: translate3d(0, 0, 0) scale(1);
        }
      }

      @keyframes jd-gradient-flow {
        0% {
          background-position: 0% 50%;
        }
        100% {
          background-position: 200% 50%;
        }
      }

      @keyframes jd-pulse-dot {
        0% {
          transform: scale(1);
          box-shadow: 0 0 0 0 hsl(var(--primary) / 0.35);
        }
        70% {
          transform: scale(1.06);
          box-shadow: 0 0 0 8px hsl(var(--primary) / 0);
        }
        100% {
          transform: scale(1);
          box-shadow: 0 0 0 0 hsl(var(--primary) / 0);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          animation: none !important;
          transition: none !important;
        }
      }

      body {
        position: relative;
        margin: 0;
        min-height: 100vh;
        color: hsl(var(--foreground));
        font-family: "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;
        background:
          radial-gradient(1000px 400px at 100% -5%, hsl(var(--primary) / 0.18) 0%, hsl(var(--primary) / 0) 62%),
          radial-gradient(900px 320px at -5% 0%, hsl(var(--electric) / 0.14) 0%, hsl(var(--electric) / 0) 58%),
          radial-gradient(680px 280px at 25% 110%, hsl(var(--violet) / 0.12) 0%, hsl(var(--violet) / 0) 65%),
          hsl(var(--background));
      }

      body::before,
      body::after {
        content: "";
        position: fixed;
        z-index: 0;
        pointer-events: none;
        filter: blur(2px);
        animation: jd-float 15s ease-in-out infinite;
      }

      body::before {
        width: 340px;
        height: 340px;
        right: -90px;
        top: 70px;
        border-radius: 999px;
        background: radial-gradient(circle, hsl(var(--primary) / 0.2) 0%, hsl(var(--primary) / 0) 68%);
      }

      body::after {
        width: 300px;
        height: 300px;
        left: -110px;
        bottom: 80px;
        border-radius: 999px;
        background: radial-gradient(circle, hsl(var(--electric) / 0.2) 0%, hsl(var(--electric) / 0) 70%);
        animation-delay: -5s;
      }

      .wrap {
        position: relative;
        z-index: 1;
        max-width: 1240px;
        margin: 0 auto;
        padding: 22px 16px 34px;
      }

      .header,
      .table-wrap,
      .guide {
        border: 1px solid hsl(var(--border));
        background: hsl(var(--card));
        color: hsl(var(--card-foreground));
        border-radius: calc(var(--radius) + 6px);
        box-shadow: 0 1px 2px rgba(17, 24, 39, 0.06), 0 10px 28px rgba(17, 24, 39, 0.05);
        animation: jd-fade-up .35s ease both;
      }

      .header {
        position: relative;
        overflow: hidden;
        padding: 20px;
      }

      .header::before {
        content: "";
        position: absolute;
        inset: 0 0 auto 0;
        height: 3px;
        background: linear-gradient(90deg, hsl(var(--primary)), hsl(var(--electric)), hsl(var(--violet)));
        background-size: 200% 100%;
        animation: jd-gradient-flow 8s linear infinite;
      }

      .title {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .title-left {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .brand {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .brand-mark {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        border: 1px solid hsl(var(--border));
        background: linear-gradient(140deg, hsl(var(--foreground)), hsl(220 13% 24%));
        padding: 6px 10px 6px 6px;
        box-shadow: 0 8px 20px rgba(17, 24, 39, 0.24);
      }

      .brand-icon {
        width: 26px;
        height: 26px;
        border-radius: 999px;
        background: #fff;
        object-fit: contain;
        padding: 2px;
      }

      .brand-wordmark {
        height: 14px;
        width: auto;
        object-fit: contain;
      }

      h1 {
        margin: 0;
        font-size: 32px;
        line-height: 1.04;
        letter-spacing: -0.02em;
      }

      .subtitle {
        margin: 10px 0 0;
        color: hsl(var(--muted-foreground));
        font-size: 14px;
      }

      .tag {
        display: inline-flex;
        align-items: center;
        white-space: nowrap;
        border: 1px solid transparent;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 700;
        background: linear-gradient(130deg, hsl(var(--primary)), hsl(var(--electric)));
        color: hsl(var(--primary-foreground));
        box-shadow: 0 6px 14px hsl(var(--primary) / 0.25);
      }

      .revenue-top {
        margin-top: 16px;
        display: grid;
        grid-template-columns: repeat(2, minmax(220px, 1fr));
        gap: 12px;
      }

      .revenue-top-card {
        position: relative;
        overflow: hidden;
        border: 1px solid hsl(var(--border));
        border-radius: calc(var(--radius) + 2px);
        background: linear-gradient(180deg, hsl(var(--card)), hsl(var(--muted) / 0.35));
        padding: 14px 16px;
        box-shadow: 0 8px 22px rgba(17, 24, 39, 0.09);
      }

      .revenue-top-card::after {
        content: "";
        position: absolute;
        width: 180px;
        height: 180px;
        right: -58px;
        top: -70px;
        border-radius: 999px;
      }

      .revenue-top-card.net::before,
      .revenue-top-card.gross::before {
        content: "";
        position: absolute;
        inset: 0 0 auto 0;
        height: 3px;
      }

      .revenue-top-card.net::before {
        background: linear-gradient(90deg, hsl(var(--electric)), hsl(var(--primary)));
      }

      .revenue-top-card.gross::before {
        background: linear-gradient(90deg, hsl(var(--warm)), hsl(var(--violet)));
      }

      .revenue-top-card.net::after {
        background: radial-gradient(circle, hsl(var(--electric) / 0.22) 0%, hsl(var(--electric) / 0) 72%);
      }

      .revenue-top-card.gross::after {
        background: radial-gradient(circle, hsl(var(--warm) / 0.2) 0%, hsl(var(--warm) / 0) 74%);
      }

      .revenue-top-card .label {
        position: relative;
        z-index: 1;
        color: hsl(var(--muted-foreground));
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .03em;
      }

      .revenue-top-card .value {
        position: relative;
        z-index: 1;
        margin-top: 6px;
        font-size: 36px;
        line-height: 1;
        letter-spacing: -0.03em;
        font-weight: 800;
      }

      .revenue-top-card .hint {
        position: relative;
        z-index: 1;
        margin-top: 6px;
        color: hsl(var(--muted-foreground));
        font-size: 12px;
        font-weight: 700;
      }

      .controls {
        margin-top: 18px;
        display: grid;
        grid-template-columns: repeat(4, minmax(130px, 1fr));
        gap: 12px;
      }

      .field label {
        display: block;
        margin: 0 0 6px;
        color: hsl(var(--muted-foreground));
        font-size: 12px;
        font-weight: 700;
      }

      .field input,
      .field select {
        width: 100%;
        height: 38px;
        border: 1px solid hsl(var(--input));
        border-radius: calc(var(--radius) - 2px);
        background: linear-gradient(180deg, hsl(var(--background)), hsl(var(--muted) / 0.45));
        color: hsl(var(--foreground));
        padding: 0 11px;
        font: inherit;
        font-size: 14px;
        box-shadow: 0 1px 2px rgba(17, 24, 39, 0.04);
        transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
      }

      .field input:focus,
      .field select:focus {
        outline: none;
        border-color: hsl(var(--ring) / 0.35);
        box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18);
      }

      .field button {
        width: 100%;
        height: 38px;
        border: 1px solid transparent;
        border-radius: calc(var(--radius) - 2px);
        background: linear-gradient(130deg, hsl(var(--primary)), hsl(var(--electric)));
        color: hsl(var(--primary-foreground));
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 8px 18px hsl(var(--primary) / 0.3), 0 1px 2px rgba(17, 24, 39, 0.12);
        transition: filter .18s ease, transform .18s ease, box-shadow .2s ease;
      }

      .field button:hover {
        filter: brightness(0.96);
        transform: translateY(-1px);
        box-shadow: 0 12px 22px hsl(var(--primary) / 0.34), 0 4px 10px rgba(17, 24, 39, 0.13);
      }

      .field button:active {
        transform: translateY(1px);
      }

      .cards {
        margin-top: 16px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 12px;
      }

      .card {
        position: relative;
        overflow: hidden;
        background: hsl(var(--card));
        border: 1px solid hsl(var(--border));
        border-radius: var(--radius);
        padding: 14px;
        box-shadow: 0 1px 2px rgba(17, 24, 39, 0.03);
        transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease;
      }

      .card::before {
        content: "";
        position: absolute;
        inset: 0 0 auto 0;
        height: 2px;
        background: linear-gradient(90deg, hsl(var(--primary) / 0), hsl(var(--primary) / 0.85), hsl(var(--primary) / 0));
      }

      .card::after {
        content: "";
        position: absolute;
        width: 140px;
        height: 140px;
        right: -46px;
        top: -62px;
        border-radius: 999px;
        background: radial-gradient(circle, hsl(var(--primary) / 0.16) 0%, hsl(var(--primary) / 0) 72%);
        transition: transform .3s ease;
      }

      .card:hover {
        transform: translateY(-3px);
        border-color: hsl(var(--primary) / 0.38);
        box-shadow: 0 14px 30px rgba(17, 24, 39, 0.12);
      }

      .card:hover::after {
        transform: scale(1.1);
      }

      .cards .card:nth-child(3n)::before {
        background: linear-gradient(90deg, hsl(var(--electric) / 0), hsl(var(--electric) / 0.9), hsl(var(--electric) / 0));
      }

      .cards .card:nth-child(3n)::after {
        background: radial-gradient(circle, hsl(var(--electric) / 0.18) 0%, hsl(var(--electric) / 0) 74%);
      }

      .cards .card:nth-child(3n + 2)::before {
        background: linear-gradient(90deg, hsl(var(--violet) / 0), hsl(var(--violet) / 0.86), hsl(var(--violet) / 0));
      }

      .cards .card:nth-child(3n + 2)::after {
        background: radial-gradient(circle, hsl(var(--violet) / 0.16) 0%, hsl(var(--violet) / 0) 74%);
      }

      .card .label {
        margin-bottom: 6px;
        color: hsl(var(--muted-foreground));
        font-size: 12px;
        font-weight: 700;
      }

      .card .value {
        font-size: 28px;
        line-height: 1.05;
        font-weight: 800;
        letter-spacing: -0.02em;
      }

      .card .small {
        margin-top: 5px;
        font-size: 12px;
        color: hsl(var(--muted-foreground));
      }

      .meta {
        margin-top: 12px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        border: 1px solid hsl(var(--border));
        border-radius: 999px;
        background: linear-gradient(180deg, hsl(var(--background)), hsl(var(--secondary)));
        color: hsl(var(--muted-foreground));
        font-size: 12px;
        font-weight: 600;
        padding: 7px 11px;
        transition: transform .16s ease, border-color .16s ease, color .16s ease;
      }

      .chip:hover {
        transform: translateY(-1px);
        border-color: hsl(var(--primary) / 0.35);
        color: hsl(var(--foreground));
      }

      .table-wrap {
        margin-top: 14px;
        overflow: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 1120px;
      }

      thead tr {
        border-bottom: 1px solid hsl(var(--border));
      }

      th {
        position: sticky;
        top: 0;
        z-index: 2;
        height: 40px;
        padding: 10px 8px;
        text-align: left;
        background: hsl(var(--muted));
        color: hsl(var(--muted-foreground));
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      tbody tr {
        border-bottom: 1px solid hsl(var(--border));
        transition: background-color .16s ease;
      }

      tbody tr:hover {
        background: linear-gradient(90deg, hsl(var(--muted) / 0.78), hsl(var(--primary) / 0.06));
      }

      td {
        padding: 9px 8px;
        font-size: 13px;
      }

      td strong {
        font-weight: 700;
        color: hsl(var(--foreground));
      }

      .status {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
        color: hsl(var(--muted-foreground));
        font-size: 13px;
      }

      .status::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: hsl(var(--primary));
        animation: jd-pulse-dot 2s ease-in-out infinite;
      }

      .guide {
        margin-top: 14px;
        padding: 16px;
      }

      .guide h2 {
        margin: 0;
        font-size: 24px;
        line-height: 1.1;
        letter-spacing: -0.01em;
      }

      .guide-sub {
        margin: 8px 0 0;
        color: hsl(var(--muted-foreground));
        font-size: 13px;
      }

      .guide-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 10px;
      }

      .guide-play {
        height: 36px;
        min-width: 122px;
        border: 1px solid transparent;
        border-radius: calc(var(--radius) - 2px);
        background: linear-gradient(130deg, hsl(var(--primary)), hsl(var(--electric)));
        color: hsl(var(--primary-foreground));
        font: inherit;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.01em;
        cursor: pointer;
        box-shadow: 0 8px 18px hsl(var(--primary) / 0.3);
        transition: transform .16s ease, filter .16s ease, box-shadow .2s ease;
      }

      .guide-play:hover {
        filter: brightness(0.96);
        transform: translateY(-1px);
        box-shadow: 0 12px 24px hsl(var(--primary) / 0.34);
      }

      .guide-progress {
        margin-top: 12px;
        height: 8px;
        border-radius: 999px;
        overflow: hidden;
        background: hsl(var(--secondary));
      }

      .guide-progress-bar {
        width: 0%;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, hsl(var(--primary)), hsl(var(--electric)), hsl(var(--violet)));
        background-size: 200% 100%;
        animation: jd-gradient-flow 4s linear infinite;
        transition: width .2s ease;
      }

      .guide-nav {
        margin-top: 10px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        border-radius: 999px;
        background: hsl(var(--secondary));
        padding: 6px;
      }

      .guide-tab {
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: hsl(var(--muted-foreground));
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        padding: 7px 11px;
        cursor: pointer;
        transition: background-color .15s ease, color .15s ease;
      }

      .guide-tab.active {
        background: linear-gradient(130deg, hsl(var(--primary)), hsl(var(--electric)));
        color: hsl(var(--primary-foreground));
        box-shadow: 0 1px 2px rgba(17, 24, 39, 0.1);
      }

      .guide-view {
        margin-top: 10px;
        border: 1px solid hsl(var(--border));
        border-radius: var(--radius);
        background: hsl(var(--background));
        padding: 13px;
      }

      .guide-kicker {
        display: inline-flex;
        align-items: center;
        border: 1px solid hsl(var(--border));
        border-radius: 999px;
        background: linear-gradient(180deg, hsl(var(--secondary)), hsl(var(--muted)));
        color: hsl(var(--foreground));
        padding: 5px 9px;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: .03em;
      }

      .guide-view h3 {
        margin: 10px 0 6px;
        font-size: 18px;
        letter-spacing: -0.01em;
      }

      .guide-view p {
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: hsl(var(--muted-foreground));
      }

      .guide-view code,
      .guide-legend code {
        border: 1px solid hsl(var(--border));
        border-radius: calc(var(--radius) - 4px);
        background: hsl(var(--muted));
        color: hsl(var(--foreground));
        padding: 1px 6px;
      }

      .guide-actions {
        margin-top: 10px;
        display: flex;
        gap: 8px;
      }

      .guide-btn {
        border: 1px solid hsl(var(--input));
        border-radius: calc(var(--radius) - 3px);
        background: hsl(var(--background));
        color: hsl(var(--foreground));
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        padding: 6px 11px;
        cursor: pointer;
      }

      .guide-btn:hover {
        background: linear-gradient(180deg, hsl(var(--accent)), hsl(var(--secondary)));
      }

      .guide-notes {
        margin-top: 10px;
        border: 1px solid hsl(var(--border));
        border-radius: var(--radius);
        background: hsl(var(--muted) / 0.42);
        padding: 12px;
      }

      .guide-notes h3 {
        margin: 0 0 6px;
        font-size: 13px;
      }

      .guide-notes ul {
        margin: 0;
        padding-left: 18px;
      }

      .guide-notes li {
        margin: 4px 0;
        font-size: 12px;
        color: hsl(var(--muted-foreground));
      }

      .guide-summary {
        margin: 10px 0 0;
        font-size: 13px;
        line-height: 1.5;
        color: hsl(var(--muted-foreground));
      }

      .guide-summary strong {
        color: hsl(var(--foreground));
      }

      .guide-legend {
        margin-top: 10px;
        border-top: 1px dashed hsl(var(--border));
        padding-top: 10px;
        font-size: 12px;
        color: hsl(var(--muted-foreground));
      }

      @media (max-width: 980px) {
        .revenue-top {
          grid-template-columns: 1fr;
        }
        .controls {
          grid-template-columns: repeat(2, minmax(130px, 1fr));
        }
        .guide-head {
          flex-direction: column;
        }
      }

      @media (max-width: 620px) {
        .brand-wordmark {
          height: 12px;
        }
        h1 {
          font-size: 26px;
        }
        .guide-actions {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="header">
        <div class="title">
          <div class="title-left">
            <div class="brand">
              <span class="brand-mark">
                <img class="brand-icon" src="/assets/jobdone-logo-c.png" alt="JobDone icon" />
                <img class="brand-wordmark" src="/assets/jobdone-logo-name-white.png" alt="JobDone" />
              </span>
            </div>
            <h1>Lightspeed Revenue Console</h1>
          </div>
          <div class="tag">Read-only / No JobDone writes</div>
        </div>
        <p class="subtitle">Daily finance details plus auto-calculated net/gross for last 7 and 30 days.</p>

        <div class="revenue-top">
          <div class="revenue-top-card net">
            <div class="label">Net Revenue</div>
            <div class="value" id="totalNet">-</div>
            <div class="hint">Net amount (without tax)</div>
          </div>
          <div class="revenue-top-card gross">
            <div class="label">Gross Revenue</div>
            <div class="value" id="totalGross">-</div>
            <div class="hint">Gross amount (with tax)</div>
          </div>
        </div>

        <div class="controls">
          <div class="field">
            <label for="daysPast">Days Past</label>
            <input id="daysPast" type="number" value="0" min="0" max="90" />
          </div>
          <div class="field">
            <label for="daysFuture">Days Future</label>
            <input id="daysFuture" type="number" value="0" min="0" max="7" />
          </div>
          <div class="field">
            <label for="skipIncomplete">Skip Incomplete Days</label>
            <select id="skipIncomplete">
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </div>
          <div class="field">
            <label>&nbsp;</label>
            <button id="loadBtn">Refresh</button>
          </div>
        </div>

        <div class="cards">
          <div class="card">
            <div class="label">Gross - Net</div>
            <div class="value" id="totalDelta">-</div>
            <div class="small" id="effectiveTax">Tax rate: -</div>
          </div>
          <div class="card">
            <div class="label">Transactions</div>
            <div class="value" id="totalTx">-</div>
            <div class="small" id="avgNetTx">Avg net/tx: -</div>
          </div>
          <div class="card">
            <div class="label">Covers</div>
            <div class="value" id="totalCovers">-</div>
            <div class="small" id="avgCoversTx">Covers/tx: -</div>
          </div>
          <div class="card">
            <div class="label">Last 7 Days</div>
            <div class="value" id="weekNet">-</div>
            <div class="small" id="weekGross">Gross: -</div>
            <div class="small" id="weekRange">Range: -</div>
          </div>
          <div class="card">
            <div class="label">Last 30 Days</div>
            <div class="value" id="monthNet">-</div>
            <div class="small" id="monthGross">Gross: -</div>
            <div class="small" id="monthRange">Range: -</div>
          </div>
        </div>

        <div class="meta">
          <div class="chip" id="avgGrossTx">Avg gross/tx: -</div>
          <div class="chip" id="avgNetCover">Avg net/cover: -</div>
          <div class="chip" id="avgGrossCover">Avg gross/cover: -</div>
          <div class="chip" id="rowsCount">Rows: -</div>
          <div class="chip" id="blids">BLIDs: -</div>
          <div class="chip" id="timeZone">TZ: -</div>
          <div class="chip" id="range">Range: -</div>
          <div class="chip" id="fetchRange">Fetch range: -</div>
          <div class="chip" id="generatedAt">Generated: -</div>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Cost Center</th>
              <th>Net</th>
              <th>Gross</th>
              <th>Delta</th>
              <th>Tax %</th>
              <th>Tx</th>
              <th>Covers</th>
              <th>Covers/Tx</th>
              <th>Avg Net/Tx</th>
              <th>Avg Gross/Tx</th>
              <th>Avg Net/Cover</th>
              <th>Avg Gross/Cover</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>
      <div class="status" id="status">Ready.</div>

      <section class="guide" id="howGuide">
        <div class="guide-head">
          <div>
            <h2>How It Works</h2>
            <p class="guide-sub">This application demonstrates how Lightspeed (K-Series POS) integrates with a backend service to fetch and calculate daily revenue.</p>
          </div>
          <button id="guidePlay" class="guide-play" type="button">Play Tour</button>
        </div>

        <div class="guide-progress" aria-hidden="true">
          <div class="guide-progress-bar" id="guideProgressBar"></div>
        </div>
        <div class="guide-nav" id="guideNav"></div>

        <article class="guide-view">
          <div class="guide-kicker" id="guideKicker">Step 1 of 7</div>
          <h3 id="guideTitle">-</h3>
          <p id="guideBody">-</p>
          <div class="guide-actions">
            <button id="guidePrev" class="guide-btn" type="button">Previous</button>
            <button id="guideNext" class="guide-btn" type="button">Next</button>
          </div>
        </article>

        <div class="guide-notes">
          <h3>Important Notes</h3>
          <ul>
            <li>This flow runs in read-only mode (no data is written back).</li>
            <li>Lightspeed uses business days, which may differ from calendar days.</li>
            <li>Revenue values are calculated from raw transaction data, not directly provided as a single number.</li>
          </ul>
        </div>

        <p class="guide-summary"><strong>Summary:</strong> This application acts as a bridge between Lightspeed POS data and a custom analytics layer, transforming raw transaction data into meaningful daily revenue metrics.</p>

        <div class="guide-legend">
          Quick API check: <code>curl -s "http://localhost:8787/api/revenue?daysPast=0&daysFuture=0&skipIncompleteDays=false"</code>
        </div>
      </section>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      const statusEl = $("status");
      const tbody = $("tbody");
      const fmt = (n) => Number(n || 0).toFixed(2);
      const pct = (n) => n == null ? "-" : Number(n).toFixed(2) + "%";
      const val = (n) => n == null ? "-" : fmt(n);
      const guideSteps = [
        {
          label: "POS Orders",
          title: "Orders are created on the Lightspeed POS (iPad).",
          bodyHtml:
            "Staff use the POS to take orders and process payments in the restaurant.",
        },
        {
          label: "Cloud Sync",
          title: "All data is stored in the Lightspeed Cloud.",
          bodyHtml:
            "Every transaction (sales, payments, taxes) is automatically synced to Lightspeed's backend system.",
        },
        {
          label: "OAuth Access",
          title: "The application connects to the Lightspeed API.",
          bodyHtml:
            "It uses OAuth authentication (refresh token to access token) to securely access the data.",
        },
        {
          label: "Location Financials",
          title: "The system retrieves financial data for a specific business location.",
          bodyHtml:
            "Using the businessLocationId, it fetches daily sales data from <code>/f/finance/{businessLocationId}/dailyFinancials</code>.",
        },
        {
          label: "Processing",
          title: "The application processes raw sales data.",
          bodyHtml:
            "It filters out cancelled or voided items and calculates net revenue (excluding tax), gross revenue (including tax), and number of transactions.",
        },
        {
          label: "Local API",
          title: "The result is exposed through a local API.",
          bodyHtml:
            "The backend provides <code>/api/revenue</code> and returns computed revenue values.",
        },
        {
          label: "Frontend View",
          title: "The frontend displays the results.",
          bodyHtml:
            "The user can request revenue for a specific day and see calculated values in real time.",
        },
      ];

      let guideIndex = 0;
      let guideTimer = null;

      const setGuideStep = (nextIndex) => {
        const guideTitleEl = $("guideTitle");
        const guideBodyEl = $("guideBody");
        const guideKickerEl = $("guideKicker");
        const guideProgressBarEl = $("guideProgressBar");
        const guideNavEl = $("guideNav");
        if (!guideTitleEl || !guideBodyEl || !guideKickerEl || !guideProgressBarEl || !guideNavEl) {
          return;
        }

        const total = guideSteps.length;
        guideIndex = ((nextIndex % total) + total) % total;
        const step = guideSteps[guideIndex];

        guideKickerEl.textContent = "Step " + (guideIndex + 1) + " of " + total;
        guideTitleEl.textContent = step.title;
        guideBodyEl.innerHTML = step.bodyHtml;
        guideProgressBarEl.style.width = ((guideIndex + 1) / total * 100).toFixed(1) + "%";

        const tabs = guideNavEl.querySelectorAll(".guide-tab");
        tabs.forEach((tab, idx) => {
          tab.classList.toggle("active", idx === guideIndex);
        });
      };

      const stopGuideTour = () => {
        if (guideTimer) {
          clearInterval(guideTimer);
          guideTimer = null;
        }
        const guidePlayEl = $("guidePlay");
        if (guidePlayEl) {
          guidePlayEl.textContent = "Play Tour";
        }
      };

      const startGuideTour = () => {
        stopGuideTour();
        const guidePlayEl = $("guidePlay");
        if (guidePlayEl) {
          guidePlayEl.textContent = "Stop Tour";
        }
        guideTimer = setInterval(() => {
          setGuideStep(guideIndex + 1);
        }, 2500);
      };

      const initGuide = () => {
        const guideNavEl = $("guideNav");
        const guidePlayEl = $("guidePlay");
        const guidePrevEl = $("guidePrev");
        const guideNextEl = $("guideNext");
        if (!guideNavEl) return;

        guideNavEl.innerHTML = "";
        guideSteps.forEach((step, idx) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "guide-tab";
          btn.textContent = (idx + 1) + ". " + step.label;
          btn.addEventListener("click", () => {
            stopGuideTour();
            setGuideStep(idx);
          });
          guideNavEl.appendChild(btn);
        });

        if (guidePlayEl) {
          guidePlayEl.addEventListener("click", () => {
            if (guideTimer) {
              stopGuideTour();
              return;
            }
            startGuideTour();
          });
        }

        if (guidePrevEl) {
          guidePrevEl.addEventListener("click", () => {
            stopGuideTour();
            setGuideStep(guideIndex - 1);
          });
        }

        if (guideNextEl) {
          guideNextEl.addEventListener("click", () => {
            stopGuideTour();
            setGuideStep(guideIndex + 1);
          });
        }

        setGuideStep(0);
      };

      async function fetchRevenueDetails() {
        const daysPast = $("daysPast").value;
        const daysFuture = $("daysFuture").value;
        const skipIncompleteDays = $("skipIncomplete").value;
        const qp = new URLSearchParams({ daysPast, daysFuture, skipIncompleteDays });

        statusEl.textContent = "Loading...";
        tbody.innerHTML = "";

        try {
          const started = performance.now();
          const res = await fetch("/api/revenue?" + qp.toString());
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Request failed");
          const tookMs = Math.round(performance.now() - started);

          $("totalNet").textContent = fmt(data.totalNetRevenue);
          $("totalGross").textContent = fmt(data.totalGrossRevenue);
          $("totalDelta").textContent = fmt(data.totalGrossMinusNet);
          $("effectiveTax").textContent = "Tax rate: " + pct(data.effectiveTaxRateTotalPct);
          $("totalTx").textContent = fmt(data.totalTransactions);
          $("totalCovers").textContent = fmt(data.totalCovers);
          $("avgNetTx").textContent = "Avg net/tx: " + val(data.averageNetPerTransaction);
          $("avgCoversTx").textContent = "Covers/tx: " + val(data.averageCoversPerTransaction);
          $("avgGrossTx").textContent = "Avg gross/tx: " + val(data.averageGrossPerTransaction);
          $("avgNetCover").textContent = "Avg net/cover: " + val(data.averageNetPerCover);
          $("avgGrossCover").textContent = "Avg gross/cover: " + val(data.averageGrossPerCover);
          $("weekNet").textContent = fmt(data.week?.totalNetRevenue);
          $("weekGross").textContent = "Gross: " + val(data.week?.totalGrossRevenue);
          $("weekRange").textContent = "Range: " + (data.week?.startDate || "-") + " .. " + (data.week?.endDate || "-");
          $("monthNet").textContent = fmt(data.month?.totalNetRevenue);
          $("monthGross").textContent = "Gross: " + val(data.month?.totalGrossRevenue);
          $("monthRange").textContent = "Range: " + (data.month?.startDate || "-") + " .. " + (data.month?.endDate || "-");
          $("rowsCount").textContent = "Rows: " + data.rows;
          $("blids").textContent = "BLIDs: " + data.businessLocationIds.join(", ");
          $("timeZone").textContent = "TZ: " + data.timeZone;
          $("range").textContent = "Range: " + data.query.startDate + " .. " + data.query.endDate;
          $("fetchRange").textContent = "Fetch range: " + data.query.fetchStartDate + " .. " + data.query.fetchEndDate;
          $("generatedAt").textContent = "Generated: " + new Date(data.generatedAtUtc).toLocaleString();

          for (const row of data.items) {
            const tr = document.createElement("tr");
            tr.innerHTML =
              "<td>" + row.date + "</td>" +
              "<td><strong>" + row.costCenter + "</strong></td>" +
              "<td>" + fmt(row.netRevenue) + "</td>" +
              "<td>" + fmt(row.grossRevenue) + "</td>" +
              "<td>" + fmt(row.grossMinusNet) + "</td>" +
              "<td>" + pct(row.effectiveTaxRatePct) + "</td>" +
              "<td>" + fmt(row.transactions) + "</td>" +
              "<td>" + fmt(row.covers) + "</td>" +
              "<td>" + val(row.coversPerTransaction) + "</td>" +
              "<td>" + val(row.avgNetPerTransaction) + "</td>" +
              "<td>" + val(row.avgGrossPerTransaction) + "</td>" +
              "<td>" + val(row.avgNetPerCover) + "</td>" +
              "<td>" + val(row.avgGrossPerCover) + "</td>" +
              "<td>" + row.category + "</td>";
            tbody.appendChild(tr);
          }

          if (data.items.length === 0) {
            const tr = document.createElement("tr");
            tr.innerHTML = "<td colspan='14'>No rows returned</td>";
            tbody.appendChild(tr);
          }

          statusEl.textContent = "Updated in " + tookMs + " ms";
        } catch (err) {
          statusEl.textContent = "Error: " + (err?.message || String(err));
        }
      }

      initGuide();
      $("loadBtn").addEventListener("click", fetchRevenueDetails);
      fetchRevenueDetails();
    </script>
  </body>
</html>
`;

const stableWebTokenCachePath = path.resolve(
  process.cwd(),
  process.env.LSK_TOKEN_CACHE_PATH || ".lightspeed-token-web.json"
);
const revenueResponseCache = new Map<
  string,
  { expiresAt: number; payload: Record<string, any> }
>();
const inflightRevenueRequests = new Map<string, Promise<Record<string, any>>>();

const pruneRevenueCache = (nowMs: number) => {
  for (const [key, entry] of revenueResponseCache.entries()) {
    if (entry.expiresAt <= nowMs) {
      revenueResponseCache.delete(key);
    }
  }
};

const runRevenueFetchRaw = async (query: NormalizedRevenueQuery) => {
  const clientId = getRequiredEnv("LSK_CLIENT_ID");
  const clientSecret = getRequiredEnv("LSK_CLIENT_SECRET");
  const refreshToken = getRequiredEnv("LSK_REFRESH_TOKEN");
  const redirectUri = getRequiredEnv("LSK_REDIRECT_URI");
  const businessLocationIds = parseBusinessLocationIds();

  const timeZone = process.env.LSK_TIME_ZONE || "Europe/Zurich";
  const { daysPast, daysFuture, skipIncompleteDays } = query;

  const rangeStart = dayjs()
    .tz(timeZone)
    .subtract(daysPast, "day")
    .format("YYYY-MM-DD");
  const rangeEnd = dayjs()
    .tz(timeZone)
    .add(daysFuture, "day")
    .format("YYYY-MM-DD");
  const todayDate = dayjs().tz(timeZone).format("YYYY-MM-DD");
  const minimumDaysPastForAutoPeriods = 30;
  const fetchDaysPast = Math.max(daysPast, minimumDaysPastForAutoPeriods);
  const fetchDaysFuture = daysFuture;
  const fetchRangeStart = dayjs()
    .tz(timeZone)
    .subtract(fetchDaysPast, "day")
    .format("YYYY-MM-DD");
  const fetchRangeEnd = dayjs()
    .tz(timeZone)
    .add(fetchDaysFuture, "day")
    .format("YYYY-MM-DD");

  const source: LightspeedSourceConfig = {
    name: "lightspeed-kseries-web",
    type: "lightspeed",
    enabled: true,
    ignoredMissingCostCenters: [],
    autoCreateMetricType: false,
    metricTypeCategory: "Ist",
    mergeMetricTypes: { enabled: false, name: "Umsatz" },
    metricTypeMappings: [],
    costCenterMappingField: "name",
    environment: "demo",
    authVersion: "v2",
    clientId,
    clientSecret,
    refreshToken,
    redirectUri,
    businessLocationIds,
    costCenterFrom: "id",
    daysPast: fetchDaysPast,
    daysFuture: fetchDaysFuture,
    salesFetchMode: "daily",
    skipIncompleteDays,
    tokenCachePath: stableWebTokenCachePath,
    outputs: [
      {
        enabled: true,
        kind: "revenue",
        metricType: METRIC_NET,
        metricTypeCategory: "Ist",
        revenueType: "net",
        includeServiceCharge: false,
        includeVoidedLines: false,
      },
      {
        enabled: true,
        kind: "revenue",
        metricType: METRIC_GROSS,
        metricTypeCategory: "Ist",
        revenueType: "gross",
        includeServiceCharge: false,
        includeVoidedLines: false,
      },
      {
        enabled: true,
        kind: "transactions",
        metricType: METRIC_TX,
        metricTypeCategory: "Ist",
        saleTypesToInclude: ["SALE", "REFUND"],
      },
      {
        enabled: true,
        kind: "covers",
        metricType: METRIC_COVERS,
        metricTypeCategory: "Ist",
      },
    ],
  };

  logger.info(
    `[lightspeed-web] Fetching details: locationIds=${businessLocationIds.join(",")} requestedDaysPast=${daysPast} requestedDaysFuture=${daysFuture} fetchDaysPast=${fetchDaysPast} fetchDaysFuture=${fetchDaysFuture} skipIncompleteDays=${skipIncompleteDays}`
  );

  const metrics = await withTimeout(
    importFromLightspeed(source, timeZone),
    getRevenueRequestTimeoutMs(),
    "Lightspeed import"
  );
  const details = summarizeRevenueDetails(metrics, timeZone);
  const itemsInRequestedRange = details.rows.filter(
    (row) => row.date >= rangeStart && row.date <= rangeEnd
  );
  const requestedSummary = aggregateRevenueRows(itemsInRequestedRange);
  const weekSummary = summarizeWindowRows(
    details.rows,
    dayjs().tz(timeZone).subtract(6, "day").format("YYYY-MM-DD"),
    todayDate
  );
  const monthSummary = summarizeWindowRows(
    details.rows,
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
    week: weekSummary,
    month: monthSummary,
    skipIncompleteDays,
    items: itemsInRequestedRange,
  };
};

const runRevenueFetch = async (params: URLSearchParams) => {
  const query = normalizeRevenueQuery(params);
  const cacheKey = getRevenueCacheKey(query);
  const nowMs = Date.now();
  const cacheTtlMs = getRevenueCacheTtlMs();
  pruneRevenueCache(nowMs);

  const cached = revenueResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return cached.payload;
  }

  const inflight = inflightRevenueRequests.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const requestPromise = runRevenueFetchRaw(query)
    .then((payload) => {
      if (cacheTtlMs > 0) {
        revenueResponseCache.set(cacheKey, {
          expiresAt: Date.now() + cacheTtlMs,
          payload,
        });
      }
      return payload;
    })
    .finally(() => {
      inflightRevenueRequests.delete(cacheKey);
    });

  inflightRevenueRequests.set(cacheKey, requestPromise);
  return requestPromise;
};

preloadEnv();
const desiredPort = parseNumber(process.env.LSK_WEB_PORT, 8787);
const assetsDir = path.resolve(process.cwd(), "assets");

const getContentTypeByPath = (filePath: string): string => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
};

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const reqUrl = req.url || "/";
  const host = req.headers.host || `localhost:${desiredPort}`;
  const url = new URL(reqUrl, `http://${host}`);

  if (method === "GET" && url.pathname.startsWith("/assets/")) {
    try {
      const relPath = url.pathname.replace(/^\/assets\//, "");
      const absolutePath = path.resolve(assetsDir, relPath);

      if (!absolutePath.startsWith(`${assetsDir}${path.sep}`)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Asset not found" }));
        return;
      }

      const content = fs.readFileSync(absolutePath);
      res.writeHead(200, {
        "Content-Type": getContentTypeByPath(absolutePath),
        "Cache-Control": "public, max-age=3600",
      });
      res.end(content);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown asset error";
      logger.error(`[lightspeed-web] Asset serve failed: ${message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Asset serve failed" }));
      return;
    }
  }

  if (method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === "GET" && url.pathname === "/api/revenue") {
    try {
      const payload = await runRevenueFetch(url.searchParams);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`[lightspeed-web] Revenue fetch failed: ${message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 120_000;
server.on("clientError", (error, socket) => {
  logger.warn(`[lightspeed-web] clientError: ${error.message}`);
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
});

process.on("uncaughtException", (error) => {
  logger.error(`[lightspeed-web] uncaughtException: ${error.stack || error.message}`);
});
process.on("unhandledRejection", (reason) => {
  const message =
    reason instanceof Error ? reason.stack || reason.message : JSON.stringify(reason);
  logger.error(`[lightspeed-web] unhandledRejection: ${message}`);
});

const listenWithRetry = (port: number, attemptsLeft: number) => {
  const onListening = () => {
    server.off("error", onError);
    const address = server.address();
    const actualPort =
      typeof address === "object" && address?.port ? address.port : port;
    logger.info(
      `[lightspeed-web] Revenue preview page started: http://localhost:${actualPort}`
    );
  };

  const onError = (error: NodeJS.ErrnoException) => {
    server.off("listening", onListening);
    if (error?.code === "EADDRINUSE" && attemptsLeft > 0) {
      const nextPort = port + 1;
      logger.warn(
        `[lightspeed-web] Port ${port} is busy, retrying on ${nextPort}...`
      );
      setTimeout(() => listenWithRetry(nextPort, attemptsLeft - 1), 50);
      return;
    }

    logger.error(
      `[lightspeed-web] Failed to start server on port ${port}: ${error?.message || "unknown error"}`
    );
    process.exit(1);
  };

  server.once("listening", onListening);
  server.once("error", onError);
  server.listen(port);
};

listenWithRetry(desiredPort, 10);
