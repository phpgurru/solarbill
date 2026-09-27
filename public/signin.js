/* Sign-in page: already signed in goes straight to the app; show why we're here; mark the button busy on click. */
const qs = new URLSearchParams(location.search);
fetch('/api/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(me => { if (me && me.user) location.replace('/app'); }).catch(() => {});
if (qs.has('error')) document.querySelector('#err').hidden = false;
const n = parseInt(qs.get('keep'), 10);
if (n > 0) { const k = document.querySelector('#keep'); k.textContent = `The ${n} bill${n > 1 ? 's' : ''} you just added will be saved to your account.`; k.hidden = false; }
document.querySelector('#go').addEventListener('click', e => { e.currentTarget.setAttribute('aria-busy', 'true'); e.currentTarget.lastChild.textContent = 'Opening Google…'; });
// Coming back with the browser's Back button: reset the button
addEventListener('pageshow', () => { const g = document.querySelector('#go'); g.removeAttribute('aria-busy'); g.lastChild.textContent = 'Continue with Google'; });
