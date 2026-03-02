import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import * as path from "path";

export interface RepublishLambdaConstructProps {
  environment: string;
  regionCode: string;
  domainName: string;
  removalPolicy?: cdk.RemovalPolicy;
  outboxTable: dynamodb.ITable;
  eventBus: events.IEventBus;
  schemaRegistryName: string;
  schedule?: events.Schedule;
}

export class RepublishLambdaConstruct extends Construct {
  public readonly function: NodejsFunction;
  public readonly scheduleRule: events.Rule;
  public readonly failedOutboxAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: RepublishLambdaConstructProps) {
    super(scope, id);
    const role = new iam.Role(this, "RepublishLambdaRole", {
      roleName: `${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda-role`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        CloudWatchLogsAccess: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"],
            resources: [`arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda`, `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda:log-stream:*`],
          })],
        }),
        CloudWatchPutMetric: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["cloudwatch:PutMetricData"],
            resources: ["*"],
            conditions: { StringEquals: { "cloudwatch:namespace": `HandMade/${props.domainName.charAt(0).toUpperCase() + props.domainName.slice(1)}/Outbox` } },
          })],
        }),
        GlueSchemaRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["glue:GetSchema", "glue:GetSchemaVersion"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });
    props.outboxTable.grantReadWriteData(role);
    props.eventBus.grantPutEventsTo(role);
    const logGroup = new logs.LogGroup(this, "RepublishLambdaLogGroup", {
      logGroupName: `/aws/lambda/${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });
    this.function = new NodejsFunction(this, "RepublishFunction", {
      functionName: `${props.environment}-${props.regionCode}-${props.domainName}-republish-lambda`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      entry: path.join(__dirname, "../../../functions/lambda/republish-lambda/republish-lambda.ts"),
      role,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      logGroup,
      bundling: { minify: true, sourceMap: false, target: "node22", externalModules: ["@aws-sdk/*"] },
      environment: {
        ENVIRONMENT: props.environment,
        LOG_LEVEL: props.environment === "prod" ? "ERROR" : "INFO",
        OUTBOX_TABLE_NAME: props.outboxTable.tableName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        DOMAIN_NAME: props.domainName,
        EVENT_SOURCE: `hand-made.${props.domainName}`,
        SCHEMA_REGISTRY_NAME: props.schemaRegistryName,
        METRIC_NAMESPACE: `HandMade/${props.domainName.charAt(0).toUpperCase() + props.domainName.slice(1)}/Outbox`,
        MAX_RETRIES: "5",
        BATCH_SIZE: "50",
        PENDING_THRESHOLD_MINUTES: "2",
      },
    });
    this.scheduleRule = new events.Rule(this, "RepublishScheduleRule", {
      ruleName: `${props.environment}-${props.regionCode}-${props.domainName}-republish-rule`,
      schedule: props.schedule ?? events.Schedule.rate(cdk.Duration.minutes(10)),
      enabled: true,
    });
    this.scheduleRule.addTarget(new targets.LambdaFunction(this.function));
    this.failedOutboxAlarm = new cloudwatch.Alarm(this, "RepublishFailedAlarm", {
      alarmName: `${props.environment}-${props.regionCode}-${props.domainName}-republish-failed-alarm`,
      metric: new cloudwatch.Metric({
        namespace: `HandMade/${props.domainName.charAt(0).toUpperCase() + props.domainName.slice(1)}/Outbox`,
        metricName: "RepublishFailedCount",
        statistic: cloudwatch.Statistic.SUM,
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    if (props.removalPolicy) this.function.applyRemovalPolicy(props.removalPolicy);
  }
}
