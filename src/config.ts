import { appConfigBindella } from "./configs/bindella";
import { appConfigFWG } from "./configs/fwg";
import { appConfigDamnDelicious } from "./configs/damn-delicious";
import { appConfigHotelMonopol } from "./configs/hotel-monopol";
import { appConfigSmallFoot } from "./configs/small-foot";
import { appConfigAstroFries } from "./configs/astro-fries";

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
  const configFile = getEnvVar("JOBDONE_ORGANIZATION_NAME", true);
  switch (configFile) {
    case "Bindella":
      return appConfigBindella;
    case "FWG":
      return appConfigFWG;
    case "Hotel Monopol":
      return appConfigHotelMonopol;
    case "seerose":
      return appConfigDamnDelicious;
    case "weisses-roessli":
      return appConfigDamnDelicious;
    case "coffee-and-plants":
      return appConfigDamnDelicious;
    case "small Foot":
      return appConfigSmallFoot;
    case "astro-fries":
      return appConfigAstroFries;
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
  | "clock"
  | "hellotess"
  | "taginet"
  | "email";

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
   * Field to use for cost center mapping: 'name' (default), 'customId', or 'customId2'.
   */
  costCenterMappingField: "name" | "customId" | "customId2";
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
  ageWeightThresholdMonths: number;
  youngChildWeight: number;
  olderChildWeight: number;
  costCenterMapping?: Record<string, string>;
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

export type SourceConfigType =
  | CSVSourceConfig
  | SnowflakeSourceConfig
  | ClockSourceConfig
  | HelloTESSSourceConfig
  | TagiNetSourceConfig
  | EmailSourceConfig;

export interface AppConfig {
  sources: SourceConfigType[];
  diskFreeSpaceThresholdInPercent: number;
  timeZone: string;
}
