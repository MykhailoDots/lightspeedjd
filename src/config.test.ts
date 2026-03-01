import { beforeAll, describe, expect, it } from "bun:test";
import { setRequiredEnvForConfig } from "./test-utils/mocks";

beforeAll(() => {
  setRequiredEnvForConfig();
});

describe("config module", () => {
  it("reads required and optional env vars", async () => {
    const configModule = await import("./config.ts");
    process.env.OPTIONAL_TEST_ENV = "";
    process.env.REQUIRED_TEST_ENV = "x";

    expect(configModule.getEnvVar("REQUIRED_TEST_ENV")).toBe("x");
    expect(configModule.getEnvVar("OPTIONAL_TEST_ENV", true)).toBe("");
  });

  it("selects app config by organization name", async () => {
    const configModule = await import("./config.ts");
    process.env.JOBDONE_ORGANIZATION_NAME = "astro-fries";
    const config = configModule.getAppConfig();
    expect(config.sources.length).toBeGreaterThan(0);
  });
});
