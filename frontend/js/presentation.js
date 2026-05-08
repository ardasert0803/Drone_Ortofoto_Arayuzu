/* Sunum Modu — müze projesi etrafında yavaş orbit + kart döngüsü */
window.AppPresentation = (() => {
  let _project = null;
  let _uuid    = null;
  let _slides  = [];
  let _current = 0;
  let _paused  = false;
  let _autoTimer = null;
  const AUTO_INTERVAL = 7000; // ms per slide

  /* ---- html escape ------------------------------------------ */
  function _esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ---- chip helper ------------------------------------------ */
  function _chip(iconClass, text) {
    if (!text) return '';
    return `<span class="pres-chip"><span class="icon ${iconClass}"></span>${_esc(text)}</span>`;
  }

  /* ---- visit info row --------------------------------------- */
  function _visitRow(iconClass, label, value) {
    if (!value) return '';
    return `
      <div class="pres-visit-row">
        <span class="icon ${iconClass} pres-visit-icon"></span>
        <div>
          <span class="pres-visit-label">${_esc(label)}</span>
          <span class="pres-visit-val">${_esc(value)}</span>
        </div>
      </div>`;
  }

  /* ---- slide builders --------------------------------------- */
  function _buildSlides(project) {
    const slides = [];

    /* 1 — Hero */
    slides.push(`
      <div class="pres-card-inner pres-hero-card">
        <div class="pres-card-accent pres-accent-gold"></div>
        <span class="pres-card-kicker" style="--kicker-color:#f59e0b">Müze Projesi</span>
        <h2 class="pres-card-title">${_esc(project.museum_name || project.name || 'İsimsiz Müze')}</h2>
        <div class="pres-hero-chips">
          ${_chip('icon-calendar', project.historical_period)}
          ${_chip('icon-pin', project.location)}
        </div>
      </div>`);

    /* 2 — Tarihçe */
    if (project.museum_summary) {
      slides.push(`
        <div class="pres-card-inner pres-text-card">
          <div class="pres-card-accent pres-accent-blue"></div>
          <span class="pres-card-kicker" style="--kicker-color:#4f9eff">Tarihçe</span>
          <h3 class="pres-card-subtitle">Müze Hakkında</h3>
          <p class="pres-card-body">${_esc(project.museum_summary)}</p>
        </div>`);
    }

    /* 3 — Öne Çıkan Eserler */
    if (project.featured_artifacts) {
      slides.push(`
        <div class="pres-card-inner pres-text-card">
          <div class="pres-card-accent pres-accent-amber"></div>
          <span class="pres-card-kicker" style="--kicker-color:#f85149">Koleksiyon</span>
          <h3 class="pres-card-subtitle">Öne Çıkan Eserler</h3>
          <p class="pres-card-body pres-featured">${_esc(project.featured_artifacts)}</p>
        </div>`);
    }

    /* 4 — Koleksiyon Teması */
    if (project.collection_theme) {
      slides.push(`
        <div class="pres-card-inner pres-text-card">
          <div class="pres-card-accent pres-accent-teal"></div>
          <span class="pres-card-kicker" style="--kicker-color:#3fb950">Tema</span>
          <h3 class="pres-card-subtitle">Koleksiyon Teması</h3>
          <p class="pres-card-body">${_esc(project.collection_theme)}</p>
        </div>`);
    }

    /* 5 — Ziyaret Bilgileri */
    const hasVisit = project.visiting_hours || project.ticket_access || project.museum_address || project.visitor_notes;
    if (hasVisit) {
      slides.push(`
        <div class="pres-card-inner pres-visit-card">
          <div class="pres-card-accent pres-accent-green"></div>
          <span class="pres-card-kicker" style="--kicker-color:#10b981">Ziyaret</span>
          <h3 class="pres-card-subtitle">Ziyaret Bilgileri</h3>
          <div class="pres-visit-grid">
            ${_visitRow('icon-clock',   'Ziyaret Saatleri', project.visiting_hours)}
            ${_visitRow('icon-ticket',  'Bilet / Erişim',   project.ticket_access)}
            ${_visitRow('icon-pin',     'Adres',             project.museum_address)}
            ${_visitRow('icon-info-circle', 'Ziyaretçi Notu', project.visitor_notes)}
          </div>
        </div>`);
    }

    return slides;
  }

  /* ---- dot nav ---------------------------------------------- */
  function _renderDots() {
    const dots = document.getElementById('pres-dots');
    if (!dots) return;
    dots.innerHTML = _slides.map((_, i) =>
      `<button class="pres-dot${i === _current ? ' active' : ''}" data-index="${i}" aria-label="Slayt ${i + 1}"></button>`
    ).join('');
    dots.querySelectorAll('.pres-dot').forEach(dot => {
      dot.addEventListener('click', () => _goTo(parseInt(dot.dataset.index)));
    });
  }

  function _syncUI() {
    document.querySelectorAll('.pres-card').forEach((card, i) => {
      card.classList.remove('active', 'prev');
      if (i === _current) card.classList.add('active');
      else if (i < _current) card.classList.add('prev');
    });
    document.querySelectorAll('.pres-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === _current);
    });
    const fill = document.getElementById('pres-progress-fill');
    if (fill) fill.style.width = `${((_current + 1) / _slides.length) * 100}%`;
  }

  function _goTo(index) {
    _current = ((index % _slides.length) + _slides.length) % _slides.length;
    _syncUI();
    _restartAuto();
  }

  function _next() { _goTo(_current + 1); }
  function _prev() { _goTo(_current - 1); }

  /* ---- auto advance ----------------------------------------- */
  function _startAuto() {
    _clearAuto();
    if (_paused || _slides.length <= 1) return;
    _autoTimer = setTimeout(() => { _next(); _startAuto(); }, AUTO_INTERVAL);
  }
  function _clearAuto() {
    if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
  }
  function _restartAuto() {
    _clearAuto();
    _startAuto();
  }

  /* ---- pause / resume --------------------------------------- */
  function togglePause() {
    _paused = !_paused;
    const iconEl = document.getElementById('pres-pause-icon');
    if (iconEl) iconEl.className = `icon ${_paused ? 'icon-player-play' : 'icon-player-pause'} pres-ctrl-icon`;
    const btn = document.getElementById('btn-pres-pause');
    if (btn) btn.title = _paused ? 'Devam Et' : 'Duraklat';

    if (_paused) {
      _clearAuto();
      AppViewer.setOrbitPaused(true);
    } else {
      _startAuto();
      AppViewer.setOrbitPaused(false);
    }
  }

  /* ---- open / close ----------------------------------------- */
  function open(project, uuid) {
    _project = project;
    _uuid    = uuid;
    _slides  = _buildSlides(project);
    _current = 0;
    _paused  = false;

    const modal = document.getElementById('modal-presentation');
    if (!modal) return;

    /* top-bar museum name */
    const nameEl = document.getElementById('pres-museum-name-topbar');
    if (nameEl) nameEl.textContent = project.museum_name || project.name || '';

    /* inject cards */
    const wrap = document.getElementById('pres-card-wrap');
    if (wrap) {
      wrap.innerHTML = _slides.map((html, i) =>
        `<div class="pres-card${i === 0 ? ' active' : ''}" data-index="${i}">${html}</div>`
      ).join('');
    }

    _renderDots();
    _syncUI();

    /* reset pause icon */
    const iconEl = document.getElementById('pres-pause-icon');
    if (iconEl) iconEl.className = 'icon icon-player-pause pres-ctrl-icon';
    const btn = document.getElementById('btn-pres-pause');
    if (btn) btn.title = 'Duraklat';

    modal.classList.remove('hidden');
    document.body.classList.add('pres-active'); // sidebars gizle
    _startAuto();

    /* start camera orbit — retry once if tileset not yet loaded */
    const ok = AppViewer.startOrbit(uuid, { pitch: -30, rangeFactor: 2.8, speedDegsPerSec: 4 });
    if (!ok) {
      setTimeout(() => AppViewer.startOrbit(uuid, { pitch: -30, rangeFactor: 2.8, speedDegsPerSec: 4 }), 2500);
    }
  }

  function close() {
    document.getElementById('modal-presentation')?.classList.add('hidden');
    document.body.classList.remove('pres-active'); // sidebars geri göster
    _clearAuto();
    AppViewer.stopOrbit();
    _project = null;
    _uuid    = null;
    _slides  = [];
    _paused  = false;
  }

  /* ---- bind -------------------------------------------------- */
  function bind() {
    document.getElementById('btn-pres-close')?.addEventListener('click', close);
    document.getElementById('btn-pres-pause')?.addEventListener('click', togglePause);
    document.getElementById('btn-pres-next')?.addEventListener('click', _next);
    document.getElementById('btn-pres-prev')?.addEventListener('click', _prev);

    document.addEventListener('keydown', e => {
      const modal = document.getElementById('modal-presentation');
      if (modal?.classList.contains('hidden')) return;
      if (e.key === 'Escape')       { close(); return; }
      if (e.key === 'ArrowRight')   { _goTo(_current + 1); return; }
      if (e.key === 'ArrowLeft')    { _goTo(_current - 1); return; }
      if (e.key === ' ')            { e.preventDefault(); togglePause(); }
    });
  }

  return { open, close, bind };
})();
