function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not defined`);
  }
  return value;
}

export const appConfig = {
  app: {
    cron: {
      // every 15min
      schedule: "*/15 * * * *",
    },
    isDryRun: false,
    diskFreeSpaceThresholdInPercent: 20,
    filePath: "/home/sftp-bindella-user-1/uploads/JD_Umsatz_Gastro.csv",
    timeZone: "Europe/Zurich",
    autoCreateMetricType: false,
    importColumns: ["date", "costCenter", "metricType", "value"],
    dateFormat: "DD.MM.YYYY",
    mergeMetricTypes: {
      enabled: true,
      name: "Umsatz",
      targetField: "actual",
    },
    metricTypeMappings: [
      {
        importName: "Verkauf Bier",
        jobdoneName: "Bier",
        targetField: "actual",
      },
      {
        importName: "Verkauf Kaffee/Tee/Ovo",
        jobdoneName: "Kaffee/Tee/Ovo",
        targetField: "actual",
      },
      {
        importName: "Verkauf Küche",
        jobdoneName: "Küche",
        targetField: "actual",
      },
      {
        importName: "Verkauf Mineralwasser",
        jobdoneName: "Mineralwasser",
        targetField: "actual",
      },
      {
        importName: "Verkauf Pizza",
        jobdoneName: "Pizza",
        targetField: "actual",
      },
      {
        importName: "Verkauf Spirituosen/Liq.",
        jobdoneName: "Spirituosen/Liq.",
        targetField: "actual",
      },
      {
        importName: "Verkauf Vinoteca",
        jobdoneName: "Vinoteca",
        targetField: "actual",
      },
      {
        importName: "Verkauf Weine",
        jobdoneName: "Weine",
        targetField: "actual",
      },
    ],
  },
  environment: {
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
  },
} as const;
