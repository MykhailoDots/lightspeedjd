import type { AppConfig, CSVSourceConfig } from "../config";

export const appConfigBindella: AppConfig = {
  sources: [
    {
      name: "gastro_sales",
      type: "csv",
      enabled: true,
      ignoredMissingCostCenters: [],
      autoCreateMetricType: false,
      metricTypeCategory: "Ist",
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
      filePath: "/home/sftp-bindella-user-1/uploads/JD_Umsatz_Gastro.csv",
      // filePath: "JD_Umsatz_Gastro.csv",
      importColumns: ["date", "costCenter", "metricType", "value", "tax"],
      transformColumns: [
        {
          outputColumn: "value",
          operation: "add",
          operands: ["value", "tax"],
        },
      ],
      dateFormat: "DD.MM.YYYY",
    } satisfies CSVSourceConfig,
  ],
  diskFreeSpaceThresholdInPercent: 20,
  timeZone: "Europe/Zurich",
};
