// Hueleo — Claude API proxy. Node 22 has native fetch; no node-fetch needed.
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

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return respond(400, { error: 'messages array is required' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || DEFAULT_MODEL,
        max_tokens: body.max_tokens || 1500,
        messages: body.messages,
      }),
    });

    const data = await response.json();

    // Surface Anthropic errors instead of hiding them as 200s
    if (!response.ok) {
      console.error('Anthropic API error:', response.status, data);
      return respond(response.status, {
        error: data.error?.message || 'Anthropic API error',
        type: data.error?.type,
      });
    }

    return respond(200, data);
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    console.error('generate.js crash:', err.message, err.stack);
    return respond(isTimeout ? 504 : 500, {
      error: isTimeout ? 'Request timed out (>25s). Try a smaller image.' : err.message,
    });
  } finally {
    clearTimeout(timer);
  }
};
