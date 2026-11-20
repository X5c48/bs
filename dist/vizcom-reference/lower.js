(() => {
  const root = document.getElementById('referenceLower');
  if (!root) return;

  const site = 'https://vizcom.com';
  const app = 'https://app.vizcom.com/auth';
  const contact = site + '/contact';
  const media = name => 'media/lower-' + name;
  const cases = [
    ['Dennis Tan', 'dennis-tan', '1144759248', 'A behind-the-scenes look at designing gear for motocross.'],
    ['Dennis Mueller', 'dennis-mueller', '1146049248', 'How a footwear designer carries ideas across disciplines.'],
    ['Scott Robertson', 'scott-robertson', '1144758186', 'A conversation about design practice and the role of AI.'],
    ['Robert Munson', 'robert-munson', '1146050627', 'The design process behind the Cadillac CTS Coupe.'],
    ['Centro University', 'centro', '1217148954', 'An experiment in AI-assisted design education in Mexico City.'],
    ['Leadoff Studio', 'leadoff', '1232187085', 'How a design studio shares a product idea before it is built.'],
  ];

  const questions = [
    ['Can I use Vizcom for free?', 'Vizcom offers a free starter plan. You can explore available options on the pricing page.', 'View plans', site + '/pricing'],
    ['What payment methods can I use?', 'Vizcom accepts major credit and debit cards.'],
    ['Which roles are paid?', 'Admin and editor seats are paid. Viewers can read files without an editing seat.'],
    ['How does team billing work?', 'A workspace admin manages billing for all paid seats under one billing cycle.'],
    ['Can I switch from monthly to yearly?', 'A workspace admin can update the plan in billing settings. The new plan takes effect with the next billing cycle.'],
    ['Do I own the content I produce in Vizcom?', 'Vizcom says you keep ownership of what you create. See its terms for the conditions that apply to your account.', 'Read the terms', site + '/legal/terms-of-service'],
    ['Does Vizcom use my data to train AI models?', 'Data handling depends on your plan. Consult the privacy and data security pages for the current policy.', 'Data & Security', site + '/data-security'],
  ];

  const groups = [
    ['Explore', [['Product', '/product'], ['Download', '/download'], ['Careers', '/careers'], ['Challenges', '/challenges'], ['Case Studies', '/case-studies'], ['Archive', '/archive']]],
    ['Solutions', [['Enterprise', '/enterprise'], ['Industrial', '/solutions/industrial-design'], ['Footwear', '/solutions/footwear'], ['Gaming', '/solutions/gaming'], ['Apparel', '/solutions/apparel'], ['Automotive', '/solutions/automotive']]],
    ['Resources', [['Blog', '/blog'], ['Documentation', 'https://docs.vizcom.ai/'], ['Support', 'mailto:support@vizcom.com'], ['For Students', '/programs/students'], ['For Educators', '/programs/educators'], ['Data & Security', '/data-security'], ['Privacy Policy', '/legal/privacy-policy'], ['Terms of Service', '/legal/terms-of-service'], ['Trust', 'https://trust.vizcom.com/']]],
    ['Get Started', [['Book a demo', '/contact'], ['Pricing', '/pricing'], ['Login', app]]],
  ];

  const pic = (name, alt = '', extra = '') => '<img src="' + media(name + '.webp') + '" alt="' + alt + '" loading="lazy" decoding="async"' + extra + '>';
  const film = name => '<video src="' + media(name + '.mp4') + '" muted loop playsinline preload="none" aria-hidden="true"></video>';
  const button = (label, href, outline = false) => '<a class="vl-button' + (outline ? ' vl-outline' : '') + '" href="' + href + '">' + label + '</a>';

  const caseRail = cases.map(([name, key, id, desc], index) => {
    const title = index < 4 ? 'Design Decoded: ' + name : name;
    return '<button type="button" class="vl-case" data-case="' + index + '" aria-label="Watch ' + title + '">' +
      pic(key, '', ' draggable="false"') +
      '<span class="vl-case-copy"><strong>' + title + '</strong><span>' + desc + '</span></span><span class="vl-watch">Watch video</span></button>';
  }).join('');

  const faq = questions.map(([q, a, label, href]) => '<details name="vizcom-reference-faq" class="vl-faq-item"><summary>' + q + '<i aria-hidden="true"></i></summary><div class="vl-answer">' + a +
    (label ? '<p><a href="' + href + '">' + label + '</a></p>' : '') + '</div></details>').join('');

  const feature = (name, title, desc, visual, href) => '<article class="vl-feature vl-' + name + '">' +
    '<div class="vl-feature-media">' + visual + '</div><div class="vl-feature-copy"><div><h3>' + title + '</h3><p>' + desc + '</p></div>' +
    '<a href="' + href + '" aria-label="Explore ' + title + '">↗</a></div></article>';

  root.innerHTML =
    '<section class="vl-cases vl-section" id="cases" aria-labelledby="vl-cases-title">' +
      '<div class="vl-container vl-split"><h2 id="vl-cases-title">Bridging the gap from digital to physical</h2><div><p>See how design teams bring their work into the real world.</p>' + button('Book a demo', contact) + '</div></div>' +
      '<div class="vl-case-rail" tabindex="0" aria-label="Design case studies">' + caseRail + '</div>' +
      '<div class="vl-container vl-case-controls"><button type="button" data-slide="-1" aria-label="Previous case">←</button><button type="button" data-slide="1" aria-label="Next case">→</button></div>' +
    '</section>' +
    '<section class="vl-features vl-section" id="features" aria-labelledby="vl-features-title"><div class="vl-container vl-split"><h2 id="vl-features-title">Equipping designers for any challenge</h2><div>' + button('Learn more', site + '/product') + '</div></div>' +
      '<div class="vl-container vl-features-grid">' +
        feature('edit', 'Adjust and edit any image', 'Describe a change in natural design language.', pic('day', 'Daytime room') + pic('golden', '', ' class="vl-alt"') + pic('menu', '', ' class="vl-overlay"'), 'https://docs.vizcom.com/prompting-in-modify') +
        feature('motion', 'Add content and motion', 'Place an object in a scene and animate it.', pic('truck-green', '') + film('motion'), 'https://docs.vizcom.com/animating-in-vizcom') +
        feature('model', 'Visualize 3D Models', 'Try materials, colors and settings for a model.', pic('truck-clay', 'Truck model') + pic('truck-green', '', ' class="vl-alt"') + pic('blocks', '', ' class="vl-overlay"'), 'https://docs.vizcom.com/2D-to-3D') +
        feature('animate', 'Animate anything', 'Direct motion across a clip or a sequence.', film('enhance') + pic('component', '', ' class="vl-overlay"'), 'https://docs.vizcom.com/animating-in-vizcom') +
        feature('touch', 'Touch what you create', 'Carry a concept from screen into a physical form.', pic('chair', 'Chair concept') + pic('chair-irl', '', ' class="vl-alt"'), site + '/solutions/industrial-design') +
        feature('enhance', 'Enhance your work', 'Reveal detail and clarity in a render.', pic('enhance-a', 'Rendering detail') + pic('enhance-b', '', ' class="vl-alt"') + pic('enhance-ui', '', ' class="vl-overlay"'), 'https://docs.vizcom.com/enhance-and-upscale') +
      '</div></section>' +
    '<section class="vl-design vl-section" id="design" aria-labelledby="vl-design-title"><div class="vl-container vl-design-layout"><div class="vl-design-copy"><h2 id="vl-design-title">Designed for the real world</h2><p>Move from pixels to physical ideas and bring a concept into your design workflow.</p><div class="vl-actions">' + button('Explore our Blog', site + '/blog') + button('Get Started', app, true) + '</div></div>' +
      '<div class="vl-design-art" aria-hidden="true">' + [1,2,3,4,5,6].map(n => pic('design-' + n)).join('') + '</div></div></section>' +
    '<section class="vl-faq vl-section" id="faq" aria-labelledby="vl-faq-title"><div class="vl-container vl-faq-layout"><div><h2 id="vl-faq-title">Frequently asked questions</h2><p>Find information about plans, billing and data, or contact the Vizcom team.</p>' + button('Contact us', contact) + '</div><div>' + faq + '</div></div></section>' +
    '<section class="vl-team vl-section" aria-labelledby="vl-team-title"><div class="vl-team-stage"><h2 id="vl-team-title"><em>Built</em> for teams</h2><span class="vl-user">Jordan</span><span class="vl-user">Jesse</span><span class="vl-user">Brooke</span><span class="vl-user">Eden</span></div><p>Stay aligned and build together.</p><div class="vl-actions">' + button('Book a Demo', contact) + button('Get Started', app, true) + '</div></section>' +
    '<footer class="vl-footer"><div class="vl-container"><div class="vl-footer-cols">' +
      groups.map(([label, links]) => '<div><h3>' + label + '</h3>' + links.map(([text, url]) => '<a href="' + (url.startsWith('/') ? site + url : url) + '">' + text + '</a>').join('') + '</div>').join('') +
      '<div><h3>Follow Us</h3><a href="https://www.instagram.com/vizcom.ai/">Instagram</a><a href="https://www.linkedin.com/company/vizcomco/">LinkedIn</a><a href="https://www.youtube.com/@vizcom">YouTube</a><a href="' + site + '/blog">Newsletter &amp; updates</a></div></div>' +
      '<div class="vl-footer-end"><a href="' + site + '" aria-label="Vizcom original site">vizcom</a><span>© Vizcom · Local interaction study</span><a href="https://www.itsoffbrand.com/">site by OFF+BRAND.</a></div></div></footer>' +
    '<dialog class="vl-dialog" aria-labelledby="vl-dialog-title"><article><button class="vl-close" type="button">Close <span aria-hidden="true">×</span></button><div class="vl-dialog-image"></div><div class="vl-dialog-copy"><h3 id="vl-dialog-title"></h3><p></p><a class="vl-button" target="_blank" rel="noopener noreferrer">Watch video ↗</a></div></article></dialog>';

  const rail = root.querySelector('.vl-case-rail');
  const railButtons = [...root.querySelectorAll('[data-slide]')];
  const step = () => rail.querySelector('.vl-case').getBoundingClientRect().width + 16;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const setRailButtons = () => {
    railButtons[0].disabled = rail.scrollLeft < 2;
    railButtons[1].disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 2;
  };

  railButtons.forEach(control => control.addEventListener('click', () => {
    rail.scrollBy({ left: step() * Number(control.dataset.slide), behavior: reduceMotion.matches ? 'instant' : 'smooth' });
  }));
  rail.addEventListener('scroll', setRailButtons, { passive: true });
  new ResizeObserver(setRailButtons).observe(rail);
  setRailButtons();

  let drag = null;
  let blockClick = false;
  rail.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.pointerType !== 'mouse') return;
    drag = { id: event.pointerId, x: event.clientX, scroll: rail.scrollLeft, moved: false };
    blockClick = false;
  });
  rail.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const distance = event.clientX - drag.x;
    if (!drag.moved && Math.abs(distance) < 7) return;
    if (!drag.moved) {
      drag.moved = true;
      rail.setPointerCapture(event.pointerId);
      rail.classList.add('vl-dragging');
    }
    rail.scrollLeft = drag.scroll - distance;
  });
  function finishDrag() {
    if (drag?.moved) { blockClick = true; setTimeout(() => { blockClick = false; }, 0); }
    drag = null;
    rail.classList.remove('vl-dragging');
  }
  rail.addEventListener('pointerup', finishDrag);
  rail.addEventListener('pointercancel', finishDrag);
  rail.addEventListener('pointerleave', () => { if (drag && !drag.moved) finishDrag(); });

  const dialog = root.querySelector('.vl-dialog');
  let caseTrigger;
  rail.addEventListener('click', event => {
    const card = event.target.closest('[data-case]');
    if (blockClick) { blockClick = false; return; }
    if (!card) return;
    const [name, key, id, desc] = cases[Number(card.dataset.case)];
    caseTrigger = card;
    dialog.querySelector('.vl-dialog-image').innerHTML = pic(key, name);
    dialog.querySelector('h3').textContent = Number(card.dataset.case) < 4 ? 'Design Decoded: ' + name : name;
    dialog.querySelector('p').textContent = desc;
    dialog.querySelector('a').href = 'https://player.vimeo.com/video/' + id + '?app_id=122963';
    dialog.showModal();
  });
  dialog.querySelector('button').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => caseTrigger?.focus({ preventScroll: true }));

  const films = [...root.querySelectorAll('.vl-feature video')];
  const filmObserver = new IntersectionObserver(entries => entries.forEach(({ target, isIntersecting }) => {
    if (isIntersecting && !reduceMotion.matches) target.play().catch(() => {});
    else target.pause();
  }), { threshold: 0.25 });
  films.forEach(video => filmObserver.observe(video));

  const artwork = root.querySelector('.vl-design-art');
  artwork.addEventListener('pointermove', event => {
    if (reduceMotion.matches || event.pointerType !== 'mouse') return;
    const box = artwork.getBoundingClientRect();
    artwork.style.setProperty('--px', ((event.clientX - box.left) / box.width - .5) * 24 + 'px');
    artwork.style.setProperty('--py', ((event.clientY - box.top) / box.height - .5) * 24 + 'px');
  });
  artwork.addEventListener('pointerleave', () => {
    artwork.style.removeProperty('--px');
    artwork.style.removeProperty('--py');
  });
})();
