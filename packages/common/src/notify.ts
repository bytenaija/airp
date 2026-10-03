import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

export const NotificationEventTypeSchema = z.enum([
  "investigation-start",
  "diagnosis-ready",
  "handoff",
]);
export type NotificationEventType = z.infer<typeof NotificationEventTypeSchema>;

export const NotificationEventSchema = z.object({
  id: z.string().uuid().default(() => crypto.randomUUID()),
  type: NotificationEventTypeSchema,
  incident_id: z.string(),
  service: z.string(),
  team: z.string().optional(),
  severity: z.string().optional(),
  title: z.string(),
  summary: z.string(),
  details: z.record(z.unknown()).optional().default({}),
  timestamp: z.string().datetime().default(() => new Date().toISOString()),
});
export type NotificationInput = z.input<typeof NotificationEventSchema>;
export type NotificationEvent = z.output<typeof NotificationEventSchema>;

export interface NotificationResult {
  success: boolean;
  destination: string;
  messageId?: string;
  error?: string;
}

export interface NotificationProvider {
  send(event: NotificationInput): Promise<NotificationResult>;
}

export interface LocalNotifyOptions {
  outboxDir?: string;
  silent?: boolean;
}

/**
 * LocalNotify: Writes notification events as JSON files to a local outbox directory
 * and prints human-readable notification banners to the console.
 */
export class LocalNotify implements NotificationProvider {
  private readonly outboxDir: string;
  private readonly silent: boolean;

  constructor(options: LocalNotifyOptions = {}) {
    this.outboxDir =
      options.outboxDir ||
      process.env.AIRP_OUTBOX_DIR ||
      path.resolve(process.cwd(), "outbox");
    this.silent = options.silent ?? false;
  }

  getOutboxDir(): string {
    return this.outboxDir;
  }

  async send(rawEvent: NotificationInput): Promise<NotificationResult> {
    const event = NotificationEventSchema.parse(rawEvent);

    if (!fs.existsSync(this.outboxDir)) {
      fs.mkdirSync(this.outboxDir, { recursive: true });
    }

    const safeIncidentId = event.incident_id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeTimestamp = event.timestamp.replace(/[:.]/g, "-");
    const filename = `${safeTimestamp}_${event.type}_${safeIncidentId}.json`;
    const targetPath = path.resolve(this.outboxDir, filename);

    const outboxBase = path.resolve(this.outboxDir);
    if (!targetPath.startsWith(outboxBase)) {
      throw new Error(`Invalid notification path: '${filename}' escapes outbox directory`);
    }

    // If team is specified, also save in team-scoped subfolder for team routing
    if (event.team) {
      const safeTeam = event.team.replace(/[^a-zA-Z0-9_-]/g, "_");
      const teamsBase = path.resolve(this.outboxDir, "teams");
      const teamDir = path.resolve(teamsBase, safeTeam);
      if (!teamDir.startsWith(teamsBase)) {
        throw new Error(`Invalid team directory: '${event.team}' escapes outbox teams directory`);
      }
      if (!fs.existsSync(teamDir)) {
        fs.mkdirSync(teamDir, { recursive: true });
      }
      const teamFilePath = path.join(teamDir, filename);
      fs.writeFileSync(teamFilePath, JSON.stringify(event, null, 2), "utf8");
    }

    fs.writeFileSync(targetPath, JSON.stringify(event, null, 2), "utf8");

    if (!this.silent) {
      const teamLabel = event.team ? ` [team: ${event.team}]` : "";
      console.log(
        `[outbox] ${event.type.toUpperCase()}${teamLabel} (${event.service}): ${event.title} - ${event.summary}`,
      );
    }

    return {
      success: true,
      destination: targetPath,
      messageId: event.id,
    };
  }
}

export interface SlackNotifyOptions {
  webhookUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * SlackNotify: Posts notification events to a Slack incoming webhook.
 */
export class SlackNotify implements NotificationProvider {
  private readonly webhookUrl?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: SlackNotifyOptions = {}) {
    this.webhookUrl = options.webhookUrl || process.env.SLACK_WEBHOOK;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  async send(rawEvent: NotificationInput): Promise<NotificationResult> {
    const event = NotificationEventSchema.parse(rawEvent);

    if (!this.webhookUrl) {
      return {
        success: false,
        destination: "slack",
        error: "SLACK_WEBHOOK environment variable is not configured",
      };
    }

    const payload = {
      text: `*[${event.type.toUpperCase()}]* ${event.title}\n*Service:* ${event.service}${event.team ? ` | *Team:* ${event.team}` : ""}\n*Incident:* ${event.incident_id}\n\n${event.summary}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `[${event.type.toUpperCase()}] ${event.title}`,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Service:* ${event.service}` },
            { type: "mrkdwn", text: `*Severity:* ${event.severity || "N/A"}` },
            { type: "mrkdwn", text: `*Incident ID:* \`${event.incident_id}\`` },
            { type: "mrkdwn", text: `*Team:* ${event.team || "unassigned"}` },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: event.summary,
          },
        },
      ],
    };

    try {
      const response = await this.fetchFn(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          destination: this.webhookUrl,
          error: `Slack webhook responded with status ${response.status}: ${text}`,
        };
      }

      return {
        success: true,
        destination: this.webhookUrl,
        messageId: event.id,
      };
    } catch (err: any) {
      return {
        success: false,
        destination: this.webhookUrl,
        error: `Failed to deliver Slack notification: ${err?.message || String(err)}`,
      };
    }
  }
}
