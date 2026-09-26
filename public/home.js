/* Solar Bill homepage: image reveal. The page works fully without it. The header is handled by site.js. */
document.documentElement.classList.add('js');

const els = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('on'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
  els.forEach(el => io.observe(el));
} else els.forEach(el => el.classList.add('on'));
