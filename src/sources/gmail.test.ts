import { describe, it, expect } from "bun:test";
import type { ParsedMail, HeaderValue } from "mailparser";
import {
  analyzeRoutingFromRecipients,
  buildSearchCriteria,
  buildOrgCostCenterLabel,
  extractMetricsFromParsedMail,
  extractRecipientEmailsByPriority,
} from "./gmail";
import dayjs from "../helper/customDayJs";
import type { GmailSourceConfig } from "../config";

const BASE_ADDRESS = "reports@example.com";
const ORGANIZATION_ID = "11111111-1111-1111-1111-111111111111";

const makeGmailSource = (): GmailSourceConfig => ({
  name: "gmail-source",
  type: "gmail",
  enabled: true,
  ignoredMissingCostCenters: [],
  autoCreateMetricType: false,
  mergeMetricTypes: { enabled: false, name: "Umsatz" },
  metricTypeMappings: [{ importName: "Umsatz", jobdoneName: "UmsatzMapped" }],
  metricTypeCategory: "Ist",
  costCenterMappingField: "name",
  username: "reports@example.com",
  password: "app-password",
  subjectFilter: "Report",
  attachmentNamePattern: ".*\\.csv$",
  dateExtractionRegex: ".*_(\\d{8})_.*\\.csv$",
  dateFormat: "YYYYMMDD",
  daysPast: 7,
  skipHeader: true,
  valueCell: { column: 3, row: 2 },
});

describe("analyzeRoutingFromRecipients", () => {
  it("routes valid alias to org/costCenter label", () => {
    const result = analyzeRoutingFromRecipients(
      [`reports+${ORGANIZATION_ID}+cc001@example.com`],
      BASE_ADDRESS,
      ORGANIZATION_ID
    );

    expect(result.status).toBe("match");
    if (result.status !== "match") return;
    expect(result.costCenterId).toBe("cc001");
    expect(result.labelName).toBe(`${ORGANIZATION_ID}/cc001`);
  });

  it("ignores aliases for different organizations", () => {
    const result = analyzeRoutingFromRecipients(
      ["reports+22222222-2222-2222-2222-222222222222+cc001@example.com"],
      BASE_ADDRESS,
      ORGANIZATION_ID
    );

    expect(result.status).toBe("no-match");
  });

  it("rejects alias without cost center", () => {
    const result = analyzeRoutingFromRecipients(
      [`reports+${ORGANIZATION_ID}@example.com`],
      BASE_ADDRESS,
      ORGANIZATION_ID
    );

    expect(result.status).toBe("invalid-alias");
  });

  it("rejects conflicting aliases with different cost centers", () => {
    const result = analyzeRoutingFromRecipients(
      [
        `reports+${ORGANIZATION_ID}+cc001@example.com`,
        `reports+${ORGANIZATION_ID}+cc002@example.com`,
      ],
      BASE_ADDRESS,
      ORGANIZATION_ID
    );

    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.costCenterIds).toEqual(["cc001", "cc002"]);
  });

  it("matches case-insensitive recipient casing", () => {
    const result = analyzeRoutingFromRecipients(
      [`RePorTs+${ORGANIZATION_ID}+CC009@EXAMPLE.COM`],
      BASE_ADDRESS,
      ORGANIZATION_ID
    );

    expect(result.status).toBe("match");
    if (result.status !== "match") return;
    expect(result.costCenterId).toBe("CC009");
  });

  it("returns no-match when alias base address is invalid", () => {
    const result = analyzeRoutingFromRecipients(
      [`reports+${ORGANIZATION_ID}+cc001@example.com`],
      "invalid-base-address",
      ORGANIZATION_ID
    );

    expect(result.status).toBe("no-match");
  });
});

