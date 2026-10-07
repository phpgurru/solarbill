/* Builds the guides section from content/ into public/.
   content/blog/<slug>.html  a JSON header between --- lines, then the article body (HTML)
   content/questions.json    the questions hub (/questions)
   Writes public/blog/<slug>.html, public/blog/index.html, public/questions.html,
   public/sitemap.xml and public/llms.txt. Run: npm run build:blog */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://solarbill.pk';
const OUT = join(ROOT, 'public');
const SRC = join(ROOT, 'content');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = s => String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[lr]squo;|&rsquo;/g, '’').replace(/\s+/g, ' ').trim();
const slugify = s => strip(s).toLowerCase().replace(/[’'"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const longDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const ld = o => `<script type="application/ld+json">\n${JSON.stringify(o, null, 1).replace(/</g, '\\u003c')}\n</script>`;

const TOPICS = [
  { key: 'basics', name: 'Read your bill', blurb: 'Every line, code and number on a net-metering bill.' },
  { key: 'why', name: 'Why the bill is high', blurb: 'Peak hours, settlement, fixed charges and taxes.' },
  { key: 'rules', name: '2026 rules and rates', blurb: 'Net billing, buyback rates and what changed for existing users.' },
  { key: 'action', name: 'Fix it and save', blurb: 'Wrong bills, complaints, and getting more out of your panels.' },
];

/* ---------- shared page parts ---------- */
const NAV = cur => `<header class="nav">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Solar Bill home"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>Solar Bill</a>
    <nav aria-label="Main">
      <a href="/#why">Why you still pay</a>
      <a href="/blog/"${cur === 'blog' ? ' aria-current="page"' : ''}>Guides</a>
      <a href="/questions"${cur === 'questions' ? ' aria-current="page"' : ''}>Questions</a>
      <a href="/#rules">2026 rules</a>
      <a href="/#faq">FAQ</a>
    </nav>
    <a class="signin" id="nav-signin" href="/signin">Sign in</a>
    <a class="pill sm" href="/app">Check a bill</a>
  </div>
</header>`;

const FOOT = `<footer class="foot">
  <div class="wrap">
    <p class="legal">Bills are read inside your browser. When you sign in, each PDF and its figures are saved privately to your account, and you can download or delete them any time. Solar Bill is an independent tool, not affiliated with NEPRA, PITC or any electricity distribution company.</p>
    <nav aria-label="Footer">
      <a href="/app">Check a bill</a>
      <a href="/app?sample=1">Sample bill</a>
      <a href="/blog/">Guides</a>
      <a href="/questions">Questions</a>
      <a href="/account">My account</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
    </nav>
    <p>© 2026 Solar Bill</p>
  </div>
</footer>
<script src="/site.js" defer></script>`;

function head({ title, description, path, type = 'website', image = '/img/og.png', schema }) {
  return `<!doctype html>
<html lang="en-PK">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="Solar Bill">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:title" content="${esc(title.replace(/ · Solar Bill$/, ''))}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}${image}">
<meta property="og:locale" content="en_PK">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400;500;600;700&display=swap">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/blog.css">
${ld(schema)}
</head>
<body>
`;
}

const ORG = { '@type': 'Organization', '@id': `${SITE}/#org`, name: 'Solar Bill', url: `${SITE}/`, logo: `${SITE}/favicon.svg` };
const crumbs = list => ({ '@type': 'BreadcrumbList', itemListElement: list.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE + path })) });
const faqSchema = (items, id) => ({ '@type': 'FAQPage', '@id': id, mainEntity: items.map(([q, a]) => ({ '@type': 'Question', name: strip(q), acceptedAnswer: { '@type': 'Answer', text: strip(a) } })) });
const faqHtml = items => `<div class="faq">\n${items.map(([q, a, link]) => `<details><summary>${q}</summary><div class="a"><p>${a}</p>${link ? `<a class="go more" href="${link[0]}">${link[1]}</a>` : ''}</div></details>`).join('\n')}\n</div>`;

/* ---------- read posts ---------- */
function readPosts() {
  const dir = join(SRC, 'blog');
  return readdirSync(dir).filter(f => f.endsWith('.html')).map(f => {
    const raw = readFileSync(join(dir, f), 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) throw new Error(`${f}: missing --- JSON header`);
    let meta;
    try { meta = JSON.parse(m[1]); } catch (e) { throw new Error(`${f}: bad JSON header: ${e.message}`); }
    const slug = f.replace(/\.html$/, '');
    for (const k of ['title', 'seoTitle', 'description', 'dek', 'topic', 'date', 'answer']) if (!meta[k]) throw new Error(`${f}: missing "${k}"`);
    if (!TOPICS.some(t => t.key === meta.topic)) throw new Error(`${f}: unknown topic ${meta.topic}`);
    // give every h2 an id, and collect them for the table of contents
    const toc = [];
    const body = m[2].replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/g, (all, attrs = '', inner) => {
      const idm = attrs.match(/id="([^"]+)"/); const id = idm ? idm[1] : slugify(inner);
      toc.push([id, strip(inner)]);
      return idm ? all : `<h2 id="${id}"${attrs}>${inner}</h2>`;
    });
    const words = strip(body).split(' ').length;
    return { slug, path: `/blog/${slug}`, ...meta, updated: meta.updated || meta.date, body, toc, minutes: Math.max(2, Math.round(words / 220)), faq: meta.faq || [] };
  }).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || b.updated.localeCompare(a.updated));
}

