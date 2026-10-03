/**
 * Alert queue for the ingest-gateway.
 *
 * Thin domain wrapper over the AlertRepository storage interface
 * (Epic 20 work package 6). The repository is injected: compose/VPS
 * wires the Prisma backend, Cloudflare wires Hyperdrive, and tests
 * inject the in-memory fake. Backend differences (row ordering,
 * window units) are normalized here so the service keeps its exact
 * historical behavior.
 */
import { AlertSchema, type Alert, type QueuedAlert, type AlertRepository } from "@airp/common";

export type QueuedAlertRow = QueuedAlert;
/** Legacy alias; prefer QueuedAlertRow or QueuedAlert. */
export type QueueAlert = QueuedAlert;

/**
 * Domain wrapper over an injected AlertRepository.
 *
 * @param repository storage backend (Prisma on compose, Hyperdrive on
 * Cloudflare, memory fake in tests).
 * @param tenantId tenant scope for all operations (default "default").
 */
export class AlertQueue {
  constructor(
    private readonly repository: AlertRepository,
    private readonly tenantId: string = "default",
  ) {}

  async pushAlerts(
    alerts: Alert[],
    tenantId?: string,
    rawPayload?: unknown,
  ): Promise<QueuedAlert[]> {
    const tid = tenantId ?? this.tenantId;
    const validated = alerts.map((alert) => AlertSchema.parse(alert));
    const created = await this.repository.pushAlerts(
      validated,
      tid,
      rawPayload,
    );
    const now = new Date().toISOString();
    return created.map((alert) => ({
      ...alert,
      receivedAt: (alert as QueuedAlert).receivedAt ?? now,
      processed: false,
    }));
  }

  async fetchPendingAlerts(
    tenantId?: string,
    limit: number = 500,
  ): Promise<QueuedAlert[]> {
    const rows = await this.repository.fetchPendingAlerts(
      tenantId ?? this.tenantId,
      limit,
    );
    // Normalize to oldest-first; backends do not guarantee row order.
    return rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  async fetchRecentFiringAlerts(
    tenantId?: string,
    windowMs: number = 15 * 60 * 1000,
  ): Promise<QueuedAlert[]> {
    const rows = await this.repository.fetchRecentFiringAlerts(
      tenantId ?? this.tenantId,
      windowMs / 60_000,
    );
    // Normalize to oldest-first; backends do not guarantee row order.
    return rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  async markProcessed(
    ids: string[],
    incidentId?: string | null,
  ): Promise<void> {
    await this.repository.markProcessed(ids, this.tenantId, {
      incidentId: incidentId ?? null,
    });
  }

  async countActiveAlertsForIncident(
    incidentId: string,
    excludeAlertIds: string[] = [],
  ): Promise<number> {
    return this.repository.countActiveAlertsForIncident(
      incidentId,
      this.tenantId,
      excludeAlertIds,
    );
  }
}
