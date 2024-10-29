import { appConfigBindella } from "./configs/bindella";
import { appConfigFWG } from "./configs/fwg";
import { appConfigHotelMonopol } from "./configs/hotel-monopol";

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
    default:
      throw new Error(`Unknown config file: ${configFile}`);
  }
}

export const appEnvironment = {
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
    //   bearerToken: getEnvVar("JOBDONE_BEARER_TOKEN"),
    //   accessKey: getEnvVar("JOBDONE_ACCESS_KEY"),
    //   rawSecret: getEnvVar("JOBDONE_RAW_SECRET"),
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

export enum SOURCE {
  CSV = "csv",
  SNOWFLAKE = "snowflake",
  CLOCK = "clock",
}

export interface TransformColumn {
  outputColumn: string;
  operation: "add" | "subtract";
  operands: string[];
}

export interface SourceConfig {
  activeSource: SOURCE | undefined;
  csv?: {
    filePath: string;
    importColumns: string[];
    transformColumns: TransformColumn[];
    dateFormat: string;
  };
  snowflake?: {
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
  };
  clock?: {
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
  };
}

export interface MergeMetricTypesConfig {
  enabled: boolean;
  name: string;
}

export interface MetricTypeMapping {
  importName: string;
  jobdoneName: string;
}

export interface AppConfig {
  isDryRun: boolean;
  sources: SourceConfig;
  diskFreeSpaceThresholdInPercent: number;
  timeZone: string;
  ignoredMissingCostCenters: string[]; // Now typed as string[]
  autoCreateMetricType: boolean;
  mergeMetricTypes: MergeMetricTypesConfig;
  metricTypeMappings: MetricTypeMapping[];
}
