const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

async function verifyToken(event) {
  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return { user: null, error: 'Missing or malformed Authorization header' };
  }
  const token = auth.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { user: null, error: 'Invalid or expired session token' };
  }
  return { user: data.user, error: null };
}

function unauthorized(message) {
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message || 'Unauthorized' }),
  };
}

module.exports = { verifyToken, unauthorized, supabase };
