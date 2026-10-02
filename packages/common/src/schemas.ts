import { z } from "zod";

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
  tenant_id: z.string().default("default"),
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
