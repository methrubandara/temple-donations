import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const STATE_TABLE_NAME = process.env.STATE_TABLE_NAME || "";
const ATTACHMENTS_BUCKET_NAME = process.env.ATTACHMENTS_BUCKET_NAME || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const STATE_PK = "GLOBAL_STATE";
const EXTRACTION_PROMPT = `Extract donation/payment information from this document. This could be a check image, a Venmo payment screenshot, or a payment receipt PDF.

Return ONLY a JSON object with these fields (no markdown, no backticks, no explanation):
{
  "amount": <number or null>,
  "date": "<YYYY-MM-DD or null>",
  "type": "<one of: Cash, Check, Venmo, PayPal, Deposit - or null>",
  "checkNumber": "<string or null>",
  "payerName": "<string or null>",
  "confidence": "<high, medium, or low>",
  "notes": "<brief description of what was found>"
}

Rules:
- For checks: extract check number, amount, date, and payer name
- For Venmo: extract amount, date, sender name, set type to "Venmo"
- If a field cannot be determined, set it to null
- Amount should be a number with no currency symbols
- Date should be in YYYY-MM-DD format`;

type AppState = {
  users: unknown[];
  donations: unknown[];
};

function response(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type"
    },
    body: JSON.stringify(body)
  };
}

function parseJsonBody(event: APIGatewayProxyEventV2): any {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

async function streamToString(stream: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function getState(): Promise<AppState> {
  const result = await ddb.send(new GetCommand({
    TableName: STATE_TABLE_NAME,
    Key: { pk: STATE_PK }
  }));

  const item = result.Item as { data?: AppState } | undefined;
  return item?.data || { users: [], donations: [] };
}

async function putState(state: AppState): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: STATE_TABLE_NAME,
    Item: {
      pk: STATE_PK,
      data: {
        users: Array.isArray(state.users) ? state.users : [],
        donations: Array.isArray(state.donations) ? state.donations : []
      },
      updatedAt: new Date().toISOString()
    }
  }));
}

async function getAllAttachments(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: ATTACHMENTS_BUCKET_NAME,
    Prefix: "attachments/"
  }));

  for (const obj of list.Contents || []) {
    if (!obj.Key || !obj.Key.endsWith(".json")) continue;

    const donationId = obj.Key.replace(/^attachments\//, "").replace(/\.json$/, "");
    const getResult = await s3.send(new GetObjectCommand({
      Bucket: ATTACHMENTS_BUCKET_NAME,
      Key: obj.Key
    }));
    const raw = await streamToString(getResult.Body);
    results[donationId] = JSON.parse(raw);
  }

  return results;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === "OPTIONS") return response(204, {});
  if (!STATE_TABLE_NAME || !ATTACHMENTS_BUCKET_NAME) return response(500, { error: "Server not configured" });

  try {
    if (method === "GET" && path === "/health") {
      return response(200, { ok: true, service: "nebvmc-donation-backend" });
    }

    if (method === "GET" && path === "/state") {
      const state = await getState();
      return response(200, state);
    }

    if (method === "PUT" && path === "/state") {
      const body = parseJsonBody(event);
      await putState({ users: body.users || [], donations: body.donations || [] });
      return response(200, { ok: true });
    }

    if (method === "GET" && path === "/attachments") {
      const attachments = await getAllAttachments();
      return response(200, attachments);
    }

    if (method === "POST" && path === "/extract") {
      if (!ANTHROPIC_API_KEY) {
        return response(500, { error: "ANTHROPIC_API_KEY is not configured" });
      }

      const body = parseJsonBody(event);
      const base64Data = body.base64Data;
      const mediaType = body.mediaType;
      if (!base64Data || !mediaType) {
        return response(400, { error: "base64Data and mediaType are required" });
      }

      const contentBlock = String(mediaType).startsWith("image/")
        ? { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } }
        : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } };

      const extractionRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: [contentBlock, { type: "text", text: EXTRACTION_PROMPT }] }]
        })
      });

      const extractionData: any = await extractionRes.json();
      if (!extractionRes.ok) {
        return response(extractionRes.status, { error: "Anthropic API request failed", details: extractionData });
      }

      const text = extractionData.content?.map((c: any) => (c.type === "text" ? c.text : "")).join("") || "{}";
      const clean = text.replace(/```json|```/g, "").trim();
      return response(200, JSON.parse(clean));
    }

    const attachmentMatch = path.match(/^\/attachments\/([^/]+)$/);
    if (attachmentMatch && method === "PUT") {
      const donationId = decodeURIComponent(attachmentMatch[1]);
      const attachment = parseJsonBody(event);
      await s3.send(new PutObjectCommand({
        Bucket: ATTACHMENTS_BUCKET_NAME,
        Key: `attachments/${donationId}.json`,
        Body: JSON.stringify(attachment),
        ContentType: "application/json"
      }));
      return response(200, { ok: true });
    }

    if (attachmentMatch && method === "DELETE") {
      const donationId = decodeURIComponent(attachmentMatch[1]);
      await s3.send(new DeleteObjectCommand({
        Bucket: ATTACHMENTS_BUCKET_NAME,
        Key: `attachments/${donationId}.json`
      }));
      return response(200, { ok: true });
    }

    return response(404, { error: "Not found" });
  } catch (error) {
    return response(500, {
      error: "Request failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
