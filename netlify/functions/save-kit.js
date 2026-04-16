// Saves/loads/deletes brand kits. Uses authenticated user id, not arbitrary email.

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

  const { action, kit } = body;

  try {
    if (action === 'save') {
      if (!kit) return respond(400, { error: 'Missing kit data' });

      const { data, error: dbError } = await supabase
        .from('kits')
        .insert({
          user_email: authUser.email,
          business_name: kit.businessName,
          industry: kit.industry,
          vibe: kit.vibe,
          kit_data: kit,
        })
        .select()
        .single();

      if (dbError) throw dbError;
      return respond(200, { kit: data });
    }

    if (action === 'load') {
      const { data, error: dbError } = await supabase
        .from('kits')
        .select('*')
        .eq('user_email', authUser.email)
        .order('created_at', { ascending: false });

      if (dbError) throw dbError;
      return respond(200, { kits: data || [] });
    }

    if (action === 'delete') {
      if (!kit?.id) return respond(400, { error: 'Missing kit id' });

      const { error: dbError } = await supabase
        .from('kits')
        .delete()
        .eq('id', kit.id)
        .eq('user_email', authUser.email); // only delete own kits

      if (dbError) throw dbError;
      return respond(200, { success: true });
    }

    return respond(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('save-kit error:', err.message, err.stack);
    return respond(500, { error: err.message });
  }
};
