import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildChangeFeedServer } from "../../services/changefeed/src/server.js";
import { program } from "../../services/changefeed/src/cli.js";

describe("ChangeFeed Server", () => {
  let mockChangeEvents: any;

  beforeEach(() => {
    mockChangeEvents = {
      recordEvent: vi.fn(),
      listEvents: vi.fn(),
    };
  });

  it("responds to /health", async () => {
    const server = buildChangeFeedServer({ changeEvents: mockChangeEvents });
    const res = await server.inject({
      method: "GET",
      url: "/health",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("rejects invalid event payload", async () => {
    const server = buildChangeFeedServer({ changeEvents: mockChangeEvents });
    const res = await server.inject({
      method: "POST",
      url: "/events",
      payload: {
        type: "invalid_type",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation failed");
    expect(mockChangeEvents.recordEvent).not.toHaveBeenCalled();
  });

  it("accepts valid change event and stores in database", async () => {
    const server = buildChangeFeedServer({ changeEvents: mockChangeEvents });
    const createdEvent = {
      id: "test-uuid",
      type: "deploy",
      service: "checkout",
      revision: "v2.14.3",
      ts: "2026-10-02T10:00:00.000Z",
      author: "payments-team",
      metadata: {},
    };

    mockChangeEvents.recordEvent.mockResolvedValueOnce(createdEvent);

    const res = await server.inject({
      method: "POST",
      url: "/events",
      payload: {
        type: "deploy",
        service: "checkout",
        revision: "v2.14.3",
        ts: "2026-10-02T10:00:00.000Z",
        author: "payments-team",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockChangeEvents.recordEvent).toHaveBeenCalledWith({
      type: "deploy",
      service: "checkout",
      revision: "v2.14.3",
      ts: "2026-10-02T10:00:00.000Z",
      author: "payments-team",
      metadata: {},
    });
  });
});

describe("ChangeFeed CLI", () => {
  it("defines emit command with required options", () => {
    const emitCmd = program.commands.find((c) => c.name() === "emit");
    expect(emitCmd).toBeDefined();
    const serviceOpt = emitCmd?.options.find(
      (o) => o.attributeName() === "service",
    );
    expect(serviceOpt?.mandatory).toBe(true);
  });
});
