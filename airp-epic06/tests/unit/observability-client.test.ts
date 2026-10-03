import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient } from "../../packages/common/src/observability-client.js";

describe("QueryClient", () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new QueryClient({
      lokiUrl: "http://loki-test:3100",
      prometheusUrl: "http://prom-test:9090",
      tempoUrl: "http://tempo-test:3200",
      defaultTimeoutMs: 1000,
      maxLogsLimit: 500,
      maxTracesLimit: 50,
    });
  });

  describe("logsQuery", () => {
    it("enforces limit caps and parses Loki streams", async () => {
      const mockLokiResponse = {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { service: "checkout", level: "info" },
              values: [
                [
                  "1710000000000000000",
                  JSON.stringify({ msg: "order processed", orderId: "123" }),
                ],
                [
                  "1710000001000000000",
                  JSON.stringify({ msg: "payment initiated" }),
                ],
              ],
            },
          ],
        },
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockLokiResponse,
      } as Response);

      const logs = await client.logsQuery(
        "checkout",
        new Date(1710000000000),
        new Date(1710000010000),
        "payment",
        1000,
      );

      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      // Cap should be 500 because maxLogsLimit is 500
      expect(calledUrl).toContain("limit=500");
      expect(decodeURIComponent(calledUrl.replace(/\+/g, " "))).toContain(
        "|= `payment`",
      );
      expect(logs).toHaveLength(2);
      expect(logs[0].data).toEqual({ msg: "payment initiated" });
      expect(logs[1].data).toEqual({ msg: "order processed", orderId: "123" });
    });

    it("times out if request hangs", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, options) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const fastTimeoutClient = new QueryClient({
        defaultTimeoutMs: 50,
      });

      await expect(
        fastTimeoutClient.logsQuery("checkout", new Date(), new Date()),
      ).rejects.toThrow(/timed out/);
    });
  });

  describe("metricsQuery", () => {
    it("queries instant metrics and formats labels", async () => {
      const mockPromResponse = {
        status: "success",
        data: {
          resultType: "vector",
          result: [
            {
              metric: {
                __name__: "http_requests_total",
                service: "checkout",
                status: "200",
              },
              value: [1710000000, "42"],
            },
          ],
        },
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockPromResponse,
      } as Response);

      const res = await client.metricsQuery("http_requests_total", {
        service: "checkout",
        status: "200",
      });

      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain(
        "http_requests_total%7Bservice%3D%22checkout%22%2Cstatus%3D%22200%22%7D",
      );
      expect(res.series).toHaveLength(1);
      expect(res.series[0].values).toEqual([[1710000000, "42"]]);
    });

    it("queries range metrics when start and end provided", async () => {
      const mockPromResponse = {
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { service: "checkout" },
              values: [
                [1710000000, "10"],
                [1710000015, "12"],
              ],
            },
          ],
        },
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockPromResponse,
      } as Response);

      const res = await client.metricsQuery(
        "http_requests_total",
        {},
        1710000000000,
        1710000030000,
        "15s",
      );
      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/query_range");
      expect(calledUrl).toContain("step=15s");
      expect(res.series[0].values).toHaveLength(2);
    });
  });

  describe("tracesSearch", () => {
    it("searches error traces and enforces caps", async () => {
      const mockTempoResponse = {
        traces: [
          {
            traceID: "abc123trace",
            rootServiceName: "checkout",
            rootTraceName: "POST /checkout",
            durationMs: 450,
            status: "STATUS_CODE_ERROR",
          },
        ],
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockTempoResponse,
      } as Response);

      const traces = await client.tracesSearch(
        "checkout",
        1710000000000,
        1710000030000,
        "error",
        100,
      );

      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      // Cap is 50 because maxTracesLimit = 50
      expect(calledUrl).toContain("limit=50");
      expect(traces).toHaveLength(1);
      expect(traces[0].traceId).toBe("abc123trace");
      expect(traces[0].status).toBe("STATUS_CODE_ERROR");
    });
  });
});
