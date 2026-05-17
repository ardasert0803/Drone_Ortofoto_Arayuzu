window.AppNotes = (() => {
  let viewer = null;
  let currentUuid = null;
  let notes = [];
  let noteEntities = {};
  let clickHandler = null;
  let entityClickHandler = null;
  let pendingPos = null;
  let _activePopupNoteId = null;

  const CAT_COLORS = {
    not:      "#4f9eff",
    sorun:    "#f85149",
    ilerleme: "#3fb950",
    tehlike:  "#f59e0b",
  };

  const CAT_LABELS = {
    not:      "Not",
    sorun:    "Sorun",
    ilerleme: "İlerleme",
    tehlike:  "Tehlike",
  };

  const ICON_PATHS = {
    not:      "M18.364 4.636a9 9 0 0 1 .203 12.519l-.203 .21l-4.243 4.242a3 3 0 0 1 -4.097 .135l-.144 -.135l-4.244 -4.243a9 9 0 0 1 12.728 -12.728zm-6.364 3.364a3 3 0 1 0 0 6a3 3 0 0 0 0 -6",
    sorun:    "M12 1.67c.955 0 1.845 .467 2.39 1.247l.105 .16l8.114 13.548a2.914 2.914 0 0 1 -2.307 4.363l-.195 .008h-16.225a2.914 2.914 0 0 1 -2.582 -4.2l.099 -.185l8.11 -13.538a2.914 2.914 0 0 1 2.491 -1.403zm.01 13.33l-.127 .007a1 1 0 0 0 0 1.986l.117 .007l.127 -.007a1 1 0 0 0 0 -1.986l-.117 -.007zm-.01 -7a1 1 0 0 0 -.993 .883l-.007 .117v4l.007 .117a1 1 0 0 0 1.986 0l.007 -.117v-4l-.007 -.117a1 1 0 0 0 -.993 -.883z",
    ilerleme: "M17 3.34a10 10 0 1 1 -14.995 8.984l-.005 -.324l.005 -.324a10 10 0 0 1 14.995 -8.336zm-1.293 5.953a1 1 0 0 0 -1.32 -.083l-.094 .083l-3.293 3.292l-1.293 -1.292l-.094 -.083a1 1 0 0 0 -1.403 1.403l.083 .094l2 2l.094 .083a1 1 0 0 0 1.226 0l.094 -.083l4 -4l.083 -.094a1 1 0 0 0 -.083 -1.32z",
    tehlike:  "M14.897 1a4 4 0 0 1 2.664 1.016l.165 .156l4.1 4.1a4 4 0 0 1 1.168 2.605l.006 .227v5.794a4 4 0 0 1 -1.016 2.664l-.156 .165l-4.1 4.1a4 4 0 0 1 -2.603 1.168l-.227 .006h-5.795a3.999 3.999 0 0 1 -2.664 -1.017l-.165 -.156l-4.1 -4.1a4 4 0 0 1 -1.168 -2.604l-.006 -.227v-5.794a4 4 0 0 1 1.016 -2.664l.156 -.165l4.1 -4.1a4 4 0 0 1 2.605 -1.168l.227 -.006h5.793zm-2.887 14l-.127 .007a1 1 0 0 0 0 1.986l.117 .007l.127 -.007a1 1 0 0 0 0 -1.986l-.117 -.007zm-.01 -8a1 1 0 0 0 -.993 .883l-.007 .117v4l.007 .117a1 1 0 0 0 1.986 0l.007 -.117v-4l-.007 -.117a1 1 0 0 0 -.993 -.883z",
  };

  function _makePinDataUri(category) {
    const color    = CAT_COLORS[category] || CAT_COLORS.not;
    const iconPath = ICON_PATHS[category] || ICON_PATHS.not;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
      <circle cx="22" cy="22" r="20" fill="white" opacity="0.92"/>
      <circle cx="22" cy="22" r="20" fill="${color}" opacity="0.18"/>
      <circle cx="22" cy="22" r="20" stroke="${color}" stroke-width="2.5" fill="none"/>
      <g transform="translate(10,10)">
        <path fill="${color}" d="${iconPath}"/>
      </g>
    </svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  function _makeActivePinDataUri(category) {
    const color    = CAT_COLORS[category] || CAT_COLORS.not;
    const iconPath = ICON_PATHS[category] || ICON_PATHS.not;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52">
      <circle cx="26" cy="26" r="24" fill="white" opacity="0.97"/>
      <circle cx="26" cy="26" r="24" fill="${color}" opacity="0.22"/>
      <circle cx="26" cy="26" r="24" stroke="${color}" stroke-width="3.5" fill="none"/>
      <g transform="translate(14,14)">
        <path fill="${color}" d="${iconPath}"/>
      </g>
    </svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  function init(_viewer) { viewer = _viewer; }

  function _hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
  }

  function _setActiveCat(cat) {
    const color = CAT_COLORS[cat] || CAT_COLORS.not;
    document.querySelectorAll("#note-category-picker .note-cat-btn").forEach(btn => {
      const isActive = btn.dataset.cat === cat;
      if (isActive) {
        const rgb = _hexToRgb(color);
        btn.style.background    = `rgba(${rgb}, 0.18)`;
        btn.style.borderColor   = `rgba(${rgb}, 0.5)`;
        btn.style.color         = color;
      } else {
        btn.style.background  = "";
        btn.style.borderColor = "";
        btn.style.color       = "";
      }
    });
    const hiddenInput = document.getElementById("note-category");
    if (hiddenInput) hiddenInput.value = cat;
  }

  function bind() {
    document.getElementById("btn-add-note")?.addEventListener("click", startPickLocation);
    document.getElementById("btn-save-note")?.addEventListener("click", commitNote);
    document.getElementById("btn-cancel-note")?.addEventListener("click", cancelPick);
    document.getElementById("note-text")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter")  commitNote();
      if (e.key === "Escape") cancelPick();
    });

    _setActiveCat("not");
    document.querySelectorAll("#note-category-picker .note-cat-btn").forEach(btn => {
      btn.addEventListener("click", () => _setActiveCat(btn.dataset.cat));
    });

    document.getElementById("btn-note-popup-close")?.addEventListener("click", _closeNotePopup);
    document.getElementById("btn-note-popup-delete")?.addEventListener("click", () => {
      if (_activePopupNoteId) _deleteNote(_activePopupNoteId);
    });

    entityClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    entityClickHandler.setInputAction((click) => {
      if (clickHandler) return;
      const picked = viewer.scene.pick(click.position);
      if (Cesium.defined(picked) && picked.id && picked.id._scNoteId) {
        _openNotePopup(picked.id._scNoteId);
      } else {
        _closeNotePopup();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function setProject(uuid) {
    _clearAll();
    currentUuid = uuid;
    notes = _load(uuid);
    for (const n of notes) _addEntity(n);
    _renderList();
  }

  function clearProject() {
    cancelPick();
    _clearAll();
    _closeNotePopup();
    currentUuid = null;
    notes = [];
    _renderList();
  }

  function startPickLocation() {
    if (clickHandler) { clickHandler.destroy(); clickHandler = null; }
    pendingPos = null;
    _closeNotePopup();

    const addBtn = document.getElementById("btn-add-note");
    const form   = document.getElementById("note-form");
    const status = document.getElementById("note-pick-status");

    if (addBtn) { addBtn.disabled = true; }
    if (status) status.textContent = "Harita üzerinde bir konuma tıklayın";
    if (form)   form.hidden = false;

    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      const cartesian = viewer.scene.pickPosition(click.position) ||
                        viewer.camera.pickEllipsoid(click.position, viewer.scene.globe.ellipsoid);
      if (!cartesian) return;
      clickHandler.destroy();
      clickHandler = null;

      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      pendingPos  = {
        cartesian,
        lon:    Cesium.Math.toDegrees(carto.longitude),
        lat:    Cesium.Math.toDegrees(carto.latitude),
        height: carto.height,
      };

      if (addBtn) { addBtn.disabled = false; }
      if (status) status.textContent = `✓ Konum alındı · ${pendingPos.lat.toFixed(5)}°, ${pendingPos.lon.toFixed(5)}°`;
      document.getElementById("note-text")?.focus();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    clickHandler.setInputAction(() => cancelPick(), Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  }

  function cancelPick() {
    if (clickHandler) { clickHandler.destroy(); clickHandler = null; }
    pendingPos = null;
    const addBtn = document.getElementById("btn-add-note");
    const form   = document.getElementById("note-form");
    const status = document.getElementById("note-pick-status");
    const text   = document.getElementById("note-text");
    if (addBtn) { addBtn.disabled = false; }
    if (form)   form.hidden = true;
    if (status) status.textContent = "";
    if (text)   text.value = "";
    _setActiveCat("not");
  }

  function commitNote() {
    const text     = document.getElementById("note-text")?.value.trim() || "";
    const category = document.getElementById("note-category")?.value || "not";
    if (!text) { document.getElementById("note-text")?.focus(); return; }
    if (!pendingPos) {
      window.AppToast?.show("Önce haritada bir konuma tıkla.", { tone: "info" });
      return;
    }
    const note = {
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      lon:       pendingPos.lon,
      lat:       pendingPos.lat,
      height:    pendingPos.height,
      cartesian: { x: pendingPos.cartesian.x, y: pendingPos.cartesian.y, z: pendingPos.cartesian.z },
      text, category,
      createdAt: new Date().toISOString(),
    };
    notes.push(note);
    _save();
    _addEntity(note);
    _renderList();
    cancelPick();
    window.AppToast?.show("Not kaydedildi.", { tone: "success", duration: 1800 });
  }

  function _addEntity(note) {
    const pos = note.cartesian
      ? new Cesium.Cartesian3(note.cartesian.x, note.cartesian.y, note.cartesian.z)
      : Cesium.Cartesian3.fromDegrees(note.lon, note.lat, note.height || 0);

    const billboard = viewer.entities.add({
      position: pos,
      billboard: {
        image:          _makePinDataUri(note.category),
        width:          40,
        height:         40,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelOffset:    new Cesium.Cartesian2(0, 0),
        scaleByDistance: new Cesium.NearFarScalar(100, 1.2, 5000, 0.7),
      },
    });
    billboard._scNoteId = note.id;

    const label = viewer.entities.add({
      position: pos,
      label: {
        text:  note.text,
        font:  "bold 13px sans-serif",
        fillColor:    Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style:          Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset:    new Cesium.Cartesian2(0, -26),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.NONE,
        backgroundEnabled:  true,
        backgroundColor:    Cesium.Color.fromCssColorString(CAT_COLORS[note.category] || CAT_COLORS.not).withAlpha(0.92),
        backgroundPadding:  new Cesium.Cartesian2(8, 5),
        show: false,
      },
    });
    label._scNoteId = note.id;

    noteEntities[note.id] = { billboard, label };
  }

  function _setPinActive(noteId) {
    for (const [id, ents] of Object.entries(noteEntities)) {
      if (ents.label) ents.label.label.show = false;
      if (ents.billboard) ents.billboard.billboard.image = _makePinDataUri(
        notes.find(n => n.id === id)?.category || "not"
      );
    }
    const ents = noteEntities[noteId];
    const note = notes.find(n => n.id === noteId);
    if (!ents || !note) return;
    ents.billboard.billboard.image = _makeActivePinDataUri(note.category);
    ents.label.label.show = true;
  }

  function _setPinNormal(noteId) {
    const ents = noteEntities[noteId];
    const note = notes.find(n => n.id === noteId);
    if (!ents) return;
    ents.billboard.billboard.image = _makePinDataUri(note?.category || "not");
    if (ents.label) ents.label.label.show = false;
  }

  function _clearAll() {
    for (const ents of Object.values(noteEntities)) {
      try { viewer?.entities.remove(ents.billboard); } catch {}
      try { viewer?.entities.remove(ents.label);     } catch {}
    }
    noteEntities = {};
  }

  function _openNotePopup(noteId) {
    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    if (_activePopupNoteId && _activePopupNoteId !== noteId) {
      _setPinNormal(_activePopupNoteId);
    }
    _activePopupNoteId = noteId;
    _setPinActive(noteId);

    const catDot  = document.getElementById("note-popup-cat-dot");
    const catName = document.getElementById("note-popup-cat-name");
    const text    = document.getElementById("note-popup-text");
    const coords  = document.getElementById("note-popup-coords");
    const date    = document.getElementById("note-popup-date");

    if (catDot)  catDot.style.background = CAT_COLORS[note.category] || CAT_COLORS.not;
    if (catName) catName.textContent      = CAT_LABELS[note.category] || "Not";
    if (text)    text.textContent         = note.text;
    if (coords)  coords.textContent       = `${note.lat.toFixed(5)}°, ${note.lon.toFixed(5)}° · ${note.height.toFixed(1)} m`;
    if (date)    date.textContent         = new Date(note.createdAt).toLocaleString("tr-TR");

    const popup = document.getElementById("note-detail-popup");
    if (popup) popup.classList.remove("hidden");
  }

  function _closeNotePopup() {
    if (_activePopupNoteId) {
      _setPinNormal(_activePopupNoteId);
      _activePopupNoteId = null;
    }
    const popup = document.getElementById("note-detail-popup");
    if (popup) popup.classList.add("hidden");
  }

  function _renderList() {
    const list = document.getElementById("notes-list");
    if (!list) return;
    if (!notes.length) {
      list.innerHTML = `<div class="notes-empty">Henüz saha notu yok.</div>`;
      return;
    }
    list.innerHTML = [...notes].reverse().map(n => `
      <div class="note-item" data-note-id="${n.id}">
        <span class="note-cat-dot" style="background:${CAT_COLORS[n.category] || CAT_COLORS.not}"></span>
        <div class="note-item-body">
          <span class="note-cat-label">${_esc(CAT_LABELS[n.category] || "Not")}</span>
          <span class="note-item-text">${_esc(n.text)}</span>
        </div>
        <button class="note-delete" type="button" data-note-id="${n.id}" title="Sil">
          <span class="icon icon-trash"></span>
        </button>
      </div>
    `).join("");

    list.querySelectorAll(".note-item").forEach(item => {
      item.addEventListener("click", (e) => {
        if (e.target.closest(".note-delete")) return;
        _openNotePopup(item.dataset.noteId);
      });
    });
    list.querySelectorAll(".note-delete").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        _deleteNote(btn.dataset.noteId);
      });
    });
  }

  function _deleteNote(id) {
    if (_activePopupNoteId === id) _closeNotePopup();
    const ents = noteEntities[id];
    if (ents) {
      try { viewer.entities.remove(ents.billboard); } catch {}
      try { viewer.entities.remove(ents.label);     } catch {}
      delete noteEntities[id];
    }
    notes = notes.filter(n => n.id !== id);
    _save();
    _renderList();
    window.AppToast?.show("Not silindi.", { tone: "info", duration: 1500 });
  }

  function _load(uuid) {
    try { return JSON.parse(localStorage.getItem(`sc_notes_${uuid}`) || "[]"); }
    catch { return []; }
  }

  function _save() {
    if (currentUuid) localStorage.setItem(`sc_notes_${currentUuid}`, JSON.stringify(notes));
  }

  function _esc(s) {
    return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  return { init, bind, setProject, clearProject };
})();
