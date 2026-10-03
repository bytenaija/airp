import { Diagnosis } from "@airp/common";
import { ReversibleAction } from "./framework.js";
import {
  RollbackAction,
  RollbackActionParams,
  CommandExecutor,
} from "./actions/rollback.js";
import {
  FlagToggleAction,
  FlagToggleActionParams,
} from "./actions/flag-toggle.js";
import { ScaleAction, ScaleActionParams } from "./actions/scale.js";

export interface PlannerOptions {
  composeFilePath?: string;
  executor?: CommandExecutor;
  fetchFn?: typeof fetch;
  serviceFlagUrls?: Record<string, string>;
  servicePorts?: Record<string, number>;
  defaultFlagEndpointTemplate?: string;
  onRollback?: (service: string, targetVersion: string) => Promise<void> | void;
  onScale?: (service: string, targetReplicas: number) => Promise<void> | void;
}

export class UnsupportedFixabilityError extends Error {
  constructor(fixability: string) {
    super(
      `Ops action planner cannot plan actions for diagnosis with fixability '${fixability}'. Expected 'ops_actionable'.`,
    );
    this.name = "UnsupportedFixabilityError";
    Object.setPrototypeOf(this, UnsupportedFixabilityError.prototype);
  }
}

export function resolveFlagUrl(
  service: string,
  options: PlannerOptions = {},
): string {
  if (options.serviceFlagUrls && options.serviceFlagUrls[service]) {
    return options.serviceFlagUrls[service];
  }

  if (options.servicePorts && options.servicePorts[service]) {
    return `http://localhost:${options.servicePorts[service]}/admin/flags`;
  }

  // Default port mappings for common services, or fallback
  const defaultPorts: Record<string, number> = {
    checkout: 8001,
    payments: 8002,
    "fraud-check": 8003,
  };

  const port = defaultPorts[service];
  if (port) {
    return `http://localhost:${port}/admin/flags`;
  }

  return `http://${service}:8001/admin/flags`;
}

function detectServiceFromDiagnosis(diagnosis: Diagnosis): string {
  if (diagnosis.implicated_change?.service) {
    return diagnosis.implicated_change.service;
  }

  for (const item of diagnosis.evidence) {
    const text = JSON.stringify(item);
    const serviceMatch = text.match(/"service":"([^"]+)"/);
    if (serviceMatch && serviceMatch[1]) {
      return serviceMatch[1];
    }
  }

  // Check root cause text for common service patterns
  const match = diagnosis.root_cause.match(/\b([a-z0-9_-]+(?:service|checkout|payments|fraud|inventory|worker|gateway))\b/i);
  if (match && match[1]) {
    return match[1].toLowerCase();
  }

  return "checkout";
}

function isSaturationScenario(diagnosis: Diagnosis): boolean {
  const rootCause = diagnosis.root_cause.toLowerCase();
  const saturationTerms = [
    "saturation",
    "cpu burn",
    "cpu spike",
    "high cpu",
    "high load",
    "exhaustion",
    "pool exhaust",
    "overload",
    "capacity",
    "queue buildup",
  ];

  if (saturationTerms.some((term) => rootCause.includes(term))) {
    return true;
  }

  return diagnosis.evidence.some((ev) => {
    const evText = JSON.stringify(ev).toLowerCase();
    return saturationTerms.some((term) => evText.includes(term));
  });
}

function isFlagScenario(diagnosis: Diagnosis): boolean {
  if (diagnosis.implicated_change?.type === "flag") {
    return true;
  }
  const rootCause = diagnosis.root_cause.toLowerCase();
  if (rootCause.includes("flag") || rootCause.includes("feature flag")) {
    return true;
  }
  return diagnosis.evidence.some((ev) => {
    const evText = JSON.stringify(ev).toLowerCase();
    return (
      evText.includes('"type":"flag"') ||
      evText.includes("feature flag") ||
      evText.includes("flag toggle")
    );
  });
}

function isDeployScenario(diagnosis: Diagnosis): boolean {
  if (diagnosis.implicated_change?.type === "deploy") {
    return true;
  }
  const rootCause = diagnosis.root_cause.toLowerCase();
  if (
    rootCause.includes("deploy") ||
    rootCause.includes("release") ||
    rootCause.includes("version")
  ) {
    return true;
  }
  return diagnosis.evidence.some((ev) => {
    const evText = JSON.stringify(ev).toLowerCase();
    return evText.includes('"type":"deploy"') || evText.includes("deploy");
  });
}

/**
 * Plans an operational remediation action for an ops_actionable diagnosis.
 * - Chooses RollbackAction if implicated_change is a deploy.
 * - Chooses FlagToggleAction if a flag event is implicated.
 * - Chooses ScaleAction if evidence is saturation.
 */
export function planOpsAction(
  diagnosis: Diagnosis,
  options: PlannerOptions = {},
): ReversibleAction | null {
  if (diagnosis.fixability !== "ops_actionable") {
    throw new UnsupportedFixabilityError(diagnosis.fixability);
  }

  const service = detectServiceFromDiagnosis(diagnosis);

  // 1. Check for Bad Deploy Scenario -> RollbackAction
  if (diagnosis.implicated_change?.type === "deploy" || isDeployScenario(diagnosis)) {
    const change = diagnosis.implicated_change;
    const currentVersion =
      change?.revision ||
      (change?.metadata?.revision as string) ||
      (change?.metadata?.new_version as string) ||
      "v2.14.3";

    const previousVersion =
      (change?.metadata?.previous_revision as string) ||
      (change?.metadata?.old_revision as string) ||
      (change?.metadata?.previous_version as string) ||
      "v2.14.2";

    const rollbackParams: RollbackActionParams = {
      service,
      currentVersion,
      previousVersion,
      composeFilePath: options.composeFilePath,
      executor: options.executor,
      onRollback: options.onRollback,
    };

    return new RollbackAction(rollbackParams);
  }

  // 2. Check for Feature Flag Scenario -> FlagToggleAction
  if (diagnosis.implicated_change?.type === "flag" || isFlagScenario(diagnosis)) {
    const change = diagnosis.implicated_change;
    const flagKey =
      (change?.metadata?.flag as string) ||
      (change?.metadata?.flagKey as string) ||
      (change?.revision !== "flag" ? change?.revision : undefined) ||
      "new_payment_flow";

    // Value before remediation is typically true (enabling the faulty path)
    const currentValue =
      typeof change?.metadata?.value === "boolean"
        ? change.metadata.value
        : true;
    const targetValue = !currentValue;

    const flagUrl = resolveFlagUrl(service, options);

    const flagParams: FlagToggleActionParams = {
      service,
      flagUrl,
      flagKey,
      currentValue,
      targetValue,
      fetchFn: options.fetchFn,
    };

    return new FlagToggleAction(flagParams);
  }

  // 3. Check for Saturation Scenario -> ScaleAction
  if (isSaturationScenario(diagnosis)) {
    const scaleParams: ScaleActionParams = {
      service,
      currentReplicas: 1,
      targetReplicas: 3,
      composeFilePath: options.composeFilePath,
      executor: options.executor,
      onScale: options.onScale,
    };

    return new ScaleAction(scaleParams);
  }

  return null;
}
