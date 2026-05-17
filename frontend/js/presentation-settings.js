window.AppPresentationSettings = (() => {
  const CARD_LABELS = {
    hero: "Açılış",
    history: "Tarihçe",
    artifacts: "Eserler",
    theme: "Tema",
    visit: "Ziyaret",
  };
  const SHAPE_OPTIONS = [
    ["rounded", "Rounded"],
    ["sharp", "Sharp"],
    ["pill", "Pill"],
    ["cut-corner", "Cut Corner"],
  ];

  const state = {
    project: null,
    draft: null,
    selectedCardId: "hero",
    onSaved: null,
    previewImageUrl: "",
    drag: null,
  };

  const dom = {
    modal: null,
    projectName: null,
    status: null,
    cardList: null,
    preview: null,
    inspector: null,
    orbitDirection: null,
    orbitHeading: null,
    orbitPitch: null,
    orbitRange: null,
    orbitSpeed: null,
    autoInterval: null,
    autoScrollEnabled: null,
    autoScrollSpeed: null,
    autoScrollPause: null,
    resetButton: null,
    saveButton: null,
  };

  function _clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function _esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function _selectedCard() {
    return state.draft?.cards?.find((card) => card.id === state.selectedCardId) || null;
  }

  function _isBuiltinCard(cardId) {
    return AppPresentation.isBuiltinCardId(cardId);
  }

  function _cardLabel(card) {
    return CARD_LABELS[card.id] || "Özel Kart";
  }

  function _nextCustomCardId() {
    let index = 1;
    const ids = new Set((state.draft?.cards || []).map((card) => card.id));
    while (ids.has(`custom-${index}`)) index += 1;
    return `custom-${index}`;
  }

  function _sortedCards() {
    return AppPresentation.getSortedCards(state.draft, {includeDisabled: true});
  }

  function _setStatus(message = "", tone = "") {
    if (!dom.status) return;
    dom.status.textContent = message;
    dom.status.className = `status${tone ? ` ${tone}` : ""}`;
  }

  function _renderCardList() {
    if (!dom.cardList || !state.draft) return;
    dom.cardList.innerHTML = _sortedCards().map((card) => `
      <button
        type="button"
        class="pres-settings-card-tab${card.id === state.selectedCardId ? " active" : ""}"
        data-card-id="${_esc(card.id)}"
      >
        <span class="pres-settings-card-order">#${card.order + 1}</span>
        <span class="pres-settings-card-copy">
          <strong>${_esc(_cardLabel(card))}</strong>
          <span>${card.enabled ? "Etkin" : "Kapalı"} · ${_esc(card.title_text || "Başlıksız")}</span>
        </span>
      </button>
    `).join("");
    dom.cardList.querySelectorAll("[data-card-id]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedCardId = button.dataset.cardId || state.selectedCardId;
        _renderCardList();
        _renderInspector();
        _renderPreview();
      });
    });
  }

  function _renderPreview() {
    if (!dom.preview || !state.project || !state.draft) return;
    _applyPreviewBackground();
    AppPresentation.renderPreview(dom.preview, state.project, state.draft, {
      selectedCardId: state.selectedCardId,
    });
    dom.preview.querySelectorAll(".pres-card[data-card-id]").forEach((cardEl) => {
      cardEl.addEventListener("pointerdown", _startDrag);
      cardEl.addEventListener("click", () => {
        state.selectedCardId = cardEl.dataset.cardId || state.selectedCardId;
        _renderCardList();
        _renderInspector();
        _renderPreview();
      });
    });
  }

  function _renderGeneralFields() {
    if (!state.draft) return;
    dom.orbitDirection.value = state.draft.orbit.direction;
    dom.orbitHeading.value = state.draft.orbit.heading_degrees;
    dom.orbitPitch.value = state.draft.orbit.pitch_degrees;
    dom.orbitRange.value = state.draft.orbit.range_factor;
    dom.orbitSpeed.value = state.draft.orbit.speed_degs_per_sec;
    dom.autoInterval.value = state.draft.playback.auto_interval_ms;
    dom.autoScrollEnabled.checked = state.draft.playback.auto_scroll_enabled;
    dom.autoScrollSpeed.value = state.draft.playback.auto_scroll_speed_px_per_sec;
    dom.autoScrollPause.value = state.draft.playback.auto_scroll_pause_ms;
    dom.autoScrollSpeed.disabled = !state.draft.playback.auto_scroll_enabled;
    dom.autoScrollPause.disabled = !state.draft.playback.auto_scroll_enabled;
  }

  function _renderInspector() {
    if (!dom.inspector || !state.draft) return;
    const card = _selectedCard();
    if (!card) {
      dom.inspector.innerHTML = "<p class=\"hint\">Kart seçilmedi.</p>";
      return;
    }
    dom.inspector.innerHTML = `
      <div class="pres-settings-fields">
        <label class="pres-settings-check">
          <input type="checkbox" name="enabled" ${card.enabled ? "checked" : ""} />
          <span>Kart etkin</span>
        </label>
        <label>
          Sıra
          <input type="number" name="order" min="0" step="1" value="${_esc(card.order)}" />
        </label>
        <label>
          Şekil
          <select name="shape_preset">
            ${SHAPE_OPTIONS.map(([value, label]) => `
              <option value="${_esc(value)}" ${card.shape_preset === value ? "selected" : ""}>${_esc(label)}</option>
            `).join("")}
          </select>
        </label>
        <label>
          Accent rengi
          <input type="color" name="accent_color" value="${_esc(card.accent_color)}" />
        </label>
        <label>
          Kicker rengi
          <input type="color" name="kicker_color" value="${_esc(card.kicker_color)}" />
        </label>
        <label class="field-span-full">
          Kicker metni
          <input type="text" name="kicker_text" value="${_esc(card.kicker_text)}" />
        </label>
        <label class="field-span-full">
          Başlık
          <input type="text" name="title_text" value="${_esc(card.title_text)}" />
        </label>
        <label class="field-span-full">
          Metin
          <textarea name="body_text" rows="5">${_esc(card.body_text)}</textarea>
        </label>
        <label>
          Genişlik %
          <input type="number" name="width_percent" min="10" max="100" step="0.1" value="${_esc(card.width_percent)}" />
        </label>
        <label>
          Yükseklik %
          <input type="number" name="height_percent" min="10" max="100" step="0.1" value="${_esc(card.height_percent)}" />
        </label>
        <label>
          X %
          <input type="number" name="x_percent" min="0" max="100" step="0.1" value="${_esc(card.x_percent)}" />
        </label>
        <label>
          Y %
          <input type="number" name="y_percent" min="0" max="100" step="0.1" value="${_esc(card.y_percent)}" />
        </label>
        <div class="pres-settings-drag-note field-span-full">
          Karti preview alaninda surukleyerek konumlandirabilirsin. X ve Y alanlari ince ayar icin kalir.
        </div>
        ${_isBuiltinCard(card.id) ? "" : `
          <button type="button" class="pres-settings-delete-card field-span-full" data-delete-card>
            Karti Sil
          </button>
        `}
      </div>`;
    dom.inspector.querySelectorAll("input, textarea, select").forEach((field) => {
      field.addEventListener("input", _handleInspectorInput);
      field.addEventListener("change", _handleInspectorInput);
    });
    dom.inspector.querySelector("[data-delete-card]")?.addEventListener("click", _deleteSelectedCard);
  }

  function _updateSelectedCard(patch) {
    const card = _selectedCard();
    if (!card) return;
    Object.assign(card, patch);
  }

  function _clampCard(card) {
    card.width_percent = Math.min(100, Math.max(10, Number(card.width_percent) || 10));
    card.height_percent = Math.min(100, Math.max(10, Number(card.height_percent) || 10));
    card.x_percent = Math.min(100 - card.width_percent, Math.max(0, Number(card.x_percent) || 0));
    card.y_percent = Math.min(100 - card.height_percent, Math.max(0, Number(card.y_percent) || 0));
    card.order = Math.max(0, Math.round(Number(card.order) || 0));
  }

  function _handleInspectorInput(event) {
    const field = event.target;
    const card = _selectedCard();
    if (!field || !card) return;
    const name = field.name;
    if (name === "enabled") {
      card.enabled = Boolean(field.checked);
    } else if (name === "order") {
      card.order = Math.max(0, Math.round(Number(field.value) || 0));
    } else if (["width_percent", "height_percent", "x_percent", "y_percent"].includes(name)) {
      card[name] = Number(field.value) || 0;
    } else {
      card[name] = field.value;
    }
    _clampCard(card);
    _renderCardList();
    _renderPreview();
  }

  function _addCustomCard() {
    if (!state.draft) return;
    const order = Math.max(0, ...state.draft.cards.map((card) => card.order)) + 1;
    const card = AppPresentation.createCustomCard(order, _nextCustomCardId());
    state.draft.cards.push(card);
    state.selectedCardId = card.id;
    _renderAll();
  }

  function _deleteSelectedCard() {
    const card = _selectedCard();
    if (!state.draft || !card || _isBuiltinCard(card.id)) return;
    state.draft.cards = state.draft.cards.filter((entry) => entry.id !== card.id);
    state.selectedCardId = state.draft.cards[0]?.id || "hero";
    _renderAll();
  }

  function _handleGeneralInput() {
    if (!state.draft) return;
    state.draft.orbit.direction = dom.orbitDirection.value === "counterclockwise" ? "counterclockwise" : "clockwise";
    state.draft.orbit.heading_degrees = Number(dom.orbitHeading.value) || 0;
    state.draft.orbit.pitch_degrees = Number(dom.orbitPitch.value) || 0;
    state.draft.orbit.range_factor = Number(dom.orbitRange.value) || 0;
    state.draft.orbit.speed_degs_per_sec = Number(dom.orbitSpeed.value) || 0;
    state.draft.playback.auto_interval_ms = Math.max(1000, Math.round(Number(dom.autoInterval.value) || 1000));
    state.draft.playback.auto_scroll_enabled = Boolean(dom.autoScrollEnabled.checked);
    state.draft.playback.auto_scroll_speed_px_per_sec = Math.max(1, Number(dom.autoScrollSpeed.value) || 1);
    state.draft.playback.auto_scroll_pause_ms = Math.max(0, Math.round(Number(dom.autoScrollPause.value) || 0));
    dom.autoScrollSpeed.disabled = !state.draft.playback.auto_scroll_enabled;
    dom.autoScrollPause.disabled = !state.draft.playback.auto_scroll_enabled;
  }

  function _syncPositionFields(card) {
    if (!dom.inspector || !card || card.id !== state.selectedCardId) return;
    const xInput = dom.inspector.querySelector('input[name="x_percent"]');
    const yInput = dom.inspector.querySelector('input[name="y_percent"]');
    if (xInput) xInput.value = String(Math.round(card.x_percent * 10) / 10);
    if (yInput) yInput.value = String(Math.round(card.y_percent * 10) / 10);
  }

  function _stopDrag() {
    if (!state.drag) return;
    state.drag = null;
    document.body.classList.remove("pres-settings-dragging");
  }

  function _onPointerMove(event) {
    if (!state.drag || !state.draft) return;
    const card = state.draft.cards.find((entry) => entry.id === state.drag.cardId);
    if (!card) return;
    const dx = event.clientX - state.drag.startX;
    const dy = event.clientY - state.drag.startY;
    const nextX = state.drag.originX + ((dx / state.drag.bounds.width) * 100);
    const nextY = state.drag.originY + ((dy / state.drag.bounds.height) * 100);
    card.x_percent = nextX;
    card.y_percent = nextY;
    _clampCard(card);
    state.drag.moved = true;
    state.drag.element.style.setProperty("--card-x", `${card.x_percent}%`);
    state.drag.element.style.setProperty("--card-y", `${card.y_percent}%`);
    _syncPositionFields(card);
  }

  function _startDrag(event) {
    if (!state.draft || !dom.preview) return;
    const cardId = event.currentTarget?.dataset?.cardId;
    const card = state.draft.cards.find((entry) => entry.id === cardId);
    const wrap = dom.preview.querySelector(".pres-card-wrap-preview");
    if (!card || !wrap) return;
    state.selectedCardId = card.id;
    _renderCardList();
    _renderInspector();
    const bounds = wrap.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    state.drag = {
      cardId: card.id,
      element: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      originX: Number(card.x_percent) || 0,
      originY: Number(card.y_percent) || 0,
      bounds,
      moved: false,
    };
    document.body.classList.add("pres-settings-dragging");
    event.preventDefault();
  }

  function _applyPreviewBackground() {
    if (!dom.preview) return;
    const imageUrl = state.previewImageUrl || "";
    dom.preview.style.setProperty("--pres-preview-image", imageUrl ? `url("${imageUrl}")` : "none");
    dom.preview.classList.toggle("has-image", Boolean(imageUrl));
  }

  async function _loadPreviewBackground(project) {
    state.previewImageUrl = "";
    _applyPreviewBackground();
    if (!project?.uuid || project.status_text !== "COMPLETED") return;
    try {
      const orthophoto = await API.orthoUrl(project.uuid);
      if (state.project?.uuid !== project.uuid) return;
      state.previewImageUrl = orthophoto?.preview_url || "";
      _applyPreviewBackground();
    } catch (_) {
      if (state.project?.uuid !== project.uuid) return;
      state.previewImageUrl = "";
      _applyPreviewBackground();
    }
  }

  function _close() {
    _stopDrag();
    dom.modal?.classList.add("hidden");
    state.project = null;
    state.draft = null;
    state.previewImageUrl = "";
    _applyPreviewBackground();
    _setStatus("");
  }

  function _resetDefaults() {
    if (!state.project) return;
    state.draft = _clone(AppPresentation.getDefaultSettings(state.project));
    state.selectedCardId = "hero";
    _setStatus("Varsayılan sunum ayarları yüklendi.", "ok");
    _renderAll();
  }

  function _renderAll() {
    if (!state.project || !state.draft) return;
    if (dom.projectName) {
      dom.projectName.textContent = state.project.museum_name || state.project.name || "Müze Projesi";
    }
    _renderGeneralFields();
    _renderCardList();
    _renderInspector();
    _renderPreview();
  }

  async function _save() {
    if (!state.project || !state.draft) return;
    _handleGeneralInput();
    _setStatus("Sunum ayarları kaydediliyor...");
    dom.saveButton.disabled = true;
    try {
      const updated = await API.updateProject(state.project.uuid, {
        presentation_settings: state.draft,
      });
      state.project = updated;
      _setStatus("Sunum ayarları kaydedildi.", "ok");
      AppToast?.show("Sunum ayarları kaydedildi.", {tone: "success"});
      await state.onSaved?.(updated);
      window.setTimeout(() => _close(), 250);
    } catch (error) {
      _setStatus(`Hata: ${error.message}`, "error");
      AppToast?.show(`Hata: ${error.message}`, {tone: "error", duration: 4200});
    } finally {
      dom.saveButton.disabled = false;
    }
  }

  async function open(project) {
    if (!project) return;
    state.project = project;
    state.draft = _clone(AppPresentation.getResolvedSettings(project));
    state.selectedCardId = "hero";
    state.previewImageUrl = "";
    _setStatus("");
    _renderAll();
    dom.modal?.classList.remove("hidden");
    await _loadPreviewBackground(project);
  }

  function bind(callbacks = {}) {
    state.onSaved = callbacks.onSaved || null;
    dom.modal = document.getElementById("modal-presentation-settings");
    dom.projectName = document.getElementById("pres-settings-project-name");
    dom.status = document.getElementById("pres-settings-status");
    dom.cardList = document.getElementById("pres-settings-card-list");
    dom.preview = document.getElementById("pres-settings-preview");
    dom.inspector = document.getElementById("pres-settings-inspector");
    dom.orbitDirection = document.getElementById("pres-orbit-direction");
    dom.orbitHeading = document.getElementById("pres-orbit-heading");
    dom.orbitPitch = document.getElementById("pres-orbit-pitch");
    dom.orbitRange = document.getElementById("pres-orbit-range");
    dom.orbitSpeed = document.getElementById("pres-orbit-speed");
    dom.autoInterval = document.getElementById("pres-auto-interval");
    dom.autoScrollEnabled = document.getElementById("pres-auto-scroll-enabled");
    dom.autoScrollSpeed = document.getElementById("pres-auto-scroll-speed");
    dom.autoScrollPause = document.getElementById("pres-auto-scroll-pause");
    dom.resetButton = document.getElementById("btn-pres-settings-reset");
    dom.saveButton = document.getElementById("btn-pres-settings-save");
    dom.addCardButton = document.getElementById("btn-pres-settings-add-card");

    [dom.orbitDirection, dom.orbitHeading, dom.orbitPitch, dom.orbitRange, dom.orbitSpeed, dom.autoInterval, dom.autoScrollEnabled, dom.autoScrollSpeed, dom.autoScrollPause].forEach((field) => {
      field?.addEventListener("input", _handleGeneralInput);
      field?.addEventListener("change", _handleGeneralInput);
    });
    dom.resetButton?.addEventListener("click", _resetDefaults);
    dom.saveButton?.addEventListener("click", _save);
    dom.addCardButton?.addEventListener("click", _addCustomCard);

    dom.modal?.addEventListener("click", (event) => {
      if (event.target === dom.modal) _close();
    });
    document.addEventListener("pointermove", _onPointerMove);
    document.addEventListener("pointerup", _stopDrag);
    document.addEventListener("pointercancel", _stopDrag);
    dom.modal?.querySelectorAll("[data-close-presentation-settings]").forEach((button) => {
      button.addEventListener("click", _close);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && dom.modal && !dom.modal.classList.contains("hidden")) {
        _close();
      }
    });
  }

  return {bind, open};
})();
