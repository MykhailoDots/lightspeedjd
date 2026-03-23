import { appConfigBindella } from "./configs/bindella";
import { appConfigFWG } from "./configs/fwg";
import { appConfigDamnDelicious } from "./configs/damn-delicious";
import { appConfigHotelMonopol } from "./configs/hotel-monopol";
import { appConfigSmallFoot } from "./configs/small-foot";
import { appConfigAstroFries } from "./configs/astro-fries";
import { appConfigRemimag } from "./configs/remimag";
import { appConfigTibits } from "./configs/tibits";
import { appConfigKusch } from "./configs/kusch";
import { appConfigSeerose } from "./configs/seerose";
import { appConfigLightspeedExample } from "./configs/lightspeed-example";

export function getEnvVar(name: string, isOptional = false): string {
  const value = process.env[name];
  if (!value && !isOptional) {
    throw new Error(`Environment variable ${name} is not defined`);
  }

  if (!value) {
    return "";
  }

  return value;
}

export function getAppConfig() {
  const configFile = getEnvVar("JOBDONE_ORGANIZATION_NAME", true)?.toLowerCase();
  switch (configFile) {
    case "bindella":
    case "Bindella":
      return appConfigBindella;
    case "fwg":
    case "FWG":
      return appConfigFWG;
    case "hotel-monopol":
    case "Hotel Monopol":
      return appConfigHotelMonopol;
    case "seerose":
      return appConfigSeerose;
    case "damn-delicious":
      return appConfigDamnDelicious;
    case "small-foot":
    case "small Foot":
      return appConfigSmallFoot;
    case "astro-fries":
      return appConfigAstroFries;
    case "remimag":
    case "Remimag":
      return appConfigRemimag;
    case "tibits":
    case "Tibits":
      return appConfigTibits;
    case "kusch":
    case "Kusch":
      return appConfigKusch;
    case "lightspeed-example":
      return appConfigLightspeedExample;
    default:
      throw new Error(`Unknown config file: ${configFile}`);
  }
}

export const appEnvironment = {
  isDryRun: getEnvVar("IS_DRY_RUN") === "false" ? false : true,
  cronTime: getEnvVar("CRON_TIME"),
  organization: {
    id: getEnvVar("JOBDONE_ORGANIZATION_ID"),
    name: getEnvVar("JOBDONE_ORGANIZATION_NAME"),
  },
  organizationUser: {
    id: getEnvVar("JOBDONE_ORGANIZATION_USER_ID"),
  },
  auth: {
    username: getEnvVar("JOBDONE_USERNAME"),
    password: getEnvVar("JOBDONE_PASSWORD"),
    authRegion: getEnvVar("JOBDONE_AUTH_REGION"),
    userPoolId: getEnvVar("JOBDONE_USER_POOL_ID"),
    userPoolWebClientId: getEnvVar("JOBDONE_USER_POOL_WEB_CLIENT_ID"),
  },
  graphql: {
    endpoint: getEnvVar("JOBDONE_GRAPHQL_ENDPOINT"),
    adminSecret: getEnvVar("JOBDONE_GRAPHQL_ADMIN_SECRET"),
  },
  client: {
    id: getEnvVar("JOBDONE_CLIENT_ID"),
    name: getEnvVar("JOBDONE_CLIENT_NAME"),
  },
  discord: {
    webhookUrl: getEnvVar("DISCORD_WEBHOOK_URL"),
  },
} as const;

export type SOURCE_TYPE =
  | "csv"
  | "snowflake"
  | "mssql"
  | "clock"
  | "hellotess"
  | "taginet"
  | "email"
  | "gmail"
  | "lightspeed"
  | "powerbi-sp"
  | "powerbi-delegated";

export interface TransformColumn {
  outputColumn: string;
  operation: "add" | "subtract";
  operands: string[];
}

export interface MetricTypeMapping {
  importName: string;
  jobdoneName: string;
}

export interface MergeMetricTypesConfig {
  enabled: boolean;
  name: string;
}

export interface BaseSourceConfig {
  name: string;
  type: SOURCE_TYPE;
  enabled: boolean;
  ignoredMissingCostCenters: string[];
  autoCreateMetricType: boolean;
  mergeMetricTypes: MergeMetricTypesConfig;
  metricTypeMappings: MetricTypeMapping[];
  metricTypeCategory: string;
  /**
   * Field to use for cost center mapping: 'name', 'customId', 'customId2', or 'customId3'.
   */
  costCenterMappingField: "name" | "customId" | "customId2" | "customId3";
  /**
   * Optional prefix length for matching cost centers (e.g. match "61" to "61100").
   */
  costCenterPrefixLength?: number;
  costCenterFanOut?: {
    mode: "mapping";
    mapping: Record<string, string[]>;
  };
}

