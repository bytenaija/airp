import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  LocalNotify,
  SlackNotify,
} from "@airp/common";

describe("Epic 10 Unit Tests: Notification Providers (LocalNotify & SlackNotify)", () => {
  let tmpOutbox: string;

  beforeEach(() => {
    tmpOutbox = fs.mkdtempSync(path.join(os.tmpdir(), "airp-outbox-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpOutbox)) {
      fs.rmSync(tmpOutbox, { recursive: true, force: true });
    }
  });

  it("LocalNotify writes notification files and routes to team-scoped directories", async () => {
    const notify = new LocalNotify({ outboxDir: tmpOutbox, silent: true });

    const result = await notify.send({
      type: "investigation-start",
      incident_id: "inc-1001",
      service: "checkout",
      team: "checkout-team",
      severity: "SEV1",
      title: "Checkout Latency Spike",
      summary: "Investigation started on checkout",
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(result.destination)).toBe(true);

    const mainFileContent = JSON.parse(fs.readFileSync(result.destination, "utf8"));
    expect(mainFileContent.incident_id).toBe("inc-1001");
    expect(mainFileContent.type).toBe("investigation-start");
    expect(mainFileContent.team).toBe("checkout-team");

    // Check team-scoped directory
    const teamDir = path.join(tmpOutbox, "teams", "checkout-team");
    expect(fs.existsSync(teamDir)).toBe(true);

    const teamFiles = fs.readdirSync(teamDir);
    expect(teamFiles.length).toBe(1);
    const teamContent = JSON.parse(
      fs.readFileSync(path.join(teamDir, teamFiles[0]), "utf8"),
    );
    expect(teamContent.service).toBe("checkout");
  });

  it("LocalNotify logs to console when silent is false", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const notify = new LocalNotify({ outboxDir: tmpOutbox, silent: false });

    await notify.send({
      type: "handoff",
      incident_id: "inc-1002",
      service: "payments",
      team: "payments-team",
      severity: "SEV2",
      title: "Escalated to human",
      summary: "Low confidence handoff",
    });

    expect(consoleSpy).toHaveBeenCalled();
    const lastLog = consoleSpy.mock.calls[0]?.[0] || "";
    expect(lastLog).toContain("[outbox] HANDOFF [team: payments-team]");
    consoleSpy.mockRestore();
  });

  it("SlackNotify sends structured payload when webhookUrl is provided", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: any;

    const mockFetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => "ok",
      };
    }) as any;

    const notify = new SlackNotify({
      webhookUrl: "https://hooks.slack.com/services/MOCK/WEBHOOK/123",
      fetchFn: mockFetch,
    });

    const res = await notify.send({
      type: "diagnosis-ready",
      incident_id: "inc-1003",
      service: "fraud-check",
      team: "risk-team",
      severity: "SEV1",
      title: "Fraud Check timeout diagnosed",
      summary: "Downstream saturation detected",
    });

    expect(res.success).toBe(true);
    expect(capturedUrl).toBe("https://hooks.slack.com/services/MOCK/WEBHOOK/123");
    expect(capturedBody.text).toContain("[DIAGNOSIS-READY]");
    expect(capturedBody.blocks).toBeDefined();
    expect(capturedBody.blocks[0].text.text).toContain("[DIAGNOSIS-READY]");
  });

  it("SlackNotify returns failure when webhookUrl is missing", async () => {
    const notify = new SlackNotify({ webhookUrl: undefined });
    const res = await notify.send({
      type: "investigation-start",
      incident_id: "inc-1004",
      service: "checkout",
      title: "Test",
      summary: "Test",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("SLACK_WEBHOOK");
  });

  it("SlackNotify gracefully handles HTTP errors from webhook endpoint", async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    })) as any;

    const notify = new SlackNotify({
      webhookUrl: "https://hooks.slack.com/error",
      fetchFn: mockFetch,
    });

    const res = await notify.send({
      type: "handoff",
      incident_id: "inc-1005",
      service: "checkout",
      title: "Test",
      summary: "Test",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("status 500");
  });

  it("LocalNotify sanitizes path traversal attempts in team and incident_id", async () => {
    const notify = new LocalNotify({ outboxDir: tmpOutbox, silent: true });

    const result = await notify.send({
      type: "investigation-start",
      incident_id: "../../../escape_id",
      service: "checkout",
      team: "../../escape_team",
      title: "Attack Test",
      summary: "Testing path traversal defense",
    });

    expect(result.success).toBe(true);
    // Target path must be contained inside tmpOutbox
    expect(result.destination.startsWith(path.resolve(tmpOutbox))).toBe(true);
    // Team directory must be contained inside tmpOutbox/teams
    const teamsDir = path.join(tmpOutbox, "teams");
    const subdirs = fs.readdirSync(teamsDir);
    expect(subdirs.length).toBe(1);
    expect(subdirs[0]).toBe("______escape_team");
  });
});
