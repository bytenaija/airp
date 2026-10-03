# AIRP — Autonomous Incident Investigation and Remediation Platform

A build project: an autonomous system that detects service incidents,
investigates them with an LLM agent over telemetry and code, and either opens
a validated pull request or hands a structured report to a human.

## How this repo works

This repo is built **epic by epic, by an AI builder, under AI review**:

| File | Purpose |
|---|---|
| `CONTEXT.md` | Global build context: stack, layout, hard requirements. Read first. |
| `prompts/epic-NN-*.md` | The 17 epic prompts, in build order. One epic at a time. |
| `GEMINI.md` | Operating instructions for the builder agent (push always, PR per epic, never advance without approval). |
| `REVIEW_PROTOCOL.md` | How the reviewer (Muse) approves epics and authorizes the next one. |
| `docs/textbook.md` | The full textbook: concepts, architecture, spec, testing, hardening. |
| `docs/textbook.pdf` | Same, as PDF. |

**Workflow:** builder implements `prompts/epic-01-*` on a branch → pushes →
opens PR with acceptance evidence → **waits** → reviewer approves (merges) or
requests changes → builder proceeds to epic-02 only after approval.

## Stack

Node.js 20 LTS, TypeScript (strict), Fastify, Prisma + Postgres 16 (pgvector),
Vitest, Zod, OpenTelemetry, Vercel AI SDK. Local-first: everything runs on
commodity hardware via Docker Compose. See `CONTEXT.md`.

## Status

Epic-by-epic build. See open/merged PRs for progress.