export interface CSVSourceConfig extends BaseSourceConfig {
  type: "csv";
  filePath: string;
  importColumns: string[];
  transformColumns: TransformColumn[];
  dateFormat: string;
}

export interface SnowflakeSourceConfig extends BaseSourceConfig {
  type: "snowflake";
  account?: string | null;
  username?: string | null;
  password?: string | null;
  database?: string | null;
  schema?: string | null;
  warehouse?: string | null;
  role?: string | null;
  daysPast: number;
  daysFuture: number;
  query: string;
}

export interface MssqlSourceConfig extends BaseSourceConfig {
  type: "mssql";
  server: string;
  port?: number;
  database: string;
  username: string;
  password: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  daysPast: number;
  daysFuture: number;
  query: string;
}

export interface ClockSourceConfig extends BaseSourceConfig {
  type: "clock";
  costCenter: string | null;
  metricType: string | null;
  accountId: string | null;
  subscriptionId: string | null;
  subscriptionRegion: string | null;
  baseApi: string | null;
  apiUser: string | null;
  apiKey: string | null;
  isCacheEnabled: boolean;
  isDoNotDeleteCacheEnabled: boolean;
}

export interface HelloTESSSourceConfig extends BaseSourceConfig {
  type: "hellotess";
  apiKey: string;
  host: string;
  daysPast: number;
  daysFuture: number;
  storeId?: string;
  /**
   * Optional store name filter (case-insensitive).
   * Useful when multiple locations share the same helloTESS host/key.
   */
  storeNameFilter?: string;
  /**
   * Optional prefix to prepend to the store name when mapping cost centers.
   * Example: "kusch-" -> "kusch-Chamanna".
   */
  costCenterNamePrefix?: string;
  /**
   * Controls which helloTESS store field is used as metric.costCenter.
   * - "storeName" (default): invoice.location.store.name (+ optional prefix)
   * - "storeId": invoice.location.store.id
   */
  costCenterFrom?: "storeName" | "storeId";
  revenueType?: "net" | "gross"; // default is 'net' if not specified
  // Historical data import options
  historicalImport?: {
    enabled: boolean;
    startDate: string; // Format: YYYY-MM-DD
    batchSizeInDays?: number; // Number of days to fetch per API request
    rateLimitDelayMs?: number; // Delay between batch requests to avoid rate limits (default: 1000ms)
  };
}

export interface TagiNetSourceConfig extends BaseSourceConfig {
  type: "taginet";
  apiUrl: string;
  username: string;
  password: string;
  daysPast: number;
  daysFuture: number;
  costCenterMapping?: Record<string, string>;
  unweightedCostCenters?: string[];
}

export interface EmailSourceConfig extends BaseSourceConfig {
  type: "email";
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  subjectFilter: string;
  attachmentNamePattern: string;
  dateExtractionRegex: string;
  dateFormat: string;
  daysPast: number;
  skipHeader: boolean;
  valueCell: {
    column: number;
    row: number;
  };
  costCenterCell: {
    column: number;
    row: number;
  };
}

export interface GmailSourceConfig extends BaseSourceConfig {
  type: "gmail";
  username: string;
  password: string;
  host?: string;
  port?: number;
  secure?: boolean;
  subjectFilter: string;
  attachmentNamePattern: string;
  dateExtractionRegex: string;
  dateFormat: string;
  daysPast: number;
  skipHeader: boolean;
  valueCell: {
    column: number;
    row: number;
  };
  aliasBaseAddress?: string;
  orgIdSource?: "env";
  createLabelsIfMissing?: boolean;
}

export interface PowerBIServicePrincipalSourceConfig extends BaseSourceConfig {
  type: "powerbi-sp";
  tenantId: string;
  clientId: string;
  clientSecret: string;
  datasetId: string;
  groupId?: string;
  daxQuery: string; // use {fromDate} and {toDate} tokens for date filtering
  daysPast: number;
  daysFuture: number;
}

