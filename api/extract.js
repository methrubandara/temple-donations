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

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(res, 500, { error: "ANTHROPIC_API_KEY is not configured" });
  }

  try {
    const { base64Data, mediaType } = req.body || {};
    if (!base64Data || !mediaType) {
      return json(res, 400, { error: "base64Data and mediaType are required" });
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
      return json(res, response.status, { error: "Anthropic API request failed", details: data });
    }

    const text = data.content?.map((c) => (c.type === "text" ? c.text : "")).join("") || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return json(res, 200, parsed);
  } catch (error) {
    return json(res, 500, { error: "Extraction failed", details: error.message });
  }
}