/* ---------- article page ---------- */
function postPage(p, all) {
  const topic = TOPICS.find(t => t.key === p.topic);
  const related = (p.related || []).map(s => all.find(x => x.slug === s)).filter(Boolean);
  for (const x of all) if (related.length < 4 && x !== p && x.topic === p.topic && !related.includes(x)) related.push(x);
  const schema = { '@context': 'https://schema.org', '@graph': [
    ORG,
    { '@type': 'BlogPosting', '@id': `${SITE}${p.path}#post`, headline: p.title, description: p.description, inLanguage: 'en-PK',
      datePublished: p.date, dateModified: p.updated, mainEntityOfPage: `${SITE}${p.path}`, image: `${SITE}/img/og.png`,
      author: ORG, publisher: { '@id': `${SITE}/#org` }, about: p.keywords ? p.keywords.slice(0, 5) : undefined,
      keywords: p.keywords ? p.keywords.join(', ') : undefined, wordCount: strip(p.body).split(' ').length,
      speakable: { '@type': 'SpeakableSpecification', cssSelector: ['.answer'] } },
    crumbs([['Home', '/'], ['Guides', '/blog/'], [p.title, p.path]]),
    ...(p.howto ? [{ '@type': 'HowTo', name: p.howto.name, step: p.howto.steps.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s[0], text: s[1] })) }] : []),
    ...(p.faq.length ? [faqSchema(p.faq, `${SITE}${p.path}#faq`)] : []),
  ] };
  return head({ title: `${p.seoTitle} · Solar Bill`, description: p.description, path: p.path, type: 'article', schema }) + `${NAV('blog')}
<main>
<article class="post">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">›</span><a href="/blog/">Guides</a><span aria-hidden="true">›</span><a href="/blog/#${topic.key}">${topic.name}</a></nav>
  <h1>${p.title}</h1>
  <p class="dek">${p.dek}</p>
  <p class="meta">Updated <time datetime="${p.updated}">${longDate(p.updated)}</time> · ${p.minutes} min read</p>
  <div class="answer"><b class="l">Short answer</b>${p.answer}</div>
${p.toc.length > 2 ? `  <nav class="toc" aria-label="In this guide"><b>In this guide</b><ol>${p.toc.map(([id, t]) => `<li><a href="#${id}">${esc(t)}</a></li>`).join('')}${p.faq.length ? '<li><a href="#faq">Questions</a></li>' : ''}</ol></nav>\n` : ''}  <div class="prose">
${p.body.trim()}
  </div>
${p.faq.length ? `  <section class="prose" aria-labelledby="faq"><h2 id="faq">Questions people ask</h2>\n${faqHtml(p.faq)}\n  </section>\n` : ''}  <aside class="cta">
    <h2>See this on your own bill</h2>
    <p>Add your DISCO web-bill PDF. Solar Bill reads it inside your browser and explains every figure in plain words.</p>
    <div class="row"><a class="pill" href="/app">Check your bill</a><a class="more" href="/app?sample=1">See a sample bill</a></div>
  </aside>
${related.length ? `  <nav class="related" aria-label="Related guides"><h2>Keep reading</h2><ul>${related.slice(0, 4).map(r => `<li><a href="${r.path}">${r.title}<span>${r.dek}</span></a></li>`).join('')}</ul></nav>\n` : ''}${explore(p, all)}
  <p class="disclaimer">Solar Bill is independent and not affiliated with NEPRA, PITC or any DISCO. Rates, taxes and rules change; your DISCO’s bill is the official record. Policy facts above link to their public sources.</p>
</article>
</main>
${FOOT}
</body>
</html>
`;
}

