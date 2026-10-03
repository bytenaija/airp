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
  throwOnMissingParams?: boolean;
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

export class MissingActionParametersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingActionParametersError";
    Object.setPrototypeOf(this, MissingActionParametersError.prototype);
  }
}

export function resolveFlagUrl(
  service: string,
  options: PlannerOptions = {},
  changeMetadata?: Record<string, unknown>,
): string | null {
  if (options.serviceFlagUrls && options.serviceFlagUrls[service]) {
    return options.serviceFlagUrls[service];
  }

  if (options.servicePorts && options.servicePorts[service]) {
    return `http://localhost:${options.servicePorts[service]}/admin/flags`;
  }

  if (changeMetadata) {
    if (typeof changeMetadata.flagUrl === "string") {
      return changeMetadata.flagUrl;
    }
    if (typeof changeMetadata.flag_url === "string") {
      return changeMetadata.flag_url;
    }
    if (typeof changeMetadata.port === "number") {
      return `http://localhost:${changeMetadata.port}/admin/flags`;
    }
  }

  if (options.defaultFlagEndpointTemplate) {
    return options.defaultFlagEndpointTemplate.replace("${service}", service);
  }

  return null;
}

export function detectServiceFromDiagnosis(diagnosis: Diagnosis): string | null {
  if (diagnosis.implicated_change?.service) {
    return diagnosis.implicated_change.service;
  }

  for (const item of diagnosis.evidence) {
    const obs = item.observation as any;
    if (obs && typeof obs === "object") {
      if (typeof obs.service === "string" && obs.service.trim().length > 0) {
        return obs.service.trim();
      }
    }
    const query = item.query as any;
    if (query && typeof query === "object") {
      if (typeof query.service === "string" && query.service.trim().length > 0) {
        return query.service.trim();
      }
    }
  }

  return null;
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

function extractRollbackVersions(diagnosis: Diagnosis): {
  currentVersion: string | null;
  previousVersion: string | null;
} {
  const change = diagnosis.implicated_change;
  const metadata = change?.metadata || {};

  let currentVersion: string | null =
    change?.revision && change.revision !== "deploy" ? change.revision : null;

  if (!currentVersion && typeof metadata.revision === "string") {
    currentVersion = metadata.revision;
  }
  if (!currentVersion && typeof metadata.new_version === "string") {
    currentVersion = metadata.new_version;
  }
  if (!currentVersion && typeof metadata.current_version === "string") {
    currentVersion = metadata.current_version;
  }

  let previousVersion: string | null = null;
  if (typeof metadata.previous_revision === "string") {
    previousVersion = metadata.previous_revision;
  } else if (typeof metadata.old_revision === "string") {
    previousVersion = metadata.old_revision;
  } else if (typeof metadata.previous_version === "string") {
    previousVersion = metadata.previous_version;
  } else if (typeof metadata.target_revision === "string") {
    previousVersion = metadata.target_revision;
  }

  // Attempt to parse versions from root cause if still missing
  if (!currentVersion || !previousVersion) {
    const versionMatches = diagnosis.root_cause.match(/\bv\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9_.-]+)?\b/g);
    if (versionMatches && versionMatches.length >= 2) {
      if (!currentVersion) currentVersion = versionMatches[0];
      if (!previousVersion) previousVersion = versionMatches[1];
    } else if (versionMatches && versionMatches.length === 1 && !currentVersion) {
      currentVersion = versionMatches[0];
    }
  }

  return { currentVersion, previousVersion };
}

function extractFlagKey(diagnosis: Diagnosis): string | null {
  const change = diagnosis.implicated_change;
  const metadata = change?.metadata || {};

  if (typeof metadata.flag === "string" && metadata.flag.trim().length > 0) {
    return metadata.flag.trim();
  }
  if (typeof metadata.flagKey === "string" && metadata.flagKey.trim().length > 0) {
    return metadata.flagKey.trim();
  }
  if (typeof metadata.flag_key === "string" && metadata.flag_key.trim().length > 0) {
    return metadata.flag_key.trim();
  }
  if (change?.revision && change.revision !== "flag" && change.revision.trim().length > 0) {
    return change.revision.trim();
  }

  // Try extracting from root cause quotes: e.g. flag 'new_payment_flow'
  const match = diagnosis.root_cause.match(/flag\s+['"]([a-zA-Z0-9_-]+)['"]/i);
  if (match && match[1]) {
    return match[1];
  }

  return null;
}

function handleMissingParam(
  message: string,
  options: PlannerOptions,
): null {
  if (options.throwOnMissingParams) {
    throw new MissingActionParametersError(message);
  }
  return null;
}

/**
 * Plans an operational remediation action for an ops_actionable diagnosis.
 * - Chooses RollbackAction if implicated_change is a deploy.
 * - Chooses FlagToggleAction if a flag event is implicated.
 * - Chooses ScaleAction if evidence is saturation.
 *
 * Refuses (returns null or throws if throwOnMissingParams=true) when required
 * parameters (service, rollback versions, flag key/url) cannot be determined,
 * avoiding dangerous parameter fabrication.
 */
export function planOpsAction(
  diagnosis: Diagnosis,
  options: PlannerOptions = {},
): ReversibleAction | null {
  if (diagnosis.fixability !== "ops_actionable") {
    throw new UnsupportedFixabilityError(diagnosis.fixability);
  }

  const service = detectServiceFromDiagnosis(diagnosis);
  if (!service) {
    return handleMissingParam(
      "Target service could not be determined from the diagnosis.",
      options,
    );
  }

  // 1. Check for Bad Deploy Scenario -> RollbackAction
  if (diagnosis.implicated_change?.type === "deploy" || isDeployScenario(diagnosis)) {
    const { currentVersion, previousVersion } = extractRollbackVersions(diagnosis);

    if (!currentVersion || !previousVersion) {
      return handleMissingParam(
        `Rollback action requires currentVersion and previousVersion, but could not determine both from diagnosis (found currentVersion: ${currentVersion}, previousVersion: ${previousVersion}).`,
        options,
      );
    }

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
    const flagKey = extractFlagKey(diagnosis);
    if (!flagKey) {
      return handleMissingParam(
        `FlagToggleAction requires a flagKey, but none could be determined from the diagnosis.`,
        options,
      );
    }

    const change = diagnosis.implicated_change;
    const metadata = (change?.metadata as Record<string, unknown>) || {};
    const currentValue =
      typeof metadata.value === "boolean" ? metadata.value : true;
    const targetValue =
      typeof metadata.target_value === "boolean"
        ? metadata.target_value
        : !currentValue;

    const flagUrl = resolveFlagUrl(service, options, metadata);
    if (!flagUrl) {
      return handleMissingParam(
        `FlagToggleAction requires a flag administration endpoint URL, but could not resolve one for service '${service}'.`,
        options,
      );
    }

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
