import { getEnvVar, type AppConfig, type SOURCE } from "../config";

export const appConfigBindella: AppConfig = {
  isDryRun: true,
  sources: {
    activeSource: getEnvVar("SOURCE") as SOURCE | undefined,
    csv: {
      filePath: "/home/sftp-bindella-user-1/uploads/JD_Umsatz_Gastro.csv",
      // filePath: "JD_Umsatz_Gastro_ab010124.csv",
      importColumns: ["date", "costCenter", "metricType", "value", "tax"],
      transformColumns: [
        {
          outputColumn: "value",
          operation: "add",
          operands: ["value", "tax"],
        },
      ],
      dateFormat: "DD.MM.YYYY",
    },
    snowflake: {
      account: null,
      username: null,
      password: null,
      database: null,
      schema: null,
      warehouse: null,
      role: null,
      daysPast: 7,
      daysFuture: 0,
      query: `
    SELECT
        ...
          `,
    },
  },
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: {
    enabled: true,
    name: "Umsatz",
  },
  metricTypeMappings: [
    {
      importName: "Verkauf Bier",
      jobdoneName: "Bier",
    },
    {
      importName: "Verkauf Kaffee/Tee/Ovo",
      jobdoneName: "Kaffee/Tee/Ovo",
    },
    {
      importName: "Verkauf Küche",
      jobdoneName: "Küche",
    },
    {
      importName: "Verkauf Mineralwasser",
      jobdoneName: "Mineralwasser",
    },
    {
      importName: "Verkauf Pizza",
      jobdoneName: "Pizza",
    },
    {
      importName: "Verkauf Spirituosen/Liq.",
      jobdoneName: "Spirituosen/Liq.",
    },
    {
      importName: "Verkauf Vinoteca",
      jobdoneName: "Vinoteca",
    },
    {
      importName: "Verkauf Weine",
      jobdoneName: "Weine",
    },
  ],
};
