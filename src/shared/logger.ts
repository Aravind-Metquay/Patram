import pino from "pino";
import { env } from "../config/env.js";

export const loggerOptions: pino.LoggerOptions = {
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } }
      : undefined,
};

export const logger = pino(loggerOptions);
