import fs from "node:fs";
import path from "node:path";

/**
 * Directory the OTel collector's filelog receiver tails for structured service
 * logs (see infra/otel-collector-config.yaml and docs/adr/001-telemetry-stack.md).
 */
const DEFAULT_LOG_DIR = "/var/log/airp";

export interface ServiceLoggerStream {
  write(msg: string): void;
}

export interface ServiceLoggerOptions {
  level: string;
  base: { service: string };
  formatters: { level: (label: string) => { level: string } };
  stream: ServiceLoggerStream;
}

/**
 * Resolve the structured-log file for a service. Honours LOG_DIR and otherwise
 * uses the shared /var/log/airp directory the filelog receiver tails.
 */
export function resolveServiceLogFile(serviceName: string): string | undefined {
  const dir =
    process.env.LOG_DIR ||
    (fs.existsSync(DEFAULT_LOG_DIR) ? DEFAULT_LOG_DIR : undefined);
  if (!dir) return undefined;
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, `${serviceName}.log`);
  } catch {
    return undefined;
  }
}

/**
 * Build Fastify/pino logger options for a service. The records carry the service
 * name and a string level so the filelog pipeline can label them, and they fan
 * out to stdout plus the shared log file the collector tails. Returns `false`
 * when logging is disabled so tests keep a silent logger.
 */
export function buildServiceLoggerOptions(
  serviceName: string,
  enabled: boolean,
): false | ServiceLoggerOptions {
  if (!enabled) return false;

  const level = process.env.LOG_LEVEL || "info";
  const filePath = resolveServiceLogFile(serviceName);

  let fileStream: fs.WriteStream | undefined;
  if (filePath) {
    fileStream = fs.createWriteStream(filePath, { flags: "a" });
  }

  const stream: ServiceLoggerStream = {
    write(msg: string) {
      process.stdout.write(msg);
      fileStream?.write(msg);
    },
  };

  return {
    level,
    base: { service: serviceName },
    formatters: { level: (label: string) => ({ level: label }) },
    stream,
  };
}