export interface PowerBIDelegatedSourceConfig extends BaseSourceConfig {
  type: "powerbi-delegated";
  tenantId: string;
  clientId: string;
  /**
   * UPN of the technical user that holds the Power BI Pro license and RLS roles.
   */
  userPrincipalName: string;
  /**
   * Optional custom cache file for the MSAL token cache.
   */
  tokenCachePath?: string;
  datasetId: string;
  groupId?: string;
  daxQuery: string;
  daysPast: number;
  daysFuture: number;
}

export type LightspeedEnvironment = "demo" | "prod";
export type LightspeedAuthVersion = "v1" | "v2";
export type LightspeedSalesFetchMode = "daily" | "range";
export type LightspeedCostCenterFrom = "id" | "name";

export type LightspeedMetricOutputKind =
  | "revenue"
  | "covers"
  | "transactions"
  | "laborHours";

export interface LightspeedMetricOutputBase {
  enabled: boolean;
  kind: LightspeedMetricOutputKind;
  /**
   * Metric type name as it should appear (or be mapped via metricTypeMappings).
   */
  metricType: string;
  /**
   * Overrides source.metricTypeCategory for this output.
   */
  metricTypeCategory?: string;
}

type LightspeedSaleType =
  | "SALE"
  | "VOID"
  | "RECALL"
  | "REFUND"
  | "SPLIT"
  | "UPDATE"
  | "TRANSFER"
  | "FLOAT"
  | "TRANSITORY"
  | "CROSS_BL"
  | "CANCEL";

export interface LightspeedRevenueOutput extends LightspeedMetricOutputBase {
  kind: "revenue";
  revenueType: "net" | "gross";
  includeServiceCharge?: boolean;
  saleTypesToInclude?: LightspeedSaleType[];
  includeVoidedLines?: boolean;
}

export interface LightspeedCoversOutput extends LightspeedMetricOutputBase {
  kind: "covers";
}

export interface LightspeedTransactionsOutput extends LightspeedMetricOutputBase {
  kind: "transactions";
  saleTypesToInclude?: LightspeedSaleType[];
}

export interface LightspeedLaborHoursOutput extends LightspeedMetricOutputBase {
  kind: "laborHours";
  roundingDecimals?: number;
}

export type LightspeedMetricOutput =
  | LightspeedRevenueOutput
  | LightspeedCoversOutput
  | LightspeedTransactionsOutput
  | LightspeedLaborHoursOutput;

export interface LightspeedSourceConfig extends BaseSourceConfig {
  type: "lightspeed";

  environment: LightspeedEnvironment;

  clientId: string;
  clientSecret: string;
  redirectUri: string;

  /**
   * Provide either refreshToken (preferred) or authorizationCode for bootstrap.
   */
  refreshToken?: string;
  authorizationCode?: string;

  /**
   * Optional: force auth version; otherwise inferred (devp-v2 => v2).
   */
  authVersion?: LightspeedAuthVersion;

  /**
   * Optional URL overrides (useful for sandbox).
   */
  apiBaseUrl?: string;
  authBaseUrl?: string;

  /**
   * Optional scopes to include when generating an auth URL (logging only).
   */
  scopes?: string[];

  /**
   * Optional token cache path (default: .lightspeed-token-<name>-<env>.json).
   */
  tokenCachePath?: string;

  businessLocationIds?: number[];

  /**
   * If provided, overrides costCenter derivation; keys are businessLocationId as string.
   * Value must match the field selected by costCenterMappingField.
   */
  costCenterByBusinessLocationId?: Record<string, string>;

  /**
   * When costCenterByBusinessLocationId is not set:
   *  - "name" uses Lightspeed business location name (default)
   *  - "id" uses businessLocationId as a string
   */
  costCenterFrom?: LightspeedCostCenterFrom;

  daysPast: number;
  daysFuture: number;

  salesFetchMode?: LightspeedSalesFetchMode;
  pageSize?: number;

  /**
   * If true, skip business days where FinancialV2 returns dataComplete=false.
   */
  skipIncompleteDays?: boolean;

  outputs: LightspeedMetricOutput[];
}

export type SourceConfigType =
  | CSVSourceConfig
  | SnowflakeSourceConfig
  | MssqlSourceConfig
  | ClockSourceConfig
  | HelloTESSSourceConfig
  | TagiNetSourceConfig
  | EmailSourceConfig
  | GmailSourceConfig
  | LightspeedSourceConfig
  | PowerBIServicePrincipalSourceConfig
  | PowerBIDelegatedSourceConfig;

export interface AppConfig {
  sources: SourceConfigType[];
  diskFreeSpaceThresholdInPercent: number;
  timeZone: string;
}
