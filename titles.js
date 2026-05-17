// Onglet Titre — sélection de modèles, présélections, diffusion vers OBS
// Réutilise CHANNEL_NAME, STORAGE_KEY, bc, els (toast, liveDot, etc.) définis dans app.js

(function () {
  const TITLE_LAST_KEY = 'versetlive:title-last';
  const TITLE_LOGO_KEY = 'versetlive:title-logo';

  let selectedTemplate = 'ad-broukoi';
  let selectedLogo = 'original';

  const titleEls = {
    main: document.getElementById('titleMain'),
    sub: document.getElementById('titleSub'),
    templates: document.getElementById('titleTemplates'),
    presets: document.getElementById('titlePresets'),
    accent: document.getElementById('titleAccent'),
    accentHex: document.getElementById('titleAccentHex'),
    sendBtn: document.getElementById('sendTitleBtn'),
    logoPicker: document.getElementById('logoPicker'),
  };

  function renderTemplates() {
    titleEls.templates.innerHTML = TITLE_TEMPLATES.map(t => `
      <div class="title-template-card" data-id="${t.id}" title="${t.description}">
        <div class="ttc-icon">${t.icon}</div>
        <div class="ttc-name">${t.name}</div>
      </div>
    `).join('');
    titleEls.templates.querySelectorAll('.title-template-card').forEach(card => {
      card.addEventListener('click', () => {
        selectedTemplate = card.dataset.id;
        titleEls.templates.querySelectorAll('.title-template-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
      });
    });
    // Sélection par défaut
    const first = titleEls.templates.querySelector('.title-template-card');
    if (first) first.classList.add('active');
  }

  function renderLogoPicker() {
    if (!titleEls.logoPicker || typeof AD_LOGO_OPTIONS === 'undefined') return;
    titleEls.logoPicker.innerHTML = AD_LOGO_OPTIONS.map(opt => `
      <button class="logo-picker-item${opt.id === selectedLogo ? ' active' : ''}" data-id="${opt.id}" title="${escapeHtmlSafe(opt.description)}">
        <span class="logo-picker-thumb" style="background-image:url('${opt.file}')"></span>
        <span class="logo-picker-name">${escapeHtmlSafe(opt.name)}</span>
      </button>
    `).join('');
    titleEls.logoPicker.querySelectorAll('.logo-picker-item').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedLogo = btn.dataset.id;
        localStorage.setItem(TITLE_LOGO_KEY, selectedLogo);
        titleEls.logoPicker.querySelectorAll('.logo-picker-item').forEach(b => b.classList.toggle('active', b.dataset.id === selectedLogo));
      });
    });
  }

  function currentLogoFile() {
    const opt = (typeof AD_LOGO_OPTIONS !== 'undefined') && AD_LOGO_OPTIONS.find(o => o.id === selectedLogo);
    return opt ? opt.file : 'logo-ad.png';
  }

  function renderPresets() {
    titleEls.presets.innerHTML = TITLE_PRESETS.map((p, i) => `
      <div class="title-preset" data-i="${i}">
        <div class="title-preset-text">
          <strong>${escapeHtmlSafe(p.title)}</strong>
          ${p.subtitle ? '<span>' + escapeHtmlSafe(p.subtitle) + '</span>' : ''}
        </div>
        <button class="btn btn-sm btn-success" data-action="send">▶</button>
      </div>
    `).join('');

    titleEls.presets.querySelectorAll('.title-preset').forEach(el => {
      const i = parseInt(el.dataset.i);
      const preset = TITLE_PRESETS[i];

      el.addEventListener('click', (e) => {
        // Charge la présélection dans le formulaire
        titleEls.main.value = preset.title;
        titleEls.sub.value = preset.subtitle || '';
        selectedTemplate = preset.template;
        titleEls.templates.querySelectorAll('.title-template-card').forEach(c => {
          c.classList.toggle('active', c.dataset.id === preset.template);
        });
      });

      el.querySelector('[data-action="send"]').addEventListener('click', (e) => {
        e.stopPropagation();
        // Diffuse directement avec les valeurs de la présélection
        broadcastTitle(preset.title, preset.subtitle || '', preset.template, titleEls.accent.value);
      });
    });
  }

  function escapeHtmlSafe(s) {
    return String(s).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function broadcastTitle(title, subtitle, template, accent) {
    if (!title || !title.trim()) {
      toast('Saisissez un titre');
      return;
    }
    const state = {
      kind: 'title',
      title: title.trim(),
      subtitle: (subtitle || '').trim(),
      template: template || 'classic',
      accent: accent || '#B38E29',
      logoFile: currentLogoFile(),
      style: typeof getStyle === 'function' ? getStyle() : {},
      ts: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(TITLE_LAST_KEY, JSON.stringify({
      title: state.title, subtitle: state.subtitle, template: state.template, accent: state.accent, logoFile: state.logoFile
    }));
    bc?.postMessage({ type: 'showTitle', payload: state });
    if (typeof postToPreview === 'function') postToPreview({ type: 'showTitle', payload: state });

    els.currentRef.textContent = '✨ ' + state.title;
    els.currentTrans.textContent = TITLE_TEMPLATES.find(t => t.id === state.template)?.name || '';
    els.liveDot.classList.add('live');
    els.liveStatus.textContent = 'En direct';
    toast('Titre diffusé : ' + state.title);
  }

  function restoreLast() {
    try {
      const last = JSON.parse(localStorage.getItem(TITLE_LAST_KEY) || 'null');
      if (!last) return;
      titleEls.main.value = last.title || '';
      titleEls.sub.value = last.subtitle || '';
      if (last.template) {
        selectedTemplate = last.template;
        titleEls.templates.querySelectorAll('.title-template-card').forEach(c => {
          c.classList.toggle('active', c.dataset.id === last.template);
        });
      }
      if (last.accent) {
        titleEls.accent.value = last.accent;
        titleEls.accentHex.value = last.accent;
      }
    } catch {}
  }

  // Bindings
  titleEls.sendBtn.addEventListener('click', () => {
    broadcastTitle(titleEls.main.value, titleEls.sub.value, selectedTemplate, titleEls.accent.value);
  });

  titleEls.accent.addEventListener('input', () => {
    titleEls.accentHex.value = titleEls.accent.value;
  });
  titleEls.accentHex.addEventListener('change', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(titleEls.accentHex.value)) {
      titleEls.accent.value = titleEls.accentHex.value;
    }
  });

  // Entrée dans les champs déclenche la diffusion
  [titleEls.main, titleEls.sub].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        broadcastTitle(titleEls.main.value, titleEls.sub.value, selectedTemplate, titleEls.accent.value);
      }
    });
  });

  // Init
  try { selectedLogo = localStorage.getItem(TITLE_LOGO_KEY) || 'original'; } catch (e) { selectedLogo = 'original'; }
  renderTemplates();
  renderLogoPicker();
  renderPresets();
  restoreLast();
})();
