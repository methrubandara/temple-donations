import * as cdk from "aws-cdk-lib";
import { DonationBackendStack } from "../lib/donation-backend-stack";

const app = new cdk.App();

new DonationBackendStack(app, "NebvmcDonationBackendStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1"
  },
  allowedOrigin: app.node.tryGetContext("allowedOrigin") || "*"
});
