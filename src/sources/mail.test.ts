import { describe, expect, it } from "bun:test";
import type { ParsedMail } from "mailparser";
import { extractMetricsFromEmailAttachments } from "./mail";
import type { EmailSourceConfig } from "../config";

const makeEmailSource = (): EmailSourceConfig => ({
  name: "mail-source",
  type: "email",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: { enabled: true, name: "Umsatz" },
  metricTypeMappings: [],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  host: "imap.test",
  port: 993,
  secure: true,
  username: "reports@test.com",
  password: "app-password",
  subjectFilter: "Report",
  attachmentNamePattern: ".*\\.csv$",
  dateExtractionRegex: ".*_(\\d{8})_.*\\.csv$",
  dateFormat: "YYYYMMDD",
  daysPast: 7,
  skipHeader: true,
  valueCell: { column: 3, row: 2 },
  costCenterCell: { column: 1, row: 2 },
});

const buildParsedMail = (filename: string, csvContent: string): ParsedMail =>
  ({
    attachments: [
      {
        type: "attachment",
        content: Buffer.from(csvContent, "utf-8"),
        contentType: "text/csv",
        contentDisposition: "attachment",
        filename,
        headers: new Map(),
        headerLines: [],
        checksum: "",
        size: 1,
        related: false,
      } as any,
    ],
    headers: new Map(),
    headerLines: [],
    html: false,
  }) as ParsedMail;

describe("mail source attachment extraction", () => {
  it("returns empty when no attachments are present", () => {
    const parsed = {
      attachments: [],
      headers: new Map(),
      headerLines: [],
      html: false,
    } as ParsedMail;

    const metrics = extractMetricsFromEmailAttachments(
      parsed,
      makeEmailSource(),
      "Europe/Zurich"
    );
    expect(metrics).toEqual([]);
  });

  it("skips attachment when filename pattern does not match", () => {
    const parsed = buildParsedMail(
      "report_20250101_20250102.txt",
      "costCenter,desc,value\ncc-1,x,20\n"
    );
    const metrics = extractMetricsFromEmailAttachments(
      parsed,
      makeEmailSource(),
      "Europe/Zurich"
    );
    expect(metrics).toEqual([]);
  });

  it("extracts metric with date and configured cells", () => {
    const parsed = buildParsedMail(
      "restaurant_product_breakdown_20250101_20250102.csv",
      "costCenter,desc,value\ncc-1,x,20\n"
    );
    const metrics = extractMetricsFromEmailAttachments(
      parsed,
      makeEmailSource(),
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "cc-1",
      value: "20",
      metricType: "Umsatz",
      metricTypeCategory: "Ist",
    });
  });

  it("skips attachment when date cannot be extracted from filename", () => {
    const parsed = buildParsedMail(
      "restaurant_product_breakdown_no-date.csv",
      "costCenter,desc,value\ncc-1,x,20\n"
    );
    const metrics = extractMetricsFromEmailAttachments(
      parsed,
      makeEmailSource(),
      "Europe/Zurich"
    );
    expect(metrics).toEqual([]);
  });

  it("skips attachment when csv does not contain configured cells", () => {
    const parsed = buildParsedMail(
      "restaurant_product_breakdown_20250101_20250102.csv",
      "header-only\n"
    );
    const metrics = extractMetricsFromEmailAttachments(
      parsed,
      makeEmailSource(),
      "Europe/Zurich"
    );
    expect(metrics).toEqual([]);
  });

  it("uses metricType mapping when merge is disabled", () => {
    const source = makeEmailSource();
    source.mergeMetricTypes.enabled = false;
    source.metricTypeMappings = [{ importName: "Umsatz", jobdoneName: "RevenueMapped" }];

    const parsed = buildParsedMail(
      "restaurant_product_breakdown_20250101_20250102.csv",
      "costCenter,desc,value\ncc-1,x,20\n"
    );
    const metrics = extractMetricsFromEmailAttachments(
      parsed,
      source,
      "Europe/Zurich"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0].metricType).toBe("RevenueMapped");
  });

  it("skips rows with missing cost center/value cells", () => {
    const parsed = buildParsedMail(
      "restaurant_product_breakdown_20250101_20250102.csv",
      "costCenter,desc,value\n,x,\n"
    );
    const metrics = extractMetricsFromEmailAttachments(
      parsed,
      makeEmailSource(),
      "Europe/Zurich"
    );
    expect(metrics).toEqual([]);
  });
});
