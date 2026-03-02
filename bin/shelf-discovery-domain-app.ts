#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ShelfDiscoveryDomainStack } from "../lib/shelf-discovery-domain-stack";

const app = new cdk.App();

const environment = app.node.tryGetContext("environment") ?? "dev";
const regionCode = app.node.tryGetContext("regionCode") ?? "use1";

new ShelfDiscoveryDomainStack(app, `${environment}-${regionCode}-hand-made-shelf-discovery-domain-stack`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  environment,
  regionCode,
});
