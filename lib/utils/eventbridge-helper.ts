/**
 * Central EventBridge bus via SSM (owned by shared-infra). Self-contained in this CDK app — no cross-package CDK dependency.
 * Keep SSM paths aligned with PLATFORM_DESIGN_CONTRACTS.txt when the platform contract changes.
 */

import * as events from "aws-cdk-lib/aws-events";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

/** SSM parameter suffixes under `/${environment}/shared-infra/eventbridge/` */
export const SHARED_INFRA_EVENT_BUS_NAME_PARAM = "event-bus-name";
export const SHARED_INFRA_EVENT_BUS_ARN_PARAM = "event-bus-arn";

export function sharedInfraEventBusNameParameterPath(environment: string): string {
  return `/${environment}/shared-infra/eventbridge/${SHARED_INFRA_EVENT_BUS_NAME_PARAM}`;
}

export function sharedInfraEventBusArnParameterPath(environment: string): string {
  return `/${environment}/shared-infra/eventbridge/${SHARED_INFRA_EVENT_BUS_ARN_PARAM}`;
}

export function importEventBusFromSharedInfra(scope: Construct, environment: string): events.IEventBus {
  const eventBusName = ssm.StringParameter.fromStringParameterName(
    scope,
    "ImportedEventBusName",
    sharedInfraEventBusNameParameterPath(environment),
  ).stringValue;

  return events.EventBus.fromEventBusName(scope, "ImportedEventBus", eventBusName);
}

export function getEventBusArnFromSharedInfra(scope: Construct, environment: string): string {
  return ssm.StringParameter.fromStringParameterName(
    scope,
    "ImportedEventBusArn",
    sharedInfraEventBusArnParameterPath(environment),
  ).stringValue;
}
