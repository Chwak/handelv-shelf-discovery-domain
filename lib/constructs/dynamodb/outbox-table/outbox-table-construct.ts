/**
 * Transactional outbox DynamoDB table for this domain. Self-contained — schema matches PLATFORM_DESIGN_CONTRACTS.txt.
 * Publisher Lambdas read `GSI-StatusCreatedAt` for PENDING rows.
 */

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface OutboxTableConstructProps {
  environment: string;
  regionCode: string;
  /** e.g. "maker-domain", "order-domain" — becomes part of the physical table name */
  domainName: string;
  removalPolicy?: cdk.RemovalPolicy;
}

export class OutboxTableConstruct extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: OutboxTableConstructProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.DESTROY;

    this.table = new dynamodb.Table(this, "OutboxTable", {
      tableName: `${props.environment}-${props.regionCode}-${props.domainName}-outbox`,
      partitionKey: {
        name: "eventId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === "prod" },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "GSI-StatusCreatedAt",
      partitionKey: {
        name: "status",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "createdAt",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
