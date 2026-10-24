/**
 * OAuth redirect target for the hosted MCP playground. It hands the
 * authorization response (code and state, or an error) to the page that opened
 * the sign-in window, then closes. The code never leaves this origin: it goes
 * to the opener with postMessage restricted to this exact origin, or over a
 * same-origin BroadcastChannel when the provider severed window.opener.
 */
const params = new URLSearchParams(location.search);
const message = {
  type: 'mcp-oauth-callback',
  state: params.get('state'),
  code: params.get('code'),
  iss: params.get('iss'),
  error: params.get('error'),
  error_description: params.get('error_description'),
};

// Take the code out of the address bar and history right away.
history.replaceState(null, '', location.pathname);

let delivered = false;
try {
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(message, location.origin);
    delivered = true;
  }
} catch {
  // the opener is gone or cross-origin
}
try {
  const channel = new BroadcastChannel('mcp-playground-oauth');
  channel.postMessage(message);
  channel.close();
  delivered = true;
} catch {
  // BroadcastChannel unavailable
}

const title = document.getElementById('callback-title');
const text = document.getElementById('callback-message');
if (!message.state) {
  title.textContent = 'Nothing to do here';
  text.textContent = 'This page finishes sign-in for the MCP playground.';
} else if (message.error) {
  title.textContent = 'Sign-in did not finish';
  text.textContent = message.error_description || message.error;
} else if (delivered) {
  title.textContent = 'Signed in';
  text.textContent = 'You can close this window and return to the playground.';
  setTimeout(() => window.close(), 400);
} else {
  title.textContent = 'Return to the playground';
  text.textContent =
    'Sign-in finished, but this window could not reach the playground. Close it and try again.';
}
