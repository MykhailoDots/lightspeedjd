import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import { applyTransformations, importFromCsv, parseCsv } from "./csv";
import type { CSVSourceConfig } from "../config";

const tmpFiles: string[] = [];

const makeCsvConfig = (filePath: string): CSVSourceConfig => ({
  name: "csv-source",
  type: "csv",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: {
    enabled: false,
    name: "Umsatz",
  },
  metricTypeMappings: [{ importName: "RevenueRaw", jobdoneName: "Umsatz" }],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  filePath,
  importColumns: ["date", "costCenter", "metricType", "value", "extra"],
  transformColumns: [],
  dateFormat: "YYYY-MM-DD",
});

afterEach(() => {
  for (const filePath of tmpFiles) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  tmpFiles.length = 0;
});

describe("csv source", () => {
  it("applies add/subtract transformations", () => {
    const rows = [{ one: "2", two: "3", three: "10" }];
    const out = applyTransformations(
      rows,
      [
        { outputColumn: "sum", operation: "add", operands: ["one", "two"] },
        { outputColumn: "diff", operation: "subtract", operands: ["three", "one"] },
      ],
      "csv-source"
    );

    expect(out[0]).toMatchObject({
      sum: "5.00",
      diff: "8.00",
    });
  });

  it("parses csv file and maps core columns", async () => {
    const filePath = path.join(process.cwd(), "tmp-csv-source-1.csv");
    tmpFiles.push(filePath);
    fs.writeFileSync(
      filePath,
      "2025-01-05,cc-1,RevenueRaw,12.5,foo\n"
    );

    const config = makeCsvConfig(filePath);
    const parsed = await parseCsv(config);

    expect(parsed).toEqual([
      {
        date: "2025-01-05",
        costCenter: "cc-1",
        metricType: "RevenueRaw",
        value: "12.5",
      },
    ]);
  });

  it("imports from csv and applies metric type mapping", async () => {
    const filePath = path.join(process.cwd(), "tmp-csv-source-2.csv");
    tmpFiles.push(filePath);
    fs.writeFileSync(
      filePath,
      "2025-01-05,cc-1,RevenueRaw,12.5,foo\n"
    );

    const config = makeCsvConfig(filePath);
    const imported = await importFromCsv(config, "Europe/Zurich");

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      costCenter: "cc-1",
      metricType: "Umsatz",
      value: "12.5",
      metricTypeCategory: "Ist",
    });
    expect(imported[0].timestampCompatibleWithGranularity).toContain("2025-01-");
  });
});
