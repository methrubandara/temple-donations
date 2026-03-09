# AWS Backend (CDK)

This deploys a centralized backend for NEBV&MC Donation Tracker using AWS:

- API Gateway (HTTP API)
- Lambda (single API handler)
- DynamoDB (users + donations state)
- S3 (attachments)

## Prerequisites

- AWS account
- AWS CLI configured (`aws configure`)
- Node.js 20+

## Install

```bash
cd aws-backend
npm install
```

## Bootstrap CDK (first time per account/region)

```bash
npx cdk bootstrap
```

## Deploy

```bash
npx cdk deploy \
  --parameters AdminUsername=admin \
  --parameters AdminPassword=your_strong_password \
  --parameters AdminSessionSecret=your_long_random_secret \
  --parameters AnthropicApiKey=YOUR_KEY
```

Or skip Anthropic key if you do not use extraction:

```bash
npx cdk deploy \
  --parameters AdminUsername=admin \
  --parameters AdminPassword=your_strong_password \
  --parameters AdminSessionSecret=your_long_random_secret
```

After deploy, copy `ApiBaseUrl` output.

## Connect frontend

Set this in your root `.env`:

```bash
VITE_API_BASE_URL=https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com
```

Then run/build frontend.

## Endpoints used by frontend

- `GET /state`
- `PUT /state`
- `GET /attachments`
- `PUT /attachments/{donationId}`
- `DELETE /attachments/{donationId}`
- `POST /extract` (optional, requires `AnthropicApiKey`)
- `GET /health`

Protected routes requiring admin bearer token:

- `PUT /state`
- `PUT /attachments/{donationId}`
- `DELETE /attachments/{donationId}`
- `POST /extract`

Public route for account creation:

- `POST /register`
- `POST /admin/login`
