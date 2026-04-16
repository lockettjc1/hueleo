// Shared auth + Supabase admin client for Netlify functions.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json',
};

async function verifyToken(event) {
  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return { user: null, error: 'Missing Authorization header' };
  }
  const token = auth.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { user: null, error: 'Invalid or expired session' };
  }
  return { user: data.user, error: null };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function unauthorized(message) {
  return respond(401, { error: message || 'Unauthorized' });
}

module.exports = { verifyToken, unauthorized, respond, supabase, CORS };
