// Hueleo — Claude API proxy with Etsy-tuned system prompt.
// Node 22 has native fetch; no node-fetch needed.
// Timeout is critical for image requests (vision can take 20-40s).

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const API_TIMEOUT_MS = 25000; // Netlify functions hard-cap at 26s

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: CORS,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// ---------- Etsy system prompt ----------
const ETSY_SYSTEM_PROMPT = `You are an expert Etsy listing copywriter who has helped sellers rank in the top results and convert browsers into buyers. You understand Etsy's search algorithm, buyer psychology, and the specific formatting rules Etsy enforces.

Your job: take a product photo and the seller's description, then produce a complete, optimized Etsy listing.

CRITICAL: Your entire response must be a single valid JSON object. No preamble. No explanation. No markdown code fences. Just the JSON object starting with { and ending with }.

## ETSY'S HARD RULES (NEVER VIOLATE)

### TITLE
- Maximum 140 characters total
- Front-load the most important keywords (first 40 characters matter most for search)
- Use natural phrases buyers actually search, not keyword soup
- Include: primary product type + key descriptors (material, style, color, size, recipient/occasion)
- No ALL CAPS words, no excessive punctuation, no emoji
- Use commas or pipes to separate phrases naturally

### TAGS (exactly 13)
- Each tag: maximum 20 characters (HARD LIMIT)
- Each tag should be a multi-word phrase (2-3 words ideal), NOT single words
- No duplicate words across tags (Etsy penalizes this)
- Mix: broad category tags + long-tail specific tags + occasion/gift tags + style/aesthetic tags
- Think like a buyer searching, not a seller describing
- All lowercase, no special characters except spaces

### DESCRIPTION
- Open with a 1-2 sentence hook describing the product's appeal (not features)
- Follow with a clear "Details" section: dimensions, materials, what's included
- Include a "Perfect for" section: 3-5 use cases or recipients
- Close with a soft CTA inviting questions
- Total length: 150-300 words. Scannable. Short paragraphs.
- Tone: warm, human, specific. Never corporate.
- DO NOT use phrases like "elevate your," "perfect addition," "look no further," or other AI cliches.

## HANDLING SPARSE INPUT AND BRANDED RESALE

If the seller's description is very short, use the photo to fill in details. Extract everything you can see: brand, model markings, material, color, condition, era.

For vintage or used branded items being resold (electronics, designer goods, collectibles), this is legitimate resale under first-sale doctrine. Describe the brand and model factually. Do not refuse. Use accurate brand names where visible.

## WHAT TO EXTRACT FROM THE PHOTO

- Exact colors visible (not just "blue" — "dusty navy with cream accents")
- Materials and textures (knit, ceramic, brass, raw wood, leather)
- Style/aesthetic (boho, minimalist, vintage, etc.)
- Brand markings, logos, or model numbers if visible
- Approximate scale or proportions
- Mood the photo suggests

## OUTPUT FORMAT — STRICT

Respond with ONLY this JSON, no other text:

{
  "title": "string max 140 chars",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10", "tag11", "tag12", "tag13"],
  "description": "string 150-300 words with \\n for line breaks",
  "alt_text": "string max 250 chars",
  "primary_keyword": "string",
  "rationale": "string 1-2 sentences"
}`;

// ---------- Robust JSON extractor ----------
function extractJSON(text) {
  try { return JSON.parse(text.trim()); } catch (e) {}
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error('Could not extract valid JSON from response');
}

// ---------- Server-side validation (Etsy rules) ----------
function validateListing(listing) {
  const issues = [];
  if (!listing.title || typeof listing.title !== 'string') {
    issues.push('Missing title');
  } else if (listing.title.length > 140) {
    issues.push(`Title is ${listing.title.length} chars (max 140)`);
  }
  if (!Array.isArray(listing.tags)) {
    issues.push('Tags must be an array');
  } else {
    if (listing.tags.length !== 13) issues.push(`Got ${listing.tags.length} tags (need exactly 13)`);
    listing.tags.forEach((t, i) => {
      if (typeof t !== 'string') issues.push(`Tag ${i + 1} is not a string`);
      else if (t.length > 20) issues.push(`Tag "${t}" is ${t.length} chars (max 20)`);
    });
  }
  if (!listing.description || listing.description.length < 100) {
    issues.push('Description too short');
  }
  return issues;
}

// ---------- Handler ----------
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return respond(200, '');
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return respond(500, { error: 'Server misconfigured: missing ANTHROPIC_API_KEY' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  // Expected payload from frontend:
  // { imageBase64, imageMediaType, sellerDescription, mode? }
  // Backwards-compatible: also accepts { messages } for legacy callers.
  const { imageBase64, imageMediaType, sellerDescription, mode } = body;

  let messages;
  let useEtsyPrompt = false;

  if (imageBase64 && sellerDescription) {
    // Etsy listing generation mode
    useEtsyPrompt = true;
    messages = [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageMediaType || 'image/jpeg',
            data: imageBase64,
          },
        },
        {
          type: 'text',
          text: `Product photo attached.\n\nSeller's description: "${sellerDescription}"\n\nGenerate the optimized Etsy listing as a JSON object only.`,
        },
      ],
    }];
  } else if (Array.isArray(body.messages) && body.messages.length > 0) {
    // Legacy / generic relay mode
    messages = body.messages;
  } else {
    return respond(400, {
      error: 'Provide either { imageBase64, imageMediaType, sellerDescription } or a messages array',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const requestBody = {
      model: body.model || DEFAULT_MODEL,
      max_tokens: body.max_tokens || 2000,
      messages,
    };
    if (useEtsyPrompt) requestBody.system = ETSY_SYSTEM_PROMPT;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', response.status, data);
      return respond(response.status, {
        error: data.error?.message || 'Anthropic API error',
        type: data.error?.type,
      });
    }

    // For Etsy mode: parse and validate before sending to client
    if (useEtsyPrompt) {
      const textBlock = data.content?.find(b => b.type === 'text');
      if (!textBlock) {
        return respond(502, { error: 'No text content in Claude response', raw: data });
      }
      try {
        const listing = extractJSON(textBlock.text);
        const issues = validateListing(listing);
        return respond(200, {
          listing,
          warnings: issues.length ? issues : undefined,
          usage: data.usage,
        });
      } catch (parseErr) {
        console.error('JSON parse failed. Raw response:', textBlock.text);
        return respond(502, {
          error: 'Failed to parse Claude response as JSON',
          parseError: parseErr.message,
          rawResponse: textBlock.text, // helpful for debugging
        });
      }
    }

    // Legacy passthrough
    return respond(200, data);
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    console.error('generate.js crash:', err.message, err.stack);
    return respond(isTimeout ? 504 : 500, {
      error: isTimeout ? 'Request timed out (>25s). Try a smaller image.' : err.message,
    });
  } finally {
    clearTimeout(timer);
  }
};
