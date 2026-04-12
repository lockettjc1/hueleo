const SUPABASE_URL = 'https://rgplbptyikcbooaadsvz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

exports.handler = async function(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, stripe-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const body = JSON.parse(event.body);

    // Direct update (called after successful checkout)
    if (body.action === 'update') {
      const { email, plan } = body;
      
      // Update user plan in database
      const res = await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ plan })
      });
      const updated = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify({ user: updated[0] }) };
    }

    // Get user plan
    if (body.action === 'get') {
      const { email } = body;
      const res = await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=*`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const users = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify({ user: users[0] || null }) };
    }

    // Update gens used
    if (body.action === 'increment_gens') {
      const { email } = body;
      const getRes = await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=gens_used`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const users = await getRes.json();
      const current = users[0]?.gens_used || 0;
      
      await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ gens_used: current + 1 })
      });
      return { statusCode: 200, headers, body: JSON.stringify({ gens_used: current + 1 }) };
    }

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
