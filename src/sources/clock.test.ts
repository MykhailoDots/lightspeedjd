import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import { setRequiredEnvForConfig } from "../test-utils/mocks";

const clockStateFilePath = path.resolve(process.cwd(), "clock-state.json");

const backupPath = `${clockStateFilePath}.bak-test`;

beforeAll(() => {
  setRequiredEnvForConfig();

  if (fs.existsSync(clockStateFilePath)) {
    fs.renameSync(clockStateFilePath, backupPath);
  }
});

afterAll(() => {
  if (fs.existsSync(clockStateFilePath)) {
    fs.unlinkSync(clockStateFilePath);
  }
  if (fs.existsSync(backupPath)) {
    fs.renameSync(backupPath, clockStateFilePath);
  }
});

describe("clock state helpers", () => {
  it("returns empty state when file does not exist", async () => {
    const { readClockState } = await import("./clock.ts?case=state-read-empty");
    if (fs.existsSync(clockStateFilePath)) {
      fs.unlinkSync(clockStateFilePath);
    }
    const state = await readClockState();
    expect(state).toEqual({});
  });

  it("writes and reads lastUpdatedAt value", async () => {
    const { writeClockState, readClockState } = await import(
      "./clock.ts?case=state-write-read"
    );
    const iso = "2025-01-01T10:00:00.000Z";
    await writeClockState(iso);
    const state = await readClockState();
    expect(state.lastUpdatedAt).toBe(iso);
  });
});
