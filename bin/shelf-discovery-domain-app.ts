#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ShelfDiscoveryDomainStack } from "../lib/shelf-discovery-domain-stack";
import { ShelfDiscoveryDomainPipelineStack } from "../lib/shelf-discovery-domain-pipeline-stack";
import { GITHUB_CONNECTION_ARN, initCdkAppDeploy } from "../lib/utils/deployment-env";

const app = new cdk.App();
const { environment, regionCode, account, region } = initCdkAppDeploy(app);

new ShelfDiscoveryDomainStack(app, `${environment}-${regionCode}-hand-made-shelf-discovery-domain-stack`, {
  env: { account, region },
  environment,
  regionCode,
});

new ShelfDiscoveryDomainPipelineStack(app, "ShelfDiscoveryDomainPipelineStack", {
  env: { account, region },
  domain: "shelf-discovery-domain",
  githubConnectionArn: GITHUB_CONNECTION_ARN,
  description: "shelf-discovery-domain CDK (account 741429964649 only)",
});

app.synth();
