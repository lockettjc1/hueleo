// User profile actions. Scoped to authenticated user.
//
// SECURITY: Plan changes are NO LONGER accepted from the client.
// Stripe webhook (stripe-webhook.js) is the only writer of `plan`.
// The legacy 'update' action returns 410 Gone so any straggling frontend
// calls fail loudly instead of silently appearing to upgrade.

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
      // Plan changes must come from Stripe webhook. Refuse client writes.
      return respond(410, {
        error: 'Plan changes are managed by Stripe. This endpoint no longer accepts plan updates.',
      });
    }

    if (action === 'increment_gens') {
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