/* Links every guide back to the rest of the site: homepage sections, tools, and every other guide by topic */
function explore(p, all) {
  const site = [['/', 'Solar Bill home'], ['/#why', 'Why a net exporter still pays'], ['/#terms', 'Bill terms glossary'], ['/#rules', 'Net metering in 2026'], ['/#faq', 'Solar bill FAQ'], ['/questions', 'Every question, answered'], ['/app', 'Check your bill'], ['/app?sample=1', 'Sample LESCO bill']];
  const groups = TOPICS.map(t => [t, all.filter(x => x !== p && x.topic === t.key)]).filter(([, ps]) => ps.length);
  return `  <nav class="explore" aria-label="More from Solar Bill">
    <div><h2>Solar Bill</h2><ul>${site.map(([h, t]) => `<li><a href="${h}">${t}</a></li>`).join('')}</ul></div>
${groups.map(([t, ps]) => `    <div><h2><a href="/blog/#${t.key}">${t.name}</a></h2><ul>${ps.map(x => `<li><a href="${x.path}">${strip(x.title)}</a></li>`).join('')}</ul></div>`).join('\n')}
  </nav>`;
}

/* Homepage: the three featured guides, between the guides:start/end markers in public/index.html */
function homeGuides(posts) {
  const top = posts.filter(p => p.featured).concat(posts.filter(p => !p.featured)).slice(0, 3);
  const html = `<!-- guides:start -->\n      <ul class="guides">\n${top.map(p => `        <li><a href="${p.path}"><span class="k">${TOPICS.find(t => t.key === p.topic).name}</span><h3>${p.title}</h3><p>${p.dek}</p><span class="m">Read the guide ›</span></a></li>`).join('\n')}\n      </ul>\n      <!-- guides:end -->`;
  const file = join(OUT, 'index.html'), cur = readFileSync(file, 'utf8');
  if (!/<!-- guides:start -->[\s\S]*<!-- guides:end -->/.test(cur)) throw new Error('index.html: missing guides markers');
  writeFileSync(file, cur.replace(/<!-- guides:start -->[\s\S]*<!-- guides:end -->/, html));
}

/* ---------- blog index ---------- */
function indexPage(posts) {
  const schema = { '@context': 'https://schema.org', '@graph': [
    ORG,
    { '@type': 'Blog', '@id': `${SITE}/blog/#blog`, name: 'Solar Bill Guides', url: `${SITE}/blog/`, inLanguage: 'en-PK', publisher: { '@id': `${SITE}/#org` },
      blogPost: posts.map(p => ({ '@type': 'BlogPosting', headline: p.title, url: SITE + p.path, datePublished: p.date, dateModified: p.updated })) },
    crumbs([['Home', '/'], ['Guides', '/blog/']]),
  ] };
  const card = p => `<li><a class="card" href="${p.path}"><span class="k">${TOPICS.find(t => t.key === p.topic).name}</span><h3>${p.title}</h3><p>${p.dek}</p><span class="m">${p.minutes} min read</span></a></li>`;
  return head({ title: 'Net-Metering Bill Guides for Pakistan · Solar Bill', description: 'Plain-language guides to Pakistani net-metering and net-billing electricity bills: how LESCO, IESCO, FESCO, GEPCO, MEPCO, PESCO and HESCO calculate them, why solar users still pay, and what changed in 2026.', path: '/blog/', schema }) + `${NAV('blog')}
<main>
  <header class="bhead"><div class="wrap">
    <span class="eyebrow">Guides</span>
    <h1>Your solar bill, explained line by line.</h1>
    <p>How DISCOs calculate a net-metering bill, why exporting more than you use can still end in a bill, and what the 2026 net-billing rules mean for you. Short answers first, the full working underneath.</p>
    <p><a class="more" href="/questions">Browse every question, answered</a></p>
  </div></header>
${TOPICS.map(t => { const ps = posts.filter(p => p.topic === t.key); return ps.length ? `  <section class="topic wrap" id="${t.key}"><h2>${t.name}</h2><p>${t.blurb}</p><ul class="cards">${ps.map(card).join('')}</ul></section>` : ''; }).join('\n')}
  <div class="blog-end"></div>
</main>
${FOOT}
</body>
</html>
`;
}

