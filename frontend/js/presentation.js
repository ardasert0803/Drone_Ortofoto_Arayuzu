window.AppPresentation = (() => {
  let _project = null;
  let _uuid = null;
  let _slides = [];
  let _current = 0;
  let _paused = false;
  let _autoTimer = null;
  let _activeSettings = null;

  const DEFAULT_ORBIT = Object.freeze({
    direction: "clockwise",
    heading_degrees: 0,
    pitch_degrees: -30,
    range_factor: 1.9,
    speed_degs_per_sec: 4,
  });
  const DEFAULT_PLAYBACK = Object.freeze({
    auto_interval_ms: 7000,
    auto_scroll_enabled: true,
    auto_scroll_speed_px_per_sec: 26,
    auto_scroll_pause_ms: 1400,
  });
  let _scrollRaf = 0;
  let _scrollTimer = 0;
  const BUILTIN_CARD_IDS = ["hero", "history", "artifacts", "theme", "visit"];
  const SHAPE_PRESETS = new Set(["rounded", "sharp", "pill", "cut-corner"]);
  const CARD_META = Object.freeze({
    hero: {
      defaults: {
        enabled: true,
        order: 0,
        x_percent: 33,
        y_percent: 62,
        width_percent: 34,
        height_percent: 22,
        shape_preset: "rounded",
        accent_color: "#f59e0b",
        kicker_color: "#f59e0b",
        kicker_text: "Müze Projesi",
      },
      title(project) {
        return project?.museum_name || project?.name || "İsimsiz Müze";
      },
      body() {
        return "";
      },
    },
    history: {
      defaults: {
        enabled: true,
        order: 1,
        x_percent: 33,
        y_percent: 62,
        width_percent: 34,
        height_percent: 24,
        shape_preset: "rounded",
        accent_color: "#4f9eff",
        kicker_color: "#4f9eff",
        kicker_text: "Tarihçe",
      },
      title() {
        return "Müze Hakkında";
      },
      body(project) {
        return project?.museum_summary || "";
      },
    },
    artifacts: {
      defaults: {
        enabled: true,
        order: 2,
        x_percent: 33,
        y_percent: 62,
        width_percent: 34,
        height_percent: 24,
        shape_preset: "rounded",
        accent_color: "#f85149",
        kicker_color: "#f85149",
        kicker_text: "Koleksiyon",
      },
      title() {
        return "Öne Çıkan Eserler";
      },
      body(project) {
        return project?.featured_artifacts || "";
      },
    },
    theme: {
      defaults: {
        enabled: true,
        order: 3,
        x_percent: 33,
        y_percent: 62,
        width_percent: 34,
        height_percent: 22,
        shape_preset: "rounded",
        accent_color: "#3fb950",
        kicker_color: "#3fb950",
        kicker_text: "Tema",
      },
      title() {
        return "Koleksiyon Teması";
      },
      body(project) {
        return project?.collection_theme || "";
      },
    },
    visit: {
      defaults: {
        enabled: true,
        order: 4,
        x_percent: 31,
        y_percent: 60,
        width_percent: 38,
        height_percent: 28,
        shape_preset: "rounded",
        accent_color: "#10b981",
        kicker_color: "#10b981",
        kicker_text: "Ziyaret",
      },
      title() {
        return "Ziyaret Bilgileri";
      },
      body() {
        return "";
      },
    },
  });

  function _clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function _esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function _escAttr(value) {
    return _esc(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function _toNumber(value, fallback, min = null, max = null) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    if (min !== null && number < min) return min;
    if (max !== null && number > max) return max;
    return number;
  }

  function _toInt(value, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) ? number : fallback;
  }

  function _chip(iconClass, text) {
    if (!text) return "";
    return `<span class="pres-chip"><span class="icon ${iconClass}"></span>${_esc(text)}</span>`;
  }

  function _visitRow(iconClass, label, value) {
    if (!value) return "";
    return `
      <div class="pres-visit-row">
        <span class="icon ${iconClass} pres-visit-icon"></span>
        <div>
          <span class="pres-visit-label">${_esc(label)}</span>
          <span class="pres-visit-val">${_esc(value)}</span>
        </div>
      </div>`;
  }

  function _getDefaultCard(project, id) {
    const meta = CARD_META[id];
    const defaultEnabled = id === "hero"
      || (id === "history" && Boolean(project?.museum_summary))
      || (id === "artifacts" && Boolean(project?.featured_artifacts))
      || (id === "theme" && Boolean(project?.collection_theme))
      || (id === "visit" && Boolean(project?.visiting_hours || project?.ticket_access || project?.museum_address || project?.visitor_notes));
    return {
      id,
      ..._clone(meta.defaults),
      enabled: defaultEnabled,
      title_text: meta.title(project),
      body_text: meta.body(project),
    };
  }

  function _getGenericFallback(order = 0, cardId = "custom-card") {
    return {
      id: cardId,
      enabled: true,
      order,
      x_percent: 36,
      y_percent: 56,
      width_percent: 28,
      height_percent: 22,
      shape_preset: "rounded",
      accent_color: "#a78bfa",
      kicker_color: "#a78bfa",
      kicker_text: "Özel Kart",
      title_text: "Yeni Kart",
      body_text: "Sunum için özel metin.",
    };
  }

  function _isBuiltinCardId(cardId) {
    return BUILTIN_CARD_IDS.includes(cardId);
  }

  function _normalizeCard(project, rawCard, fallback) {
    const source = rawCard && typeof rawCard === "object" ? rawCard : {};
    const shape = SHAPE_PRESETS.has(source.shape_preset) ? source.shape_preset : fallback.shape_preset;
    return {
      id: fallback.id,
      enabled: typeof source.enabled === "boolean" ? source.enabled : fallback.enabled,
      order: _toInt(source.order, fallback.order),
      x_percent: _toNumber(source.x_percent, fallback.x_percent, 0, 100),
      y_percent: _toNumber(source.y_percent, fallback.y_percent, 0, 100),
      width_percent: _toNumber(source.width_percent, fallback.width_percent, 10, 100),
      height_percent: _toNumber(source.height_percent, fallback.height_percent, 10, 100),
      shape_preset: shape,
      accent_color: String(source.accent_color || fallback.accent_color).trim() || fallback.accent_color,
      kicker_color: String(source.kicker_color || fallback.kicker_color).trim() || fallback.kicker_color,
      kicker_text: typeof source.kicker_text === "string" ? source.kicker_text : fallback.kicker_text,
      title_text: typeof source.title_text === "string" ? source.title_text : fallback.title_text,
      body_text: typeof source.body_text === "string" ? source.body_text : fallback.body_text,
    };
  }

  function _getSourceSettings(project, explicitSettings, hasExplicit) {
    if (hasExplicit) return explicitSettings;
    return project?.presentation_settings || null;
  }

  function getResolvedSettings(project, explicitSettings) {
    const source = _getSourceSettings(project, explicitSettings, arguments.length >= 2);
    const orbitRaw = source?.orbit && typeof source.orbit === "object" ? source.orbit : {};
    const playbackRaw = source?.playback && typeof source.playback === "object" ? source.playback : {};
    const rawCards = Array.isArray(source?.cards) ? source.cards : [];
    const rawCardMap = new Map(rawCards.map((card) => [card?.id, card]));
    const builtinCards = BUILTIN_CARD_IDS.map((id) => {
      const fallback = _getDefaultCard(project, id);
      return _normalizeCard(project, rawCardMap.get(id), fallback);
    });
    const customCards = rawCards
      .filter((card) => card && typeof card === "object" && !_isBuiltinCardId(card.id))
      .map((card, index) => {
        const fallback = _getGenericFallback(builtinCards.length + index, String(card.id || `custom-${index + 1}`));
        return _normalizeCard(project, card, fallback);
      });
    return {
      orbit: {
        direction: orbitRaw.direction === "counterclockwise" ? "counterclockwise" : DEFAULT_ORBIT.direction,
        heading_degrees: _toNumber(orbitRaw.heading_degrees, DEFAULT_ORBIT.heading_degrees, -360, 360),
        pitch_degrees: _toNumber(orbitRaw.pitch_degrees, DEFAULT_ORBIT.pitch_degrees, -89, 89),
        range_factor: _toNumber(orbitRaw.range_factor, DEFAULT_ORBIT.range_factor, 0.1, 20),
        speed_degs_per_sec: _toNumber(orbitRaw.speed_degs_per_sec, DEFAULT_ORBIT.speed_degs_per_sec, 0, 360),
      },
      playback: {
        auto_interval_ms: Math.max(1000, _toInt(playbackRaw.auto_interval_ms, DEFAULT_PLAYBACK.auto_interval_ms)),
        auto_scroll_enabled: typeof playbackRaw.auto_scroll_enabled === "boolean"
          ? playbackRaw.auto_scroll_enabled
          : DEFAULT_PLAYBACK.auto_scroll_enabled,
        auto_scroll_speed_px_per_sec: _toNumber(
          playbackRaw.auto_scroll_speed_px_per_sec,
          DEFAULT_PLAYBACK.auto_scroll_speed_px_per_sec,
          1,
          400,
        ),
        auto_scroll_pause_ms: Math.max(0, _toInt(playbackRaw.auto_scroll_pause_ms, DEFAULT_PLAYBACK.auto_scroll_pause_ms)),
      },
      cards: [...builtinCards, ...customCards],
    };
  }

  function getDefaultSettings(project) {
    return getResolvedSettings(project, null);
  }

  function getSortedCards(settings, options = {}) {
    const includeDisabled = options.includeDisabled === true;
    return settings.cards
      .filter((card) => includeDisabled || card.enabled)
      .slice()
      .sort((left, right) => {
        if (left.order !== right.order) return left.order - right.order;
        const leftIndex = BUILTIN_CARD_IDS.indexOf(left.id);
        const rightIndex = BUILTIN_CARD_IDS.indexOf(right.id);
        return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
      });
  }

  function _shapeClass(shape) {
    return `pres-shape-${SHAPE_PRESETS.has(shape) ? shape : "rounded"}`;
  }

  function _renderCardBody(card, project) {
    if (card.id === "hero") {
      return `
        <div class="pres-card-inner pres-hero-card ${_shapeClass(card.shape_preset)}">
          <div class="pres-card-accent"></div>
          <span class="pres-card-kicker">${_esc(card.kicker_text)}</span>
          <h2 class="pres-card-title">${_esc(card.title_text)}</h2>
          ${card.body_text ? `<p class="pres-card-body pres-card-body-hero">${_esc(card.body_text)}</p>` : ""}
          <div class="pres-hero-chips">
            ${_chip("icon-calendar", project?.historical_period)}
            ${_chip("icon-pin", project?.location)}
          </div>
        </div>`;
    }
    if (card.id === "visit") {
      const rows = [
        _visitRow("icon-clock", "Ziyaret Saatleri", project?.visiting_hours),
        _visitRow("icon-ticket", "Bilet / Erişim", project?.ticket_access),
        _visitRow("icon-pin", "Adres", project?.museum_address),
        _visitRow("icon-info-circle", "Ziyaretçi Notu", project?.visitor_notes),
      ].filter(Boolean).join("");
      return `
        <div class="pres-card-inner pres-visit-card ${_shapeClass(card.shape_preset)}">
          <div class="pres-card-accent"></div>
          <span class="pres-card-kicker">${_esc(card.kicker_text)}</span>
          <h3 class="pres-card-subtitle">${_esc(card.title_text)}</h3>
          ${card.body_text ? `<p class="pres-card-body pres-card-body-visit">${_esc(card.body_text)}</p>` : ""}
          <div class="pres-visit-grid">
            ${rows || '<p class="pres-card-body">Ziyaret bilgisi girilmedi.</p>'}
          </div>
        </div>`;
    }
    const extraClass = card.id === "artifacts" ? " pres-featured" : "";
    return `
      <div class="pres-card-inner pres-text-card ${_shapeClass(card.shape_preset)}">
        <div class="pres-card-accent"></div>
        <span class="pres-card-kicker">${_esc(card.kicker_text)}</span>
        <h3 class="pres-card-subtitle">${_esc(card.title_text)}</h3>
        <p class="pres-card-body${extraClass}">${_esc(card.body_text || "Bilgi girilmedi")}</p>
      </div>`;
  }

  function _cardStyle(card) {
    return [
      `--card-x:${card.x_percent}%`,
      `--card-y:${card.y_percent}%`,
      `--card-w:${card.width_percent}%`,
      `--card-h:${card.height_percent}%`,
      `--card-accent:${_escAttr(card.accent_color)}`,
      `--card-kicker:${_escAttr(card.kicker_color)}`,
    ].join(";");
  }

  function _renderCardsMarkup(project, cards, options = {}) {
    const preview = options.preview === true;
    const selectedCardId = options.selectedCardId || "";
    const activeId = options.activeId || "";
    return cards.map((card, index) => {
      const classNames = ["pres-card"];
      if (preview) {
        classNames.push("preview-visible");
        if (!card.enabled) classNames.push("preview-disabled");
        if (card.id === selectedCardId) classNames.push("preview-selected");
      } else if (card.id === activeId || (!activeId && index === 0)) {
        classNames.push("active");
      } else if (index < cards.findIndex((entry) => entry.id === activeId)) {
        classNames.push("prev");
      }
      return `
        <div
          class="${classNames.join(" ")}"
          data-card-id="${_escAttr(card.id)}"
          data-index="${index}"
          style="${_cardStyle(card)}"
        >
          ${_renderCardBody(card, project)}
        </div>`;
    }).join("");
  }

  function renderPreview(container, project, settings, options = {}) {
    if (!container) return;
    const resolved = getResolvedSettings(project, settings);
    const cards = getSortedCards(resolved, {includeDisabled: true});
    container.innerHTML = `
      <div class="pres-stage pres-stage-preview">
        <div class="pres-card-wrap pres-card-wrap-preview">
          ${_renderCardsMarkup(project, cards, {
            preview: true,
            selectedCardId: options.selectedCardId || "",
          })}
        </div>
      </div>`;
  }

  function _renderDots() {
    const dots = document.getElementById("pres-dots");
    if (!dots) return;
    dots.innerHTML = _slides.map((_, index) =>
      `<button class="pres-dot${index === _current ? " active" : ""}" data-index="${index}" aria-label="Slayt ${index + 1}"></button>`
    ).join("");
    dots.querySelectorAll(".pres-dot").forEach((dot) => {
      dot.addEventListener("click", () => _goTo(Number.parseInt(dot.dataset.index || "0", 10)));
    });
  }

  function _syncUI() {
    const wrap = document.getElementById("pres-card-wrap");
    wrap?.querySelectorAll(".pres-card").forEach((card, index) => {
      card.classList.remove("active", "prev");
      if (index === _current) {
        card.classList.add("active");
      } else if (index < _current) {
        card.classList.add("prev");
      }
    });
    document.querySelectorAll("#pres-dots .pres-dot").forEach((dot, index) => {
      dot.classList.toggle("active", index === _current);
    });
    const fill = document.getElementById("pres-progress-fill");
    if (fill) {
      fill.style.width = _slides.length ? `${((_current + 1) / _slides.length) * 100}%` : "0%";
    }
  }

  function _goTo(index) {
    if (!_slides.length) return;
    _current = ((index % _slides.length) + _slides.length) % _slides.length;
    _syncUI();
    _startCardAutoScroll();
    _restartAuto();
  }

  function _next() {
    if (_slides.length) _goTo(_current + 1);
  }

  function _prev() {
    if (_slides.length) _goTo(_current - 1);
  }

  function _clearAuto() {
    if (_autoTimer) {
      clearTimeout(_autoTimer);
      _autoTimer = null;
    }
  }

  function _startAuto() {
    _clearAuto();
    if (_paused || _slides.length <= 1) return;
    const interval = _activeSettings?.playback?.auto_interval_ms || DEFAULT_PLAYBACK.auto_interval_ms;
    _autoTimer = setTimeout(() => {
      _next();
      _startAuto();
    }, interval);
  }

  function _restartAuto() {
    _clearAuto();
    _startAuto();
  }

  function _clearCardAutoScroll() {
    if (_scrollRaf) {
      cancelAnimationFrame(_scrollRaf);
      _scrollRaf = 0;
    }
    if (_scrollTimer) {
      clearTimeout(_scrollTimer);
      _scrollTimer = 0;
    }
  }

  function _startCardAutoScroll() {
    _clearCardAutoScroll();
    if (_paused) return;
    const playback = _activeSettings?.playback || DEFAULT_PLAYBACK;
    if (!playback.auto_scroll_enabled) return;
    const inner = document.querySelector("#pres-card-wrap .pres-card.active .pres-card-inner");
    if (!inner) return;
    inner.scrollTop = 0;
    const maxScroll = Math.max(0, inner.scrollHeight - inner.clientHeight);
    if (maxScroll <= 6) return;

    const speed = Math.max(1, Number(playback.auto_scroll_speed_px_per_sec) || DEFAULT_PLAYBACK.auto_scroll_speed_px_per_sec);
    const pauseMs = Math.max(0, Number(playback.auto_scroll_pause_ms) || 0);
    let direction = 1;
    let lastTs = 0;

    function scheduleResume(delayMs = 0) {
      _clearCardAutoScroll();
      _scrollTimer = window.setTimeout(() => {
        _scrollTimer = 0;
        lastTs = 0;
        _scrollRaf = requestAnimationFrame(step);
      }, delayMs);
    }

    function step(ts) {
      if (_paused || !_activeSettings || !inner.isConnected || !inner.closest(".pres-card.active")) {
        _clearCardAutoScroll();
        return;
      }
      if (!lastTs) {
        lastTs = ts;
        _scrollRaf = requestAnimationFrame(step);
        return;
      }
      const dt = Math.min((ts - lastTs) / 1000, 0.05);
      lastTs = ts;
      const nextScroll = inner.scrollTop + (speed * direction * dt);
      if (direction > 0 && nextScroll >= maxScroll) {
        inner.scrollTop = maxScroll;
        direction = -1;
        scheduleResume(pauseMs);
        return;
      }
      if (direction < 0 && nextScroll <= 0) {
        inner.scrollTop = 0;
        direction = 1;
        scheduleResume(pauseMs);
        return;
      }
      inner.scrollTop = nextScroll;
      _scrollRaf = requestAnimationFrame(step);
    }

    scheduleResume(pauseMs);
  }

  function togglePause() {
    _paused = !_paused;
    const iconEl = document.getElementById("pres-pause-icon");
    if (iconEl) {
      iconEl.className = `icon ${_paused ? "icon-player-play" : "icon-player-pause"} pres-ctrl-icon`;
    }
    const btn = document.getElementById("btn-pres-pause");
    if (btn) btn.title = _paused ? "Devam Et" : "Duraklat";
    if (_paused) {
      _clearAuto();
      _clearCardAutoScroll();
      AppViewer.setOrbitPaused(true);
    } else {
      _startAuto();
      _startCardAutoScroll();
      AppViewer.setOrbitPaused(false);
    }
  }

  function open(project, uuid) {
    _project = project;
    _uuid = uuid;
    _activeSettings = getResolvedSettings(project);
    _slides = getSortedCards(_activeSettings, {includeDisabled: false});
    _current = 0;
    _paused = false;

    const modal = document.getElementById("modal-presentation");
    if (!modal) return;

    const nameEl = document.getElementById("pres-museum-name-topbar");
    if (nameEl) nameEl.textContent = project?.museum_name || project?.name || "";

    const wrap = document.getElementById("pres-card-wrap");
    if (wrap) {
      wrap.innerHTML = _slides.length
        ? _renderCardsMarkup(project, _slides, {activeId: _slides[0]?.id || ""})
        : `
          <div class="pres-card active pres-card-empty" style="--card-x:34%;--card-y:66%;--card-w:32%;--card-h:16%;">
            <div class="pres-card-inner pres-text-card pres-shape-rounded">
              <div class="pres-card-accent"></div>
              <span class="pres-card-kicker">Sunum</span>
              <h3 class="pres-card-subtitle">Etkin kart yok</h3>
              <p class="pres-card-body">Sunum modu ayarlarından en az bir kartı etkinleştir.</p>
            </div>
          </div>`;
    }

    _renderDots();
    _syncUI();

    const iconEl = document.getElementById("pres-pause-icon");
    if (iconEl) iconEl.className = "icon icon-player-pause pres-ctrl-icon";
    const btn = document.getElementById("btn-pres-pause");
    if (btn) btn.title = "Duraklat";

    modal.classList.remove("hidden");
    document.body.classList.add("pres-active");
    _startAuto();
    _startCardAutoScroll();

    const ok = AppViewer.startOrbit(uuid, {
      heading: _activeSettings.orbit.heading_degrees,
      direction: _activeSettings.orbit.direction,
      pitch: _activeSettings.orbit.pitch_degrees,
      rangeFactor: _activeSettings.orbit.range_factor,
      speedDegsPerSec: _activeSettings.orbit.speed_degs_per_sec,
    });
    if (!ok) {
      setTimeout(() => AppViewer.startOrbit(uuid, {
        heading: _activeSettings.orbit.heading_degrees,
        direction: _activeSettings.orbit.direction,
        pitch: _activeSettings.orbit.pitch_degrees,
        rangeFactor: _activeSettings.orbit.range_factor,
        speedDegsPerSec: _activeSettings.orbit.speed_degs_per_sec,
      }), 2500);
    }
  }

  function close() {
    document.getElementById("modal-presentation")?.classList.add("hidden");
    document.body.classList.remove("pres-active");
    _clearAuto();
    _clearCardAutoScroll();
    AppViewer.stopOrbit();
    _project = null;
    _uuid = null;
    _slides = [];
    _paused = false;
    _activeSettings = null;
  }

  function bind() {
    document.getElementById("btn-pres-close")?.addEventListener("click", close);
    document.getElementById("btn-pres-pause")?.addEventListener("click", togglePause);
    document.getElementById("btn-pres-next")?.addEventListener("click", _next);
    document.getElementById("btn-pres-prev")?.addEventListener("click", _prev);

    document.addEventListener("keydown", (event) => {
      const modal = document.getElementById("modal-presentation");
      if (modal?.classList.contains("hidden")) return;
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key === "ArrowRight") {
        _goTo(_current + 1);
        return;
      }
      if (event.key === "ArrowLeft") {
        _goTo(_current - 1);
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        togglePause();
      }
    });
  }

  return {
    bind,
    close,
    createCustomCard(order = 0, cardId = `custom-${Date.now()}`) {
      return _getGenericFallback(order, cardId);
    },
    getDefaultSettings,
    getResolvedSettings,
    getSortedCards,
    isBuiltinCardId: _isBuiltinCardId,
    open,
    renderPreview,
  };
})();
