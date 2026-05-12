// Stripe webhook — single source of truth for plan changes.
//
// Events handled:
//   checkout.session.completed       -> upgrade user to plan from session metadata
//   customer.subscription.updated    -> sync plan (handles plan switches + renewals)
//   customer.subscription.deleted    -> downgrade to free
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY  (service role; already used by other functions)
//
// Netlify note: this function needs the RAW request body to verify Stripe's
// signature. We read event.body and parse based on event.isBase64Encoded.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Map Stripe price IDs -> internal plan names.
// Keep in sync with create-checkout.js.
const PRICE_TO_PLAN = {
  price_1TLSVc6g0JkZsl1UvRubB9ND: 'studio',
  price_1TLSWJ6g0JkZsl1UASskjaBa: 'atelier',
};

function planFromSubscription(subscription) {
  // Stripe sometimes nests price under items.data[0].price
  const item = subscription?.items?.data?.[0];
  const priceId = item?.price?.id;
  return PRICE_TO_PLAN[priceId] || null;
}

// Look up our Supabase user by either user_id metadata, client_reference_id,
// stripe_customer_id, or email — in that order of trust.
async function findUserForEvent({ userId, customerId, email }) {
  if (userId) {
    const { data } = await supabase
      .from('users')
      .select('id, email, plan')
      .eq('id', userId)
      .maybeSingle();
    if (data) return data;
  }
  if (customerId) {
    const { data } = await supabase
      .from('users')
      .select('id, email, plan')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    if (data) return data;
  }
  if (email) {
    const { data } = await supabase
      .from('users')
      .select('id, email, plan')
      .eq('email', email)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

async function updateUser(userId, patch) {
  const { error } = await supabase
    .from('users')
    .update(patch)
    .eq('id', userId);
  if (error) {
    console.error('updateUser failed:', userId, patch, error.message);
    throw error;
  }
  console.log('updateUser ok:', userId, patch);
}

async function handleCheckoutCompleted(session) {
  const userId = session.client_reference_id || session.metadata?.user_id;
  const customerId = session.customer;
  const email = session.customer_details?.email || session.customer_email;

  // Plan: prefer metadata (set by create-checkout). Fall back to subscription lookup.
  let plan = session.metadata?.plan;
  if (!plan && session.subscription) {
    const sub = await stripe.subscriptions.retrieve(session.subscription);
    plan = planFromSubscription(sub);
  }

  if (!plan) {
    console.warn('checkout.session.completed without resolvable plan', session.id);
    return;
  }

  const user = await findUserForEvent({ userId, customerId, email });
  if (!user) {
    console.warn('checkout.session.completed: no matching Supabase user', { userId, customerId, email });
    return;
  }

  await updateUser(user.id, {
    plan,
    stripe_customer_id: customerId || null,
    stripe_subscription_id: session.subscription || null,
  });
}

async function handleSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  const user = await findUserForEvent({ customerId });
  if (!user) {
    console.warn('subscription.updated: no matching user for customer', customerId);
    return;
  }

  // status determines whether the subscription entitles them to a paid plan.
  // 'active' and 'trialing' = paid. Anything else (past_due, unpaid, canceled,
  // incomplete, incomplete_expired, paused) -> downgrade to free.
  const entitled = subscription.status === 'active' || subscription.status === 'trialing';
  const plan = entitled ? (planFromSubscription(subscription) || 'free') : 'free';

  await updateUser(user.id, {
    plan,
    stripe_subscription_id: subscription.id,
  });
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  const user = await findUserForEvent({ customerId });
  if (!user) {
    console.warn('subscription.deleted: no matching user for customer', customerId);
    return;
  }
  await updateUser(user.id, {
    plan: 'free',
    stripe_subscription_id: null,
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!signature) {
    return { statusCode: 400, body: 'Missing Stripe-Signature header' };
  }

  // Stripe needs the raw, unparsed body to verify the signature.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log('Stripe webhook received:', stripeEvent.type, stripeEvent.id);

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(stripeEvent.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;
      default:
        // Acknowledge but ignore other event types.
        console.log('Ignoring event type:', stripeEvent.type);
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message, err.stack);
    // Return 500 so Stripe retries.
    return { statusCode: 500, body: `Handler error: ${err.message}` };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
