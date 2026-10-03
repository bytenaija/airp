import { QueryClient } from "@airp/common";

export interface SLOCheckResult {
  healthy: boolean;
  burnRate: number;
  errorRate: number;
  threshold: number;
  details?: string;
}

export interface SLOGateEvaluator {
  checkSLO(service: string, windowSeconds?: number): Promise<SLOCheckResult>;
}

export interface PrometheusSLOGateEvaluatorOptions {
  prometheusUrl?: string;
  queryClient?: QueryClient;
  errorBudget?: number; // default: 0.01 (1% error rate is 1.0x burn rate)
  burnRateThreshold?: number; // default: 1.0x burn rate
  maxErrorRate?: number; // default: 0.05 (5% error rate)
}

export class PrometheusSLOGateEvaluator implements SLOGateEvaluator {
  private queryClient: QueryClient;
  private errorBudget: number;
  private burnRateThreshold: number;
  private maxErrorRate: number;

  constructor(options: PrometheusSLOGateEvaluatorOptions = {}) {
    this.queryClient =
      options.queryClient ||
      new QueryClient({
        prometheusUrl:
          options.prometheusUrl ||
          process.env.PROMETHEUS_URL ||
          "http://localhost:9090",
      });
    this.errorBudget = options.errorBudget ?? 0.01;
    this.burnRateThreshold = options.burnRateThreshold ?? 1.0;
    this.maxErrorRate = options.maxErrorRate ?? 0.05;
  }

  async checkSLO(
    service = "checkout",
    windowSeconds = 60,
  ): Promise<SLOCheckResult> {
    try {
      // Query error rate over the evaluation window
      // rate(http_errors_total{service="..."}[window]) / rate(http_requests_total{service="..."}[window])
      const errorQuery = `sum(rate(http_errors_total{service="${service}"}[${windowSeconds}s])) or vector(0)`;
      const totalQuery = `sum(rate(http_requests_total{service="${service}"}[${windowSeconds}s])) or vector(0)`;

      const [errorsRes, totalRes] = await Promise.all([
        this.queryClient.metricsQuery(errorQuery),
        this.queryClient.metricsQuery(totalQuery),
      ]);

      const errVal = this.extractNumericValue(errorsRes);
      const totalVal = this.extractNumericValue(totalRes);

      let errorRate = 0;
      if (totalVal > 0) {
        errorRate = errVal / totalVal;
      } else if (errVal > 0) {
        // Errors present without registered total rate
        errorRate = 1.0;
      }

      const burnRate = Number((errorRate / this.errorBudget).toFixed(4));
      const healthy =
        burnRate < this.burnRateThreshold && errorRate < this.maxErrorRate;

      return {
        healthy,
        burnRate,
        errorRate,
        threshold: this.burnRateThreshold,
        details: healthy
          ? `SLO healthy: burn_rate=${burnRate}x (threshold: ${this.burnRateThreshold}x, error_rate: ${(errorRate * 100).toFixed(2)}%)`
          : `SLO breach: burn_rate=${burnRate}x exceeds threshold ${this.burnRateThreshold}x (error_rate: ${(errorRate * 100).toFixed(2)}%)`,
      };
    } catch (err: any) {
      // In case of query failures or unreachable Prometheus in dev/test,
      // fail safe or report error detail
      return {
        healthy: false,
        burnRate: 999,
        errorRate: 1.0,
        threshold: this.burnRateThreshold,
        details: `SLO check query failure: ${err?.message || String(err)}`,
      };
    }
  }

  private extractNumericValue(res: any): number {
    if (res?.series && res.series.length > 0) {
      const values = res.series[0].values;
      if (values && values.length > 0) {
        const last = values[values.length - 1];
        const val = parseFloat(last[1]);
        return isNaN(val) ? 0 : val;
      }
    }
    return 0;
  }
}

/**
 * Mock evaluator for deterministic unit and functional tests
 */
export class MockSLOGateEvaluator implements SLOGateEvaluator {
  private healthy = true;
  private burnRate = 0.0;
  private errorRate = 0.0;
  private threshold = 1.0;
  private customHandler?: (service: string) => Promise<SLOCheckResult>;

  constructor(initialHealthy = true) {
    this.healthy = initialHealthy;
    this.burnRate = initialHealthy ? 0.1 : 5.0;
    this.errorRate = initialHealthy ? 0.001 : 0.05;
  }

  setHealthy(healthy: boolean, burnRate?: number, errorRate?: number): void {
    this.healthy = healthy;
    if (burnRate !== undefined) {
      this.burnRate = burnRate;
    } else {
      this.burnRate = healthy ? 0.1 : 5.0;
    }
    if (errorRate !== undefined) {
      this.errorRate = errorRate;
    } else {
      this.errorRate = healthy ? 0.001 : 0.05;
    }
  }

  setHandler(handler: (service: string) => Promise<SLOCheckResult>): void {
    this.customHandler = handler;
  }

  async checkSLO(service: string): Promise<SLOCheckResult> {
    if (this.customHandler) {
      return this.customHandler(service);
    }
    return {
      healthy: this.healthy,
      burnRate: this.burnRate,
      errorRate: this.errorRate,
      threshold: this.threshold,
      details: this.healthy
        ? `Mock SLO healthy: burn_rate=${this.burnRate}x`
        : `Mock SLO breach: burn_rate=${this.burnRate}x exceeds threshold ${this.threshold}x`,
    };
  }
}
