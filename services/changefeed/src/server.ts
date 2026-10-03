/**
 * Changefeed service (Epic 20 work package 6).
 *
 * Serves the change-event log over HTTP. Storage goes through the
 * ChangeEventRepository interface: compose/VPS wires the Prisma
 * backend, Cloudflare wires Hyperdrive, tests inject the in-memory
 * fake. No direct Prisma calls remain here.
 */
import Fastify, { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import {
  ChangeEventSchema,
  buildServiceLoggerOptions,
  createRelationalStoreFromEnv,
  type ChangeEventRepository,
} from "@airp/common";
import { z } from "zod";

export interface ChangeFeedServerOptions {
  prisma?: PrismaClient;
  changeEvents?: ChangeEventRepository;
  logger?: boolean;
}

export function buildChangeFeedServer(
  options: ChangeFeedServerOptions = {},
): FastifyInstance {
  const server = Fastify({
    logger: buildServiceLoggerOptions("changefeed", options.logger ?? false),
  });

  const changeEvents: ChangeEventRepository =
    options.changeEvents ??
    (() => {
      const prisma = options.prisma ?? new PrismaClient();
      return createRelationalStoreFromEnv(process.env, { prisma })
        .changeEvents;
    })();

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
      const created = await changeEvents.recordEvent({
        type,
        service,
        revision,
        ts,
        author,
        metadata,
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

    try {
      const events = await changeEvents.listEvents({
        service,
        type,
        limit: Math.min(limit, 100),
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
