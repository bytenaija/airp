import { PrismaClient } from "@prisma/client";
import { type Alert, AlertSchema } from "@airp/common";

export class AlertQueue {
  private readonly prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient ?? new PrismaClient();
  }

  async pushAlerts(
    alerts: Alert[],
    tenantId = "local",
    rawPayload?: unknown,
  ): Promise<Alert[]> {
    if (alerts.length === 0) return [];

    const createdAlerts: Alert[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (const alert of alerts) {
        const id = alert.id ?? crypto.randomUUID();
        await tx.ingestedAlert.create({
          data: {
            id,
            tenantId,
            fingerprint: alert.fingerprint,
            name: alert.name,
            service: alert.service,
            severity: alert.severity,
            status: alert.status,
            startsAt: new Date(alert.startsAt),
            endsAt: alert.endsAt ? new Date(alert.endsAt) : null,
            labels: alert.labels,
            annotations: alert.annotations,
            rawPayload: rawPayload ? (rawPayload as object) : undefined,
            processed: false,
          },
        });
        createdAlerts.push({ ...alert, id });
      }
    });

    return createdAlerts;
  }

  async fetchPendingAlerts(tenantId = "local", limit = 500): Promise<Alert[]> {
    const rows = await this.prisma.ingestedAlert.findMany({
      where: {
        tenantId,
        processed: false,
      },
      orderBy: { startsAt: "asc" },
      take: limit,
    });

    return rows.map((r) =>
      AlertSchema.parse({
        id: r.id,
        fingerprint: r.fingerprint,
        name: r.name,
        service: r.service,
        severity: r.severity,
        status: r.status,
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt ? r.endsAt.toISOString() : undefined,
        labels: r.labels as Record<string, string>,
        annotations: r.annotations as Record<string, string>,
        receivedAt: r.receivedAt.toISOString(),
      }),
    );
  }

  async markProcessed(alertIds: string[], incidentId?: string): Promise<void> {
    if (alertIds.length === 0) return;

    await this.prisma.ingestedAlert.updateMany({
      where: { id: { in: alertIds } },
      data: {
        processed: true,
        incidentId: incidentId ?? null,
      },
    });
  }
}
