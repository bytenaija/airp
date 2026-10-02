import Fastify, { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { ChangeEventSchema } from "@airp/common";
import { z } from "zod";

export interface ChangeFeedServerOptions {
  prisma?: PrismaClient;
  logger?: boolean;
}

export function buildChangeFeedServer(
  options: ChangeFeedServerOptions = {},
): FastifyInstance {
  const server = Fastify({
    logger: options.logger ?? false,
  });

  const prisma = options.prisma ?? new PrismaClient();

  server.get("/health", async () => {
    return { status: "ok" };
  });

  server.post("/events", async (request, reply) => {
    const parseResult = ChangeEventSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parseResult.error.errors,
      });
    }

    const { type, service, revision, ts, author, metadata } = parseResult.data;

    try {
      const created = await prisma.changeEvent.create({
        data: {
          type,
          service,
          revision,
          ts: new Date(ts),
          author: author ?? null,
          metadata: metadata ? (metadata as any) : undefined,
        },
      });

      return reply.status(201).send(created);
    } catch (err: unknown) {
      server.log.error(err, "Failed to insert change event");
      return reply.status(500).send({
        error: "Database error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.get("/events", async (request, reply) => {
    const QuerySchema = z.object({
      service: z.string().optional(),
      type: z.string().optional(),
      limit: z.coerce.number().optional().default(50),
    });

    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query parameters" });
    }

    const { service, type, limit } = parsed.data;
    const where: any = {};
    if (service) where.service = service;
    if (type) where.type = type;

    try {
      const events = await prisma.changeEvent.findMany({
        where,
        take: Math.min(limit, 100),
        orderBy: { ts: "desc" },
      });
      return reply.send(events);
    } catch (err: unknown) {
      server.log.error(err, "Failed to fetch change events");
      return reply.status(500).send({
        error: "Database error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return server;
}

if (process.env.NODE_ENV !== "test" && process.argv[1]?.endsWith("server.js")) {
  const port = Number(process.env.PORT || 8004);
  const host = process.env.HOST || "0.0.0.0";
  const app = buildChangeFeedServer({ logger: true });
  app.listen({ port, host }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Changefeed server listening on ${address}`);
  });
}
