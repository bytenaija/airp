export interface ApprovalNotificationRequest {
  planId: string;
  service: string;
  requiredApprovals: string[];
  diagnosis?: string;
  diffLines?: number;
  confidence?: number;
  advisoryTriage?: string;
  ruleVersion?: string;
}

export interface SlackProvider {
  postApprovalRequest(
    request: ApprovalNotificationRequest,
  ): Promise<{ success: boolean; messageId?: string }>;
}

export class StubSlackProvider implements SlackProvider {
  public sentMessages: ApprovalNotificationRequest[] = [];
  private webhookUrl?: string;

  constructor(webhookUrl?: string) {
    this.webhookUrl = webhookUrl || process.env.SLACK_WEBHOOK;
  }

  async postApprovalRequest(
    request: ApprovalNotificationRequest,
  ): Promise<{ success: boolean; messageId?: string }> {
    this.sentMessages.push(request);

    if (this.webhookUrl) {
      try {
        const text = `🚨 *Approval Required* for Plan \`${request.planId}\`\n• Service: *${request.service}*\n• Approvals: *${request.requiredApprovals.join(", ")}*\n• Rule Version: ${request.ruleVersion || "v1"}`;
        await fetch(this.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      } catch (err: any) {
        // Fall back to stdout on failure
        console.warn(`[Slack Stub] Webhook failed, fallback to log: ${err.message}`);
      }
    } else {
      // Local default: prints the approval request
      console.log(
        `[Slack Stub] Approval Request: Plan ${request.planId} (Service: ${request.service}, Required: [${request.requiredApprovals.join(", ")}])`,
      );
    }

    return {
      success: true,
      messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    };
  }
}
