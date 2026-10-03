import crypto from "node:crypto";
import {
  type Alert,
  AlertSchema,
  AlertManagerWebhookSchema,
  GenericAlertSchema,
  type AlertStatus,
  normalizeAlertSeverity,
} from "@airp/common";

function generateFingerprint(
  service: string,
  name: string,
  labels: Record<string, string>,
): string {
  const sortedLabels = Object.keys(labels)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      acc[key] = labels[key];
      return acc;
    }, {});
  return crypto
    .createHash("sha256")
    .update(`${service}:${name}:${JSON.stringify(sortedLabels)}`)
    .digest("hex")
    .slice(0, 16);
}

function normalizeTimestamp(ts?: string | null): string | undefined {
  if (!ts) return undefined;
  if (ts.startsWith("0001-01-01")) return undefined;
  try {
    return new Date(ts).toISOString();
  } catch {
    return undefined;
  }
}

export function normalizeAlerts(payload: unknown): Alert[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid alert payload: expected JSON object or array");
  }

  // 1. Array of generic alerts
  if (Array.isArray(payload)) {
    return payload.map((item) => normalizeSingleGenericAlert(item));
  }

  // 2. Alertmanager Webhook format (contains `alerts` array with labels)
  const amResult = AlertManagerWebhookSchema.safeParse(payload);
  if (amResult.success && amResult.data.alerts.length > 0) {
    const webhook = amResult.data;
    return webhook.alerts.map((item) => {
      const labels = item.labels || {};
      const service =
        labels.service ||
        labels.app ||
        labels.job ||
        labels.instance ||
        "unknown";
      const name =
        labels.alertname || item.annotations?.summary || "UnknownAlert";
      const status: AlertStatus =
        item.status === "resolved" ||
        (!item.status && webhook.status === "resolved")
          ? "resolved"
          : "firing";
      const severity = normalizeAlertSeverity(labels.severity);
      const startsAt =
        normalizeTimestamp(item.startsAt) || new Date().toISOString();
      const endsAt =
        status === "resolved"
          ? normalizeTimestamp(item.endsAt) || new Date().toISOString()
          : undefined;
      const fingerprint =
        item.fingerprint || generateFingerprint(service, name, labels);

      return AlertSchema.parse({
        id: crypto.randomUUID(),
        fingerprint,
        name,
        service,
        severity,
        status,
        startsAt,
        endsAt,
        labels,
        annotations: item.annotations || {},
        generatorURL: item.generatorURL,
        receivedAt: new Date().toISOString(),
      });
    });
  }

  // 3. Payload with `alerts` array of generic alerts
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.alerts)) {
    return obj.alerts.map((item) => normalizeSingleGenericAlert(item));
  }

  // 4. Single generic alert
  return [normalizeSingleGenericAlert(payload)];
}

function normalizeSingleGenericAlert(item: unknown): Alert {
  const parsed = GenericAlertSchema.parse(item);
  const labels: Record<string, string> = { ...parsed.labels };
  if (!labels.service) labels.service = parsed.service;

  const name = parsed.name || parsed.metric || "GenericAlert";
  const status: AlertStatus =
    parsed.status === "resolved" ? "resolved" : "firing";
  const severity = normalizeAlertSeverity(parsed.severity);
  const startsAt =
    normalizeTimestamp(parsed.startsAt) || new Date().toISOString();
  const endsAt =
    status === "resolved"
      ? normalizeTimestamp(parsed.endsAt) || new Date().toISOString()
      : undefined;

  const annotations: Record<string, string> = { ...parsed.annotations };
  if (parsed.message) annotations.message = parsed.message;
  if (parsed.description) annotations.description = parsed.description;

  const fingerprint =
    parsed.fingerprint || generateFingerprint(parsed.service, name, labels);

  return AlertSchema.parse({
    id: crypto.randomUUID(),
    fingerprint,
    name,
    service: parsed.service,
    severity,
    status,
    startsAt,
    endsAt,
    labels,
    annotations,
    receivedAt: new Date().toISOString(),
  });
}
