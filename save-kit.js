const SUPABASE_URL = 'https://rgplbptyikcbooaadsvz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

exports.handler = async function(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const { action, email, kit } = JSON.parse(event.body);

    if (action === 'save') {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/kits`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          user_email: email,
          business_name: kit.businessName,
          industry: kit.industry,
          vibe: kit.vibe,
          kit_data: kit
        })
      });
      const saved = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify({ kit: saved }) };
    }

    if (action === 'load') {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/kits?user_email=eq.${encodeURIComponent(email)}&order=created_at.desc&select=*`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const kits = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify({ kits }) };
    }

    if (action === 'delete') {
      await fetch(`${SUPABASE_URL}/rest/v1/kits?id=eq.${kit.id}`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
