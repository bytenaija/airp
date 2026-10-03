import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildChangeFeedServer } from "../../services/changefeed/src/server.js";
import { program } from "../../services/changefeed/src/cli.js";

describe("ChangeFeed Server", () => {
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      changeEvent: {
        create: vi.fn(),
        findMany: vi.fn(),
      },
    };
  });

  it("responds to /health", async () => {
    const server = buildChangeFeedServer({ prisma: mockPrisma });
    const res = await server.inject({
      method: "GET",
      url: "/health",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("rejects invalid event payload", async () => {
    const server = buildChangeFeedServer({ prisma: mockPrisma });
    const res = await server.inject({
      method: "POST",
      url: "/events",
      payload: {
        type: "invalid_type",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation failed");
    expect(mockPrisma.changeEvent.create).not.toHaveBeenCalled();
  });

  it("accepts valid change event and stores in database", async () => {
    const server = buildChangeFeedServer({ prisma: mockPrisma });
    const createdEvent = {
      id: "test-uuid",
      type: "deploy",
      service: "checkout",
      revision: "v2.14.3",
      ts: new Date("2026-10-02T10:00:00Z"),
      author: "payments-team",
      metadata: {},
      createdAt: new Date(),
    };

    mockPrisma.changeEvent.create.mockResolvedValueOnce(createdEvent);

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
    expect(mockPrisma.changeEvent.create).toHaveBeenCalledWith({
      data: {
        type: "deploy",
        service: "checkout",
        revision: "v2.14.3",
        ts: new Date("2026-10-02T10:00:00.000Z"),
        author: "payments-team",
        metadata: {},
      },
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
