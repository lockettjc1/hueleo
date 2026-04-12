exports.handler = async function(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const { plan, email } = JSON.parse(event.body);
    
    const priceId = plan === 'studio' 
      ? 'price_1TLSVc6g0JkZsl1UvRubB9ND'
      : 'price_1TLSWJ6g0JkZsl1UASskjaBa';

    const successUrl = 'https://hueleo.com/success?plan=' + plan + '&session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl = 'https://hueleo.com';

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'payment_method_types[]': 'card',
        'mode': 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'success_url': successUrl,
        'cancel_url': cancelUrl,
        'customer_email': email || '',
        'allow_promotion_codes': 'true'
      }).toString()
    });

    const session = await response.json();

    if (session.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: session.error.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ url: session.url }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