/* ---------- questions hub ---------- */
function questionsPage(groups, posts) {
  const all = groups.flatMap(g => g.items.map(i => [i.q, i.a, i.link ? [i.link, linkText(i.link, posts)] : null]));
  const schema = { '@context': 'https://schema.org', '@graph': [ORG, crumbs([['Home', '/'], ['Questions', '/questions']]), faqSchema(all, `${SITE}/questions#faq`)] };
  return head({ title: 'Net-Metering & Solar Bill Questions Answered (Pakistan) · Solar Bill', description: `${all.length} answers about Pakistani net-metering and solar electricity bills: import and export units, peak hours, buyback rates, fixed charges, FPA, taxes, settlement, net billing in 2026 and how to complain to your DISCO or NEPRA.`, path: '/questions', schema }) + `${NAV('questions')}
<main>
  <header class="bhead"><div class="wrap narrow" style="max-width:820px">
    <span class="eyebrow">Questions</span>
    <h1>Every solar bill question, answered.</h1>
    <p>${all.length} questions Pakistani solar users ask about their DISCO bill, each with a short answer and a link to the full guide.</p>
    <nav class="qnav" aria-label="Question topics">${groups.map(g => `<a href="#${g.id}">${esc(g.group)}</a>`).join('')}</nav>
  </div></header>
  <div class="wrap" style="max-width:820px">
${groups.map(g => `  <section class="qgroup prose" id="${g.id}"><h2>${g.group}</h2>\n${faqHtml(g.items.map(i => [i.q, i.a, i.link ? [i.link, linkText(i.link, posts)] : null]))}\n  </section>`).join('\n')}
    <aside class="cta" style="margin-bottom:clamp(64px,8vw,104px)">
      <h2>Question not here?</h2>
      <p>Most answers depend on the numbers on your own bill. Add it and Solar Bill works them out for you.</p>
      <div class="row"><a class="pill" href="/app">Check your bill</a><a class="more" href="/blog/">Read the guides</a></div>
    </aside>
  </div>
</main>
${FOOT}
</body>
</html>
`;
}
function linkText(href, posts) { const p = posts.find(x => href.startsWith(x.path)); return p ? `Read: ${strip(p.title)}` : href === '/app' ? 'Check your bill' : 'Read more'; }

/* ---------- sitemap + llms.txt ---------- */
function sitemap(posts, today) {
  const urls = [['/', today], ['/app', today], ['/blog/', today], ['/questions', today], ...posts.map(p => [p.path, p.updated]), ['/privacy', '2026-09-27'], ['/terms', '2026-09-27']];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, d]) => `  <url><loc>${SITE}${u}</loc><lastmod>${d}</lastmod></url>`).join('\n')}\n</urlset>\n`;
}
function llms(posts, groups) {
  return `# Solar Bill

> Free web app that reads Pakistani net-metering electricity bills (LESCO, IESCO, FESCO, GEPCO, MEPCO, PESCO, HESCO) and explains them in plain words: import vs export units, peak vs off-peak cost, quarterly settlement, carried-forward credit, and solar savings. Bills are read inside the browser; signing in with Google saves them by consumer ID.

- [Homepage](${SITE}/): what Solar Bill does, why a net exporter can still get a bill, bill terms glossary, 2026 NEPRA rule changes, FAQ
- [Check a bill](${SITE}/app): the app; add a DISCO web-bill PDF
- [Sample bill](${SITE}/app?sample=1): a worked LESCO example
- [Questions answered](${SITE}/questions): ${groups.reduce((n, g) => n + g.items.length, 0)} short answers about solar and net-metering bills in Pakistan
- [Guides](${SITE}/blog/): long-form explainers

## Guides

${posts.map(p => `- [${strip(p.title)}](${SITE}${p.path}): ${strip(p.description)}`).join('\n')}

## Policies

- [Privacy Policy](${SITE}/privacy): what is stored, who processes it, and how to delete it
- [Terms of Service](${SITE}/terms): terms of use; figures are informational and the DISCO bill is the official record
`;
}

/* ---------- build ---------- */
const posts = readPosts();
const groups = JSON.parse(readFileSync(join(SRC, 'questions.json'), 'utf8'));
for (const g of groups) for (const i of g.items) if (i.link && !i.link.startsWith('/app') && !posts.some(p => i.link.split('#')[0] === p.path) && !i.link.startsWith('/#')) throw new Error(`questions.json: "${i.q}" links to unknown ${i.link}`);
for (const p of posts) for (const s of p.related || []) if (!posts.some(x => x.slug === s)) throw new Error(`${p.slug}: unknown related post ${s}`);
const brokenLinks = (name, html) => { for (const [, href] of html.matchAll(/href="(\/blog\/[^"#]+)/g)) if (!posts.some(x => x.path === href)) throw new Error(`${name}: broken link ${href}`); };
for (const p of posts) brokenLinks(p.slug, p.body + JSON.stringify(p.faq) + p.answer);
for (const g of groups) brokenLinks('questions.json', JSON.stringify(g));

mkdirSync(join(OUT, 'blog'), { recursive: true });
for (const p of posts) writeFileSync(join(OUT, 'blog', `${p.slug}.html`), postPage(p, posts));
writeFileSync(join(OUT, 'blog', 'index.html'), indexPage(posts));
writeFileSync(join(OUT, 'questions.html'), questionsPage(groups, posts));
homeGuides(posts);
brokenLinks('index.html', readFileSync(join(OUT, 'index.html'), 'utf8'));
const today = posts.reduce((d, p) => p.updated > d ? p.updated : d, '2026-09-26');
writeFileSync(join(OUT, 'sitemap.xml'), sitemap(posts, today));
writeFileSync(join(OUT, 'llms.txt'), llms(posts, groups));
console.log(`Built ${posts.length} guides, ${groups.reduce((n, g) => n + g.items.length, 0)} questions.`);
