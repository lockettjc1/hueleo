const { verifyToken, unauthorized, respond, supabase } = require('./_verify');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return respond(200, '');

  const { user: authUser, error } = await verifyToken(event);
  if (error) return unauthorized(error);

  try {
    const { data, error: dbError } = await supabase
      .from('users')
      .upsert(
        {
          id: authUser.id,
          email: authUser.email,
          name: authUser.user_metadata?.name || authUser.email.split('@')[0],
        },
        { onConflict: 'id', ignoreDuplicates: false }
      )
      .select()
      .single();

    if (dbError) throw dbError;

    return respond(200, {
      user: {
        id: data.id,
        email: data.email,
        name: data.name,
        plan: data.plan || 'free',
        gens_used: data.gens_used || 0,
      },
    });
  } catch (err) {
    console.error('get-user error:', err.message, err.stack);
    return respond(500, { error: 'Could not fetch user profile' });
  }
};
