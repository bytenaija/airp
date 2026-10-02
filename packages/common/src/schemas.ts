import { z } from "zod";

// --- Change Events ---
export const ChangeEventTypeSchema = z.enum(["deploy", "flag", "config"]);
export type ChangeEventType = z.infer<typeof ChangeEventTypeSchema>;

export const ChangeEventSchema = z.object({
  id: z.string().uuid().optional(),
  type: ChangeEventTypeSchema,
  service: z.string().min(1),
  revision: z.string().min(1),
  ts: z
    .string()
    .datetime()
    .or(z.date().transform((d) => d.toISOString())),
  author: z.string().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

// --- Alerts ---
export const AlertSeveritySchema = z.enum([
  "critical",
  "high",
  "warning",
  "info",
  "low",
  "SEV1",
  "SEV2",
  "SEV3",
  "SEV4",
]);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const AlertStatusSchema = z.enum(["firing", "resolved"]);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

export const AlertSchema = z.object({
  id: z.string().uuid().optional(),
  fingerprint: z.string().min(1),
  name: z.string().min(1),
  service: z.string().min(1),
  severity: AlertSeveritySchema.default("warning"),
  status: AlertStatusSchema.default("firing"),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional().nullable(),
  labels: z.record(z.string()).default({}),
  annotations: z.record(z.string()).default({}),
  generatorURL: z.string().optional().nullable(),
  receivedAt: z.string().datetime().optional(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const AlertManagerAlertItemSchema = z.object({
  status: z.enum(["firing", "resolved"]).optional(),
  labels: z.record(z.string()),
  annotations: z.record(z.string()).optional().default({}),
  startsAt: z.string(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().optional(),
});
export type AlertManagerAlertItem = z.infer<typeof AlertManagerAlertItemSchema>;

export const AlertManagerWebhookSchema = z.object({
  version: z.string().optional(),
  groupKey: z.string().optional(),
  status: z.enum(["firing", "resolved"]).optional(),
  receiver: z.string().optional(),
  groupLabels: z.record(z.string()).optional(),
  commonLabels: z.record(z.string()).optional(),
  commonAnnotations: z.record(z.string()).optional(),
  externalURL: z.string().optional(),
  alerts: z.array(AlertManagerAlertItemSchema),
});
export type AlertManagerWebhook = z.infer<typeof AlertManagerWebhookSchema>;

export const GenericAlertSchema = z.object({
  name: z.string().optional(),
  service: z.string().min(1),
  severity: z.string().optional().default("warning"),
  status: z.enum(["firing", "resolved"]).optional().default("firing"),
  startsAt: z.string().optional(),
  endsAt: z.string().optional().nullable(),
  metric: z.string().optional(),
  message: z.string().optional(),
  description: z.string().optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
  fingerprint: z.string().optional(),
});
export type GenericAlert = z.infer<typeof GenericAlertSchema>;

// --- Incident Records ---
export const IncidentSeveritySchema = z.enum(["SEV1", "SEV2", "SEV3", "SEV4"]);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

export const IncidentStatusSchema = z.enum([
  "open",
  "investigating",
  "diagnosed",
  "mitigating",
  "resolved",
]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const SignalSchema = z.object({
  type: z.string(),
  service: z.string(),
  metric: z.string().optional(),
  window: z.string().optional(),
  detail: z.string().optional(),
  fingerprint: z.string().optional(),
  startsAt: z.string().optional(),
  severity: z.string().optional(),
});
export type Signal = z.infer<typeof SignalSchema>;

export const TimelineEventSchema = z.object({
  ts: z.string().datetime(),
  actor: z.string(),
  action: z.string(),
  detail: z.string().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const EnrichmentSchema = z.object({
  topology_slice: z.record(z.unknown()).optional().default({}),
  recent_changes: z.array(ChangeEventSchema).optional().default([]),
  owner: z.string().optional(),
  similar_incidents: z.array(z.record(z.unknown())).optional().default([]),
  runbooks: z.array(z.record(z.unknown())).optional().default([]),
});
export type Enrichment = z.infer<typeof EnrichmentSchema>;

export const IncidentRecordSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().default("local"),
  title: z.string().min(1),
  severity: IncidentSeveritySchema,
  status: IncidentStatusSchema,
  started_at: z.string().datetime(),
  detected_at: z.string().datetime(),
  signals: z.array(SignalSchema).default([]),
  enrichment: EnrichmentSchema.default({}),
  timeline: z.array(TimelineEventSchema).default([]),
});
export type IncidentRecord = z.infer<typeof IncidentRecordSchema>;

// --- State Machine & Validation ---
export class IllegalStateTransitionError extends Error {
  readonly from: IncidentStatus;
  readonly to: IncidentStatus;

  constructor(from: IncidentStatus, to: IncidentStatus) {
    super(`Illegal incident status transition: cannot transition from '${from}' to '${to}'`);
    this.name = "IllegalStateTransitionError";
    this.from = from;
    this.to = to;
    Object.setPrototypeOf(this, IllegalStateTransitionError.prototype);
  }
}

const VALID_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  open: ["investigating"],
  investigating: ["diagnosed"],
  diagnosed: ["mitigating"],
  mitigating: ["resolved"],
  resolved: ["open"], // explicit reopen
};

export function validateStatusTransition(
  currentStatus: IncidentStatus,
  targetStatus: IncidentStatus,
): void {
  const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
  if (!allowed.includes(targetStatus)) {
    throw new IllegalStateTransitionError(currentStatus, targetStatus);
  }
}

export function normalizeSeverity(severity: string | undefined): IncidentSeverity {
  if (!severity) return "SEV3";
  const s = severity.toUpperCase();
  if (s === "SEV1" || s === "CRITICAL" || s === "PAGE") return "SEV1";
  if (s === "SEV2" || s === "HIGH" || s === "ERROR") return "SEV2";
  if (s === "SEV3" || s === "MEDIUM" || s === "WARN" || s === "WARNING") return "SEV3";
  if (s === "SEV4" || s === "LOW" || s === "INFO") return "SEV4";
  return "SEV3";
}
