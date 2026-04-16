// Create Stripe Checkout session. Requires authenticated user.

const Stripe = require('stripe');
const { verifyToken, unauthorized, respond } = require('./_verify');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  studio: 'price_1TLSVc6g0JkZsl1UvRubB9ND',
  atelier: 'price_1TLSWJ6g0JkZsl1UASskjaBa',
};

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

  const priceId = PRICE_IDS[body.plan];
  if (!priceId) return respond(400, { error: 'Invalid plan' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: authUser.email,
      allow_promotion_codes: true,
      success_url: `https://hueleo.com/success?plan=${body.plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: 'https://hueleo.com',
      client_reference_id: authUser.id, // tie Stripe session back to user
      metadata: {
        user_id: authUser.id,
        plan: body.plan,
      },
    });

    return respond(200, { url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err.message);
    return respond(500, { error: err.message });
  }
};
