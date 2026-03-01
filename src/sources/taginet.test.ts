import { describe, it, expect } from "bun:test";
import { buildTagiNetMetrics, calculateChildWeight } from "./taginet";
import type { TagiNetSourceConfig } from "../config";

describe("calculateChildWeight", () => {
  it("should return 1.5 for children under 18 months", () => {
    const birthDate = "2024-01-01";
    const bookingDate = "2024-12-01"; // 11 months old
    expect(calculateChildWeight(birthDate, bookingDate)).toBe(1.5);
    
    const birthDate2 = "2023-07-01";
    const bookingDate2 = "2024-12-01"; // 17 months old
    expect(calculateChildWeight(birthDate2, bookingDate2)).toBe(1.5);
  });

  it("should return 1.0 for children exactly 18 months", () => {
    const birthDate = "2023-06-01";
    const bookingDate = "2024-12-01"; // Exactly 18 months
    expect(calculateChildWeight(birthDate, bookingDate)).toBe(1.0);
  });

  it("should return 1.0 for children between 18 and 36 months", () => {
    const birthDate = "2022-12-01";
    const bookingDate = "2024-12-01"; // 24 months old
    expect(calculateChildWeight(birthDate, bookingDate)).toBe(1.0);
    
    const birthDate2 = "2021-12-01";
    const bookingDate2 = "2024-11-01"; // 35 months old
    expect(calculateChildWeight(birthDate2, bookingDate2)).toBe(1.0);
  });

  it("should return 1.0 for children exactly 36 months", () => {
    const birthDate = "2021-12-01";
    const bookingDate = "2024-12-01"; // Exactly 36 months
    expect(calculateChildWeight(birthDate, bookingDate)).toBe(1.0);
  });

  it("should return 0.8 for children over 36 months", () => {
    const birthDate = "2021-11-01";
    const bookingDate = "2024-12-01"; // 37 months old
    expect(calculateChildWeight(birthDate, bookingDate)).toBe(0.8);
    
    const birthDate2 = "2020-01-01";
    const bookingDate2 = "2024-12-01"; // 59 months old
    expect(calculateChildWeight(birthDate2, bookingDate2)).toBe(0.8);
  });

  it("should return 0.5 for children turning 5 after June 30th in the booking year", () => {
    // Child born on July 15, 2019, booking in 2024
    // Turns 5 on July 15, 2024 (after June 30)
    const birthDate = "2019-07-15";
    const bookingDate = "2024-05-01";
    expect(calculateChildWeight(birthDate, bookingDate)).toBe(0.5);
    
    // Same child, booking later in the year
    const bookingDate2 = "2024-11-01";
    expect(calculateChildWeight(birthDate, bookingDate2)).toBe(0.5);
  });

  it("should NOT return 0.5 for children turning 5 before June 30th", () => {
    // Child born on June 15, 2019, booking in 2024
    // Turns 5 on June 15, 2024 (before June 30)
    const birthDate = "2019-06-15";
    const bookingDate = "2024-05-01";
    expect(calculateChildWeight(birthDate, bookingDate)).toBe(0.8); // Over 36 months
  });

  it("should NOT return 0.5 for children turning 5 in a different year", () => {
    // Child born on July 15, 2019, booking in 2023
    // Turns 5 in 2024, not in the booking year
    const birthDate = "2019-07-15";
    const bookingDate = "2023-12-01";
    expect(calculateChildWeight(birthDate, bookingDate)).toBe(0.8); // Over 36 months
  });

  it("should handle edge case of child turning 5 exactly on June 30th", () => {
    // Child born on June 30, 2019, booking in 2024
    // Turns 5 exactly on June 30, 2024
    const birthDate = "2019-06-30";
    const bookingDate = "2024-05-01";
    expect(calculateChildWeight(birthDate, bookingDate)).toBe(0.8); // Not after June 30
  });

  it("should handle leap year births correctly", () => {
    // Child born on Feb 29, 2020 (leap year)
    const birthDate = "2020-02-29";
    
    // 18 months later would be Aug 29, 2021
    const bookingDate1 = "2021-08-28"; // Just under 18 months
    expect(calculateChildWeight(birthDate, bookingDate1)).toBe(1.5);
    
    const bookingDate2 = "2021-09-01"; // Over 18 months
    expect(calculateChildWeight(birthDate, bookingDate2)).toBe(1.0);
  });
});

describe("buildTagiNetMetrics", () => {
  const source: TagiNetSourceConfig = {
    name: "taginet-source",
    type: "taginet",
    enabled: true,
    ignoredMissingCostCenters: [],
    autoCreateMetricType: false,
    mergeMetricTypes: { enabled: false, name: "Kinder" },
    metricTypeMappings: [],
    metricTypeCategory: "Ist",
    costCenterMappingField: "name",
    apiUrl: "https://example.com",
    username: "u",
    password: "p",
    daysPast: 1,
    daysFuture: 0,
    costCenterMapping: { MandantA: "CC-A" },
  };

  it("aggregates category values and average per day/cost center", () => {
    const metrics = buildTagiNetMetrics(
      [
        {
          mandant: "MandantA",
          b_von_datum: "2025-01-06",
          b_bis_datum: "2025-01-06",
          k_name: "Kid",
          k_vorname: "A",
          k_geburtsdatum: "2020-01-01",
          b_von_zeit: "",
          b_bis_zeit: "",
          b_wochentag: "1",
          ba_morgenessen: "1",
          ba_vormittag: "0",
          ba_mittagessen: "1",
          ba_nachmittag: "0",
          ba_abendessen: "0",
          view_rep_atomic_beitraege_fld_id: "1",
          view_rep_atomic_kinder_fld_id: "1",
          view_rep_atomic_beitraege_block_fld_id: "1",
          view_rep_atomic_belegungsarten_fld_id: "1",
        },
      ],
      source,
      "Europe/Zurich",
      "2025-01-06",
      "2025-01-06"
    );

    const categories = metrics.map((m) => m.metricTypeCategory).sort();
    expect(categories).toContain("Morgenessen");
    expect(categories).toContain("Mittagessen");
    expect(categories).toContain("Durchschnitt");
    expect(metrics.every((m) => m.costCenter === "CC-A")).toBe(true);
  });
});
