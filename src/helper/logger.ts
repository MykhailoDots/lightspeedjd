import { createLogger, format, transports } from "winston";

const isVercelRuntime = process.env.VERCEL === "1" || process.env.VERCEL === "true";
const enableFileLog = !isVercelRuntime && process.env.ENABLE_FILE_LOG !== "false";

const loggerTransports: any[] = [new transports.Console()];

if (enableFileLog) {
  loggerTransports.push(
    new transports.File({
      filename: "application.log",
      format: format.combine(
        format.timestamp({
          format: "YYYY-MM-DD HH:mm:ss",
        }),
        format.printf(({ timestamp, level, message }) => {
          return `${timestamp} ${level}: ${message}`;
        })
      ),
    })
  );
}

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.colorize(),
    format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss",
    }),
    format.printf(({ timestamp, level, message }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: loggerTransports,
});

export default logger;
