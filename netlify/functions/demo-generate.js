// Hueleo — unauthenticated demo generation.
//
// Visitors get 2 generations per IP per 24 hours. We hash IPs (SHA-256) before
// storing so demo_usage doesn't hold PII. Output is truncated server-side
// (full title + full tags + first part of description) so the signup wall has
// real friction.
//
// Required env vars:
//   ANTHROPIC_API_KEY
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY  (service role)

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const API_TIMEOUT_MS = 25000;
const DAILY_LIMIT = 2;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Visible part of the description (chars). Tuned for "first paragraph-ish"
// — long enough to be useful, short enough to leave the visitor wanting more.
const DESCRIPTION_PREVIEW_CHARS = 220;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: CORS,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// Reused from generate.js. Keep the prompt consistent so the demo experience
// matches what authenticated users get.
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

function extractJSON(text) {
  try { return JSON.parse(text.trim()); } catch (e) {}
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found');
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
  throw new Error('Could not extract JSON');
}

function getClientIp(event) {
  // Netlify forwards the real IP in x-nf-client-connection-ip; fall back to
  // x-forwarded-first hop. We hash whatever we get; if it's null we use the
  // string 'unknown' so unknowns share one bucket (still rate-limited).
  const headers = event.headers || {};
  const ip =
    headers['x-nf-client-connection-ip'] ||
    (headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    headers['client-ip'] ||
    'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex');
}

// Truncate description to the first natural break under DESCRIPTION_PREVIEW_CHARS.
// Prefers ending on a paragraph break, then sentence, then word boundary.
function truncateDescription(desc) {
  if (!desc || desc.length <= DESCRIPTION_PREVIEW_CHARS) return desc;
  const window = desc.slice(0, DESCRIPTION_PREVIEW_CHARS);
  const paraBreak = window.lastIndexOf('\n');
  if (paraBreak > DESCRIPTION_PREVIEW_CHARS * 0.5) return window.slice(0, paraBreak).trim() + '…';
  const sentenceBreak = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentenceBreak > DESCRIPTION_PREVIEW_CHARS * 0.5) return window.slice(0, sentenceBreak + 1).trim() + ' …';
  const wordBreak = window.lastIndexOf(' ');
  return window.slice(0, wordBreak).trim() + '…';
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return respond(200, '');
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return respond(500, { error: 'Server misconfigured' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Invalid JSON body' }); }

  const { imageBase64, imageMediaType, sellerDescription } = body;
  if (!imageBase64 || !sellerDescription) {
    return respond(400, { error: 'A photo and description are required.' });
  }

  // --- Rate limit ---
  const ipHash = getClientIp(event);
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count, error: countError } = await supabase
    .from('demo_usage')
    .select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash)
    .gte('created_at', since);

  if (countError) {
    console.error('demo rate-limit lookup failed:', countError.message);
    // Fail open rather than block legit users on infra hiccups.
  } else if ((count || 0) >= DAILY_LIMIT) {
    return respond(429, {
      error: 'limit',
      message: `You've used your ${DAILY_LIMIT} free demo generations for today. Sign up to keep generating — it's free.`,
      remaining: 0,
    });
  }

  // --- Call Claude ---
  const messages = [{
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let claudeResponse;
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 2500,
        system: ETSY_SYSTEM_PROMPT,
        messages,
      }),
    });
    claudeResponse = await apiRes.json();
    if (!apiRes.ok) {
      console.error('Anthropic API error:', apiRes.status, claudeResponse);
      return respond(apiRes.status, { error: claudeResponse.error?.message || 'Generation failed' });
    }
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    console.error('demo-generate crash:', err.message);
    return respond(isTimeout ? 504 : 500, {
      error: isTimeout ? 'Generation took too long. Try a smaller image.' : 'Generation failed.',
    });
  } finally {
    clearTimeout(timer);
  }

  // --- Parse ---
  const textBlock = claudeResponse.content?.find(b => b.type === 'text');
  if (!textBlock) return respond(502, { error: 'Empty response from model' });

  let listing;
  try { listing = extractJSON(textBlock.text); }
  catch (parseErr) {
    console.error('demo JSON parse failed:', parseErr.message);
    return respond(502, { error: 'Could not parse model response.' });
  }

  // --- Truncate description so the signup wall has friction ---
  const fullDescription = listing.description || '';
  const previewDescription = truncateDescription(fullDescription);
  const isTruncated = previewDescription !== fullDescription;

  // --- Record usage AFTER successful generation. Free retries on failures. ---
  const usage = claudeResponse.usage || {};
  await supabase.from('demo_usage').insert({
    ip_hash: ipHash,
    input_tokens: usage.input_tokens || null,
    output_tokens: usage.output_tokens || null,
  });
  const remaining = Math.max(0, DAILY_LIMIT - ((count || 0) + 1));

  return respond(200, {
    listing: {
      title: listing.title || '',
      tags: Array.isArray(listing.tags) ? listing.tags : [],
      description: previewDescription,
      // Intentionally omit: full description, alt_text, primary_keyword, rationale.
      // These are part of the signup motivation.
    },
    truncated: isTruncated,
    remaining,
    limit: DAILY_LIMIT,
  });
};