describe("extractRecipientEmailsByPriority", () => {
  it("extracts recipients in delivered-to, x-original-to, to order", () => {
    const parsedMail = {
      attachments: [],
      headers: new Map<string, HeaderValue>([
        ["delivered-to", `reports+${ORGANIZATION_ID}+cc001@example.com`],
        ["x-original-to", `reports+${ORGANIZATION_ID}+cc002@example.com`],
        [
          "to",
          {
            value: [
              {
                name: "Test",
                address: `reports+${ORGANIZATION_ID}+cc003@example.com`,
              },
            ],
            html: "",
            text: "",
          },
        ],
      ]),
      headerLines: [],
      html: false,
    } as ParsedMail;

    const recipients = extractRecipientEmailsByPriority(parsedMail);
    expect(recipients).toEqual([
      `reports+${ORGANIZATION_ID}+cc001@example.com`,
      `reports+${ORGANIZATION_ID}+cc002@example.com`,
      `reports+${ORGANIZATION_ID}+cc003@example.com`,
    ]);
  });
});

describe("buildOrgCostCenterLabel", () => {
  it("builds hierarchical gmail label", () => {
    expect(buildOrgCostCenterLabel("org-1", "cc-1")).toBe("org-1/cc-1");
  });
});

describe("gmail parsing helpers", () => {
  it("builds gmail search criteria from subject and date", () => {
    const criteria = buildSearchCriteria(
      { subjectFilter: "Weekly Report" },
      dayjs("2025-01-10")
    );
    expect(criteria).toEqual([
      ["SUBJECT", "Weekly Report"],
      ["SINCE", "January 10, 2025"],
    ]);
  });

  it("extracts metrics from parsed mail attachments", () => {
    const parsedMail = {
      attachments: [
        {
          type: "attachment",
          content: Buffer.from("costCenter,desc,value\ncc-1,x,99.5\n", "utf-8"),
          contentType: "text/csv",
          contentDisposition: "attachment",
          filename: "report_product_breakdown_20250101_20250102.csv",
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
    } as ParsedMail;

    const metrics = extractMetricsFromParsedMail(
      parsedMail,
      makeGmailSource(),
      "Europe/Zurich",
      "cc-alias"
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      costCenter: "cc-alias",
      metricType: "UmsatzMapped",
      value: "99.5",
      metricTypeCategory: "Ist",
    });
  });

  it("returns empty when attachment date does not match regex", () => {
    const parsedMail = {
      attachments: [
        {
          type: "attachment",
          content: Buffer.from("costCenter,desc,value\ncc-1,x,99.5\n", "utf-8"),
          contentType: "text/csv",
          contentDisposition: "attachment",
          filename: "report_without_date.csv",
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
    } as ParsedMail;

    const metrics = extractMetricsFromParsedMail(
      parsedMail,
      makeGmailSource(),
      "Europe/Zurich",
      "cc-alias"
    );
    expect(metrics).toEqual([]);
  });

  it("returns empty for invalid valueCell configuration", () => {
    const source = makeGmailSource();
    source.valueCell = { column: 0, row: 0 };

    const parsedMail = {
      attachments: [
        {
          type: "attachment",
          content: Buffer.from("costCenter,desc,value\ncc-1,x,99.5\n", "utf-8"),
          contentType: "text/csv",
          contentDisposition: "attachment",
          filename: "report_product_breakdown_20250101_20250102.csv",
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
    } as ParsedMail;

    const metrics = extractMetricsFromParsedMail(
      parsedMail,
      source,
      "Europe/Zurich",
      "cc-alias"
    );
    expect(metrics).toEqual([]);
  });

  it("returns empty when configured value cell is outside csv bounds", () => {
    const source = makeGmailSource();
    source.valueCell = { column: 5, row: 5 };

    const parsedMail = {
      attachments: [
        {
          type: "attachment",
          content: Buffer.from("costCenter,desc,value\ncc-1,x,99.5\n", "utf-8"),
          contentType: "text/csv",
          contentDisposition: "attachment",
          filename: "report_product_breakdown_20250101_20250102.csv",
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
    } as ParsedMail;

    const metrics = extractMetricsFromParsedMail(
      parsedMail,
      source,
      "Europe/Zurich",
      "cc-alias"
    );
    expect(metrics).toEqual([]);
  });
});
