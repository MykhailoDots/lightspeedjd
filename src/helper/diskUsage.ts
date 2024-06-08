import { check } from "diskusage";
import { sendMessageToDiscord } from "./discord";
import { appConfig } from "../config";

export const checkDiskUsage = async () => {
  const diskUsage = await check("/home/");
  // free space in percentage in MB
  const freeSpaceInPercent = (diskUsage.available / diskUsage.total) * 100;
  const freeSpaceInMB = diskUsage.available / 1024 / 1024 / 1024;
  const totalSpaceInMB = diskUsage.total / 1024 / 1024 / 1024;

  if (freeSpaceInPercent < appConfig.app.diskFreeSpaceThresholdInPercent) {
    sendMessageToDiscord({
      message: `Low disk space: ${freeSpaceInPercent.toFixed(
        2
      )}% (${freeSpaceInMB.toFixed(2)}GB free of ${totalSpaceInMB.toFixed(
        2
      )}GB)`,
    });
  }
};
