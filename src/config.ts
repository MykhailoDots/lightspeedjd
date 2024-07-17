function getEnvVar(name: string, isOptional = false): string {
  const value = process.env[name];
  if (!value && !isOptional) {
    throw new Error(`Environment variable ${name} is not defined`);
  }

  if (!value) {
    return "";
  }

  return value;
}

export const appEnvironment = {
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
}

export enum OPERATION {
  SUBTRACT = "subtract",
  ADD = "add",
}

const appConfigFWG = {
  isDryRun: false,
  sources: {
    activeSource: getEnvVar("SOURCE") as SOURCE | undefined,
    csv: {
      // filePath: "/home/sftp-bindella-user-1/uploads/JD_Umsatz_Gastro.csv",
      filePath: "Group by Day - Correct Table.csv",
      importColumns: ["date", "costCenter", "metricType", "value"],
      transformColumns: [
        // {
        //   outputColumn: "value",
        //   operation: OPERATION.ADD,
        //   operands: ["value", "tax"]
        // }
      ],
      dateFormat: "YYYY-MM-DD",
    },
    snowflake: {
      account: getEnvVar("SNOWFLAKE_ACCOUNT", true),
      username: getEnvVar("SNOWFLAKE_USER", true),
      password: getEnvVar("SNOWFLAKE_PASSWORD", true),
      database: getEnvVar("SNOWFLAKE_DATABASE", true),
      schema: getEnvVar("SNOWFLAKE_SCHEMA", true),
      warehouse: getEnvVar("SNOWFLAKE_WAREHOUSE", true),
      role: getEnvVar("SNOWFLAKE_ROLE", true),
      daysPast: 30,
      daysFuture: 0,
      query: `
SELECT
    RESTAURANTID AS costCenter,
    DATUM AS date,
    SUM(NETTOTAL_TOTALFC) AS value
FROM
    FACTTRANSAKTIONEN
WHERE
    DATUM BETWEEN '{fromDate}' AND '{toDate}'
GROUP BY
    RESTAURANTID,
    DATUM
ORDER BY
    RESTAURANTID,
    DATUM;
        `,
    },
  },
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
  autoCreateMetricType: false,
  mergeMetricTypes: {
    enabled: true,
    name: "Umsatz",
    targetField: "actual",
  },
  metricTypeMappings: [
    // {
    //   importName: "Verkauf Bier",
    //   jobdoneName: "Bier",
    //   targetField: "actual",
    // },
    // {
    //   importName: "Verkauf Kaffee/Tee/Ovo",
    //   jobdoneName: "Kaffee/Tee/Ovo",
    //   targetField: "actual",
    // },
    // {
    //   importName: "Verkauf Küche",
    //   jobdoneName: "Küche",
    //   targetField: "actual",
    // },
    // {
    //   importName: "Verkauf Mineralwasser",
    //   jobdoneName: "Mineralwasser",
    //   targetField: "actual",
    // },
    // {
    //   importName: "Verkauf Pizza",
    //   jobdoneName: "Pizza",
    //   targetField: "actual",
    // },
    // {
    //   importName: "Verkauf Spirituosen/Liq.",
    //   jobdoneName: "Spirituosen/Liq.",
    //   targetField: "actual",
    // },
    // {
    //   importName: "Verkauf Vinoteca",
    //   jobdoneName: "Vinoteca",
    //   targetField: "actual",
    // },
    // {
    //   importName: "Verkauf Weine",
    //   jobdoneName: "Weine",
    //   targetField: "actual",
    // },
  ],
} as const;

export const appConfigs = [appConfigFWG];