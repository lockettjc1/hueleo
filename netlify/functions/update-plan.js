// Manage user plan + generation counts. All actions scoped to authenticated user.

const { verifyToken, unauthorized, respond, supabase } = require('./_verify');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return respond(200, '');

  const { user: authUser, error } = await verifyToken(event);
  if (error) return unauthorized(error);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { action } = body;

  try {
    if (action === 'get') {
      const { data, error: dbError } = await supabase
        .from('users')
        .select('*')
        .eq('id', authUser.id)
        .single();

      if (dbError) throw dbError;
      return respond(200, { user: data });
    }

    if (action === 'update') {
      // Note: in production plan changes should come from Stripe webhook, not client.
      // This is here for post-checkout success page flow only.
      const { plan } = body;
      if (!['free', 'studio', 'atelier'].includes(plan)) {
        return respond(400, { error: 'Invalid plan' });
      }

      const { data, error: dbError } = await supabase
        .from('users')
        .update({ plan })
        .eq('id', authUser.id)
        .select()
        .single();

      if (dbError) throw dbError;
      return respond(200, { user: data });
    }

    if (action === 'increment_gens') {
      // Atomic-ish increment
      const { data: current } = await supabase
        .from('users')
        .select('gens_used')
        .eq('id', authUser.id)
        .single();

      const newCount = (current?.gens_used || 0) + 1;

      const { error: dbError } = await supabase
        .from('users')
        .update({ gens_used: newCount })
        .eq('id', authUser.id);

      if (dbError) throw dbError;
      return respond(200, { gens_used: newCount });
    }

    return respond(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('update-plan error:', err.message, err.stack);
    return respond(500, { error: err.message });
  }
};
