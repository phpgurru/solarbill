/* Shared header: signed-in visitors see "My account" (or "My bills" on the account page) instead of "Sign in". */
fetch('/api/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(me => {
  const a = document.querySelector('#nav-signin');
  if (!a || !me || !me.user) return;
  const onAccount = location.pathname.startsWith('/account');
  a.textContent = onAccount ? 'My bills' : 'My account';
  a.href = onAccount ? '/app' : '/account';
  a.title = me.user.email;
}).catch(() => {});
