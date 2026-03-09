import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";

interface DonationBackendStackProps extends cdk.StackProps {
  allowedOrigin: string;
}

export class DonationBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DonationBackendStackProps) {
    super(scope, id, props);
    const anthropicApiKey = new cdk.CfnParameter(this, "AnthropicApiKey", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Anthropic API key for document extraction endpoint (/extract). Optional."
    });
    const adminUsername = new cdk.CfnParameter(this, "AdminUsername", {
      type: "String",
      noEcho: true,
      default: "admin",
      description: "Admin username for secure API login."
    });
    const adminPassword = new cdk.CfnParameter(this, "AdminPassword", {
      type: "String",
      noEcho: true,
      description: "Admin password for secure API login."
    });
    const adminSessionSecret = new cdk.CfnParameter(this, "AdminSessionSecret", {
      type: "String",
      noEcho: true,
      description: "Secret used to sign admin session tokens."
    });

    const stateTable = new dynamodb.Table(this, "DonationStateTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const attachmentsBucket = new s3.Bucket(this, "DonationAttachmentsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.DELETE],
          allowedOrigins: [props.allowedOrigin],
          allowedHeaders: ["*"]
        }
      ]
    });

    const apiHandler = new NodejsFunction(this, "DonationApiHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: "lambda/api.ts",
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        STATE_TABLE_NAME: stateTable.tableName,
        ATTACHMENTS_BUCKET_NAME: attachmentsBucket.bucketName,
        ALLOWED_ORIGIN: props.allowedOrigin,
        ANTHROPIC_API_KEY: anthropicApiKey.valueAsString,
        ADMIN_USERNAME: adminUsername.valueAsString,
        ADMIN_PASSWORD: adminPassword.valueAsString,
        ADMIN_SESSION_SECRET: adminSessionSecret.valueAsString
      }
    });

    stateTable.grantReadWriteData(apiHandler);
    attachmentsBucket.grantReadWrite(apiHandler);

    const httpApi = new apigwv2.HttpApi(this, "DonationHttpApi", {
      corsPreflight: {
        allowHeaders: ["content-type", "authorization"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS
        ],
        allowOrigins: [props.allowedOrigin]
      }
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration("DonationLambdaIntegration", apiHandler);
    httpApi.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration: lambdaIntegration });
    httpApi.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration: lambdaIntegration });

    new cdk.CfnOutput(this, "ApiBaseUrl", { value: httpApi.url || "" });
    new cdk.CfnOutput(this, "StateTableName", { value: stateTable.tableName });
    new cdk.CfnOutput(this, "AttachmentsBucketName", { value: attachmentsBucket.bucketName });
  }
}
