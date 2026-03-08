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

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured" }) };
  }

  try {
    const { base64Data, mediaType } = JSON.parse(event.body || "{}");
    if (!base64Data || !mediaType) {
      return { statusCode: 400, body: JSON.stringify({ error: "base64Data and mediaType are required" }) };
    }

    const contentBlock = mediaType.startsWith("image/")
      ? { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } }
      : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: [contentBlock, { type: "text", text: EXTRACTION_PROMPT }]
          }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: "Anthropic API request failed", details: data })
      };
    }

    const text = data.content?.map((c) => (c.type === "text" ? c.text : "")).join("") || "{}";
    const clean = text.replace(/```json|```/g, "").trim();

    return { statusCode: 200, body: clean };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Extraction failed", details: error.message })
    };
  }
}
