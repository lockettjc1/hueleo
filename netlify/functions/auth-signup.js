const SUPABASE_URL = 'https://rgplbptyikcbooaadsvz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

exports.handler = async function(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const { email, name, password } = JSON.parse(event.body);

    // Check if user exists
    const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=*`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const existing = await checkRes.json();

    if (existing && existing.length > 0) {
      // User exists - return their data (login)
      return { statusCode: 200, headers, body: JSON.stringify({ user: existing[0], action: 'login' }) };
    }

    // Create new user
    const createRes = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ email, name, plan: 'free', gens_used: 0 })
    });
    const newUser = await createRes.json();
    const user = Array.isArray(newUser) ? newUser[0] : newUser;

    return { statusCode: 200, headers, body: JSON.stringify({ user, action: 'signup' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
