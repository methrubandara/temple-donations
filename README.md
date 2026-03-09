# NEBV&MC Donation Tracker

Production-ready React app for donation management, including optional AI document extraction.

## Prerequisites

- Node.js 20+
- npm 10+

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`.

## Environment variables

- `VITE_ADMIN_PIN`: Local-only admin PIN fallback when not using AWS backend auth.
- `VITE_API_BASE_URL`: AWS API Gateway base URL for centralized storage.
- `ANTHROPIC_API_KEY`: Required for `/api/extract` document parsing endpoint.

## Production build

```bash
npm run build
npm run preview
```

## AWS database backend (recommended)

This repo includes an AWS backend under `aws-backend/` using:
- DynamoDB for users + donations data
- S3 for attachments
- API Gateway + Lambda for API endpoints

Deploy it:

```bash
cd aws-backend
npm install
npx cdk bootstrap
npx cdk deploy \
  --parameters AdminUsername=admin \
  --parameters AdminPassword=your_strong_password \
  --parameters AdminSessionSecret=your_long_random_secret \
  --parameters AnthropicApiKey=YOUR_KEY
```

Copy `ApiBaseUrl` from stack outputs and set in frontend `.env`:

```bash
VITE_API_BASE_URL=https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com
```

Use strong values for `AdminPassword` and `AdminSessionSecret`.

## Deploy on Vercel

1. Import this repo into Vercel.
2. Set environment variables:
   - `VITE_API_BASE_URL`
   - `ANTHROPIC_API_KEY`
3. Deploy.

Vercel will use:
- Static app from Vite build output.
- Serverless function at `api/extract.js`.

## Deploy on Netlify

1. Connect this repo in Netlify.
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Add env vars:
   - `VITE_API_BASE_URL`
   - `ANTHROPIC_API_KEY`
5. Deploy.

Netlify will use `netlify/functions/extract.mjs` for `/api/extract`.

## Security note

- `VITE_*` env vars are exposed to browser users by design.
- Keep `ANTHROPIC_API_KEY` only on the serverless side.
