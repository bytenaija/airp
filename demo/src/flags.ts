import { FastifyInstance } from "fastify";

export class FlagsManager {
  private flags: Map<string, boolean> = new Map([
    ["new_payment_flow", false],
  ]);

  get(key: string): boolean {
    return this.flags.get(key) ?? false;
  }

  set(key: string, value: boolean): void {
    this.flags.set(key, value);
  }

  getAll(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [k, v] of this.flags.entries()) {
      result[k] = v;
    }
    return result;
  }

  reset(): void {
    this.flags.clear();
    this.flags.set("new_payment_flow", false);
  }
}

export function registerFlagRoutes(
  server: FastifyInstance,
  flagsManager: FlagsManager,
) {
  server.get("/admin/flags", async (_req, reply) => {
    return reply.send({
      flags: flagsManager.getAll(),
    });
  });

  server.post("/admin/flags", async (req, reply) => {
    const body = (req.body as any) || {};
    let appliedCount = 0;

    if (typeof body.flag === "string" && typeof body.value === "boolean") {
      flagsManager.set(body.flag, body.value);
      appliedCount++;
    } else if (
      body.flags &&
      typeof body.flags === "object" &&
      body.flags !== null
    ) {
      for (const [k, v] of Object.entries(body.flags)) {
        if (typeof v === "boolean") {
          flagsManager.set(k, v);
          appliedCount++;
        }
      }
    } else if (typeof body === "object" && body !== null) {
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === "boolean") {
          flagsManager.set(k, v);
          appliedCount++;
        }
      }
    }

    if (appliedCount === 0) {
      return reply.status(400).send({
        error: "Bad Request: No valid flag or boolean value provided.",
      });
    }

    return reply.send({
      status: "ok",
      flags: flagsManager.getAll(),
    });
  });
}
