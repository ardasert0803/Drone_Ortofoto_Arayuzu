/* Ana uygulama orkestrasyonu. */
(async () => {
  const useCaseLabels = {
    construction: "Santiye",
    heritage: "Kulturel Miras",
    museum: "Muze",
    generic: "Genel",
  };
  const dataSourceLabels = {
    drone: "Drone",
    phone: "Telefon",
    open_source: "Acik Kaynak",
  };
  const modeMeta = {
    drone: {
      heading: "Drone Projeleri",
      button: "+ Yeni Drone Projesi",
      detailTitle: "Secili Drone Projesi",
      brandSubtitle: "Drone · Kaliteli Ortofoto",
      empty: "Henuz drone projesi yok",
    },
    indoor: {
      heading: "Indoor Projeler",
      button: "+ Yeni Indoor Projesi",
      detailTitle: "Secili Indoor Proje",
      brandSubtitle: "Indoor · Telefon Fotogrametri · 3D Tiles",
      empty: "Henuz indoor proje yok",
    },
  };

  const state = {
    mode: "drone",
    projects: {
      drone: [],
      indoor: [],
    },
    selected: {
      drone: null,
      indoor: null,
    },
    fetchingDroneOutputs: new Set(),
  };

  const dom = {
    projectList: document.getElementById("task-list"),
    projectDetail: document.getElementById("task-detail"),
    healthBar: document.getElementById("health-bar"),
    healthText: document.getElementById("health-text"),
    brandSubtitle: document.getElementById("brand-subtitle"),
    projectHeading: document.getElementById("project-heading"),
    detailTitle: document.getElementById("detail-title"),
    newProjectButton: document.getElementById("btn-new-project"),
    modeDroneButton: document.getElementById("btn-mode-drone"),
    modeIndoorButton: document.getElementById("btn-mode-indoor"),
    droneLayerPanel: document.getElementById("panel-layers-drone"),
    indoorLayerPanel: document.getElementById("panel-layers-indoor"),
    measurementPanel: document.getElementById("panel-measurement"),
    measurementTitle: document.getElementById("measurement-title"),
    measurementCopy: document.getElementById("measurement-copy"),
    droneTilesToggle: document.getElementById("layer-3dtiles"),
    indoorTilesToggle: document.getElementById("layer-indoor-model"),
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDate(value) {
    if (!value) return "—";
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return escapeHtml(value);
    const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    return new Date(ms).toLocaleString("tr-TR");
  }

  function currentProjects() {
    return state.projects[state.mode];
  }

  function selectedUuid(mode = state.mode) {
    return state.selected[mode];
  }

  function setMode(mode) {
    state.mode = mode === "indoor" ? "indoor" : "drone";
    const meta = modeMeta[state.mode];
    dom.projectHeading.textContent = meta.heading;
    dom.newProjectButton.textContent = meta.button;
    dom.detailTitle.textContent = meta.detailTitle;
    dom.brandSubtitle.textContent = meta.brandSubtitle;
    dom.modeDroneButton.classList.toggle("active", state.mode === "drone");
    dom.modeIndoorButton.classList.toggle("active", state.mode === "indoor");
    dom.droneLayerPanel.hidden = state.mode !== "drone";
    dom.indoorLayerPanel.hidden = state.mode !== "indoor";
    AppViewer.setMode(state.mode);
    renderProjectList(currentProjects());
    const selected = currentProjects().find((project) => project.uuid === selectedUuid());
    if (selected) {
      void selectProject(selected, {autoFly: false});
    } else {
      dom.projectDetail.textContent = state.mode === "drone"
        ? "Drone projesi secilmedi"
        : "Indoor proje secilmedi";
    }
  }

  let config = {cesium_ion_token: ""};
  try {
    config = await API.config();
  } catch (error) {
    console.warn("Backend /api/config cekilemedi:", error);
  }

  const viewer = await AppViewer.init(config.cesium_ion_token);
  AppMeasure.init(viewer);
  AppMeasure.bind();

  async function refreshHealth() {
    try {
      const health = await API.health();
      if (health.nodeodm) {
        dom.healthBar.className = "health ok";
        const version = health.nodeodm_info?.version || "?";
        dom.healthText.textContent = `NodeODM bagli (v${version})`;
      } else {
        dom.healthBar.className = "health bad";
        dom.healthText.textContent = "NodeODM erisilemez — docker container calisiyor mu?";
      }
    } catch {
      dom.healthBar.className = "health bad";
      dom.healthText.textContent = "Backend yanit vermedi";
    }
  }

  async function hydrateDroneBounds(uuid) {
    try {
      const {bbox} = await API.projectBounds(uuid);
      AppViewer.setProjectBounds(uuid, bbox, "drone");
      return true;
    } catch {
      return false;
    }
  }

  function renderProjectList(projects) {
    if (!projects.length) {
      dom.projectList.innerHTML = `<li class="empty">${modeMeta[state.mode].empty}</li>`;
      return;
    }

    dom.projectList.innerHTML = "";
    for (const project of projects) {
      const li = document.createElement("li");
      li.dataset.uuid = project.uuid;
      if (project.uuid === selectedUuid()) li.classList.add("active");

      const summaryParts = state.mode === "drone"
        ? [useCaseLabels[project.use_case] || null, project.location || null].filter(Boolean)
        : [project.building_name || null, project.floor_label || null, project.space_label || project.location || null].filter(Boolean);

      li.innerHTML = `
        <div class="name">${escapeHtml(project.name || project.uuid.slice(0, 8))}</div>
        ${summaryParts.length ? `<div class="submeta">${summaryParts.map(escapeHtml).join(" · ")}</div>` : ""}
        <div class="meta">
          <span class="meta-left">
            <span class="pipeline-badge">${state.mode === "drone" ? "Drone" : "Indoor"}</span>
            <span>${formatDate(project.date_created)}</span>
          </span>
          <span class="status-pill ${escapeHtml(project.status_text || "")}">${escapeHtml(project.status_text || "?")}</span>
        </div>
      `;
      li.addEventListener("click", () => {
        void selectProject(project);
      });
      dom.projectList.appendChild(li);
    }
  }

  function renderDroneDetail(project) {
    dom.detailTitle.textContent = "Secili Drone Projesi";
    const metadataRows = [
      project.use_case ? row("Proje tipi", useCaseLabels[project.use_case] || project.use_case) : "",
      project.data_source ? row("Veri kaynagi", dataSourceLabels[project.data_source] || project.data_source) : "",
      project.location ? row("Konum", project.location) : "",
      project.capture_date ? row("Cekim tarihi", project.capture_date) : "",
      project.description ? stackedRow("Aciklama", project.description) : "",
    ].join("");

    dom.projectDetail.innerHTML = `
      ${row("UUID", `${project.uuid.slice(0, 12)}...`)}
      ${row("Durum", project.status_text || "?")}
      ${row("Foto", project.images_count ?? "—")}
      ${row("Ilerleme", `${(project.progress ?? 0).toFixed(0)}%`)}
      ${metadataRows}
      ${droneActionsMarkup()}
    `;

    bindDroneActions(project);
  }

  function renderConstructionDetail(project) {
    dom.detailTitle.textContent = "Santiye Projesi Detayi";

    const summaryRows = [
      constructionSummaryRow("Proje", project.name),
      constructionSummaryRow("Durum", project.status_text || "?"),
      constructionSummaryRow("Konum", project.location),
      constructionSummaryRow("Cekim tarihi", project.capture_date),
      constructionSummaryRow("Veri kaynagi", dataSourceLabels[project.data_source] || project.data_source),
      constructionSummaryRow("Foto", project.images_count ?? "—"),
    ].join("");

    const fieldCards = [
      constructionCard(
        "Saha Ozeti",
        project.description || "Bu santiye projesi icin henuz saha ozeti girilmedi.",
      ),
      constructionListCard("Olcum Hazirliklari", [
        "Mesafe araci ile cephe, aks veya saha gecis uzunluklarini kontrol et.",
        "Alan araci ile stok, temel veya kazı yayilimlarini hizlica hesapla.",
        "Yukseklik araci ile kot farki ve dolgu/kazi degisimlerini dogrula.",
      ]),
      constructionListCard("Operasyon Notlari", [
        project.status_text === "COMPLETED"
          ? "Ortofoto tamamlandi; olcum ve saha karsilastirmalari hazir."
          : "Ortofoto tamamlanmadan once bu panel planlama ve not takibi icin kullanilir.",
        project.location ? `Saha referansi: ${project.location}` : "Saha referansi henuz girilmedi.",
        project.capture_date ? `Son cekim tarihi: ${project.capture_date}` : "Cekim tarihi bilgisi eksik.",
      ]),
    ].join("");

    dom.projectDetail.innerHTML = `
      <div class="construction-detail">
        <section class="construction-card construction-hero">
          <span class="construction-kicker">Santiye Projesi</span>
          <h4>${escapeHtml(project.name || "Bilgi girilmedi")}</h4>
          <div class="construction-summary-grid">
            ${summaryRows}
          </div>
        </section>
        ${fieldCards}
        ${droneActionsMarkup()}
      </div>
    `;

    bindDroneActions(project);
  }

  function renderMuseumDetail(project) {
    dom.detailTitle.textContent = "Muze Projesi Detayi";

    const summaryRows = [
      museumSummaryRow("Muze adi", project.museum_name),
      museumSummaryRow("Proje", project.name),
      museumSummaryRow("Durum", project.status_text || "?"),
      museumSummaryRow("Konum", project.location),
      museumSummaryRow("Cekim tarihi", project.capture_date),
      museumSummaryRow("Tarihsel donem", project.historical_period),
    ].join("");

    const museumCards = [
      museumTextCard("Tarihce / Aciklama", project.museum_summary),
      museumTextCard("One Cikan Eserler", project.featured_artifacts),
      museumTextCard("Koleksiyon Temasi", project.collection_theme),
      museumVisitCard(project),
      museumSingleValueCard("Sorumlu", project.curator_contact),
    ].filter(Boolean).join("");

    dom.projectDetail.innerHTML = `
      <div class="museum-detail">
        <section class="museum-card museum-hero">
          <span class="museum-kicker">Muze Projesi</span>
          <h4>${escapeHtml(project.museum_name || project.name || "Bilgi girilmedi")}</h4>
          <div class="museum-summary-grid">
            ${summaryRows}
          </div>
        </section>
        ${museumCards}
        ${droneActionsMarkup()}
      </div>
    `;

    bindDroneActions(project);
  }

  function droneActionsMarkup() {
    return `
      <div class="actions">
        <button id="btn-fetch">Ortofotoyu hazirla</button>
        <button id="btn-fly">Buraya uc</button>
        <button id="btn-delete-drone" class="danger">Sil</button>
      </div>
    `;
  }

  function bindDroneActions(project) {
    document.getElementById("btn-fetch").onclick = () => {
      void fetchAndLoadDroneProject(project.uuid);
    };
    document.getElementById("btn-fly").onclick = async () => {
      const hasBounds = await hydrateDroneBounds(project.uuid);
      const flew = AppViewer.flyTo(project.uuid, "drone");
      if (!flew && project.status_text === "COMPLETED") {
        const loaded = await ensureDroneOutputs(project.uuid, true);
        if (!loaded && !hasBounds) {
          AppToast.show("Bu proje icin ucus konumu bulunamadi.", {tone: "info"});
        }
      }
    };
    document.getElementById("btn-delete-drone").onclick = async () => {
      const shouldDelete = await AppToast.confirm("Bu drone projesi silinsin mi?", {
        confirmText: "Sil",
        cancelText: "Iptal",
      });
      if (!shouldDelete) return;
      await API.deleteProject(project.uuid);
      AppViewer.removeOrthophoto(project.uuid);
      AppViewer.removeTileset(project.uuid, "drone");
      state.selected.drone = null;
      await refreshDroneProjects();
      AppToast.show("Drone projesi silindi.", {tone: "success"});
    };
  }

  function renderIndoorDetail(project) {
    dom.detailTitle.textContent = "Secili Indoor Proje";
    const metadataRows = [
      row("UUID", `${project.uuid.slice(0, 12)}...`),
      row("Durum", project.status_text || "?"),
      row("Asama", project.stage || "upload"),
      row("Foto", project.images_count ?? "—"),
      row("Ilerleme", `${(project.progress ?? 0).toFixed(0)}%`),
      project.building_name ? row("Bina", project.building_name) : "",
      project.floor_label ? row("Kat", project.floor_label) : "",
      project.space_label ? row("Alan", project.space_label) : "",
      project.location ? row("Konum", project.location) : "",
      project.capture_date ? row("Cekim tarihi", project.capture_date) : "",
      project.started_at ? row("Baslangic", formatDate(Date.parse(project.started_at))) : "",
      project.finished_at ? row("Bitis", formatDate(Date.parse(project.finished_at))) : "",
      project.description ? stackedRow("Aciklama", project.description) : "",
      project.dispatch_error ? stackedRow("Dispatch", project.dispatch_error) : "",
      project.error_summary ? stackedRow("Hata ozeti", project.error_summary) : "",
    ].join("");

    dom.projectDetail.innerHTML = `
      ${metadataRows}
      <div class="actions">
        <button id="btn-view-indoor">Modele git</button>
        <a id="btn-log-indoor" class="button-link" href="${API.indoorLogUrl(project.uuid)}" target="_blank" rel="noopener noreferrer">Log indir</a>
        <button id="btn-delete-indoor" class="danger">Sil</button>
      </div>
    `;

    document.getElementById("btn-view-indoor").onclick = async () => {
      const loaded = await ensureIndoorOutputs(project.uuid, true);
      if (!loaded) {
        AppToast.show("Tileset henuz hazir degil.", {tone: "info"});
      }
    };
    document.getElementById("btn-delete-indoor").onclick = async () => {
      const shouldDelete = await AppToast.confirm("Bu indoor proje silinsin mi?", {
        confirmText: "Sil",
        cancelText: "Iptal",
      });
      if (!shouldDelete) return;
      await API.deleteIndoorProject(project.uuid);
      AppViewer.removeTileset(project.uuid, "indoor");
      state.selected.indoor = null;
      await refreshIndoorProjects();
      AppToast.show("Indoor proje silindi.", {tone: "success"});
    };
  }

  function row(label, value) {
    return `<div class="row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
  }

  function stackedRow(label, value) {
    return `<div class="row stacked"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
  }

  function museumSummaryRow(label, value) {
    return `
      <div class="museum-summary-row">
        <span>${escapeHtml(label)}</span>
        <b>${escapeHtml(value || "Bilgi girilmedi")}</b>
      </div>
    `;
  }

  function constructionSummaryRow(label, value) {
    return `
      <div class="construction-summary-row">
        <span>${escapeHtml(label)}</span>
        <b>${escapeHtml(value || "Bilgi girilmedi")}</b>
      </div>
    `;
  }

  function constructionCard(title, body) {
    return `
      <section class="construction-card">
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(body)}</p>
      </section>
    `;
  }

  function constructionListCard(title, items) {
    const rows = items
      .filter(Boolean)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
    return `
      <section class="construction-card">
        <h4>${escapeHtml(title)}</h4>
        <ul class="construction-list">${rows}</ul>
      </section>
    `;
  }

  function syncProjectPanels(project = null) {
    const isIndoor = state.mode === "indoor";
    const isConstruction = state.mode === "drone" && project?.use_case === "construction";
    const isMuseum = state.mode === "drone" && project?.use_case === "museum";

    dom.measurementPanel.hidden = !isConstruction;

    if (isConstruction) {
      dom.measurementTitle.textContent = "Santiye Olcum Araçlari";
      dom.measurementCopy.textContent = "Saha icin mesafe, alan ve yukseklik olcumlerini bu panelden yonet.";
    } else if (isMuseum) {
      dom.measurementTitle.textContent = "Muze Olcum Araçlari";
      dom.measurementCopy.textContent = "Muze projelerinde bilgi kartlari one cikiyor; olcum paneli bu tipte gizlenir.";
    } else if (isIndoor) {
      dom.measurementTitle.textContent = "Indoor Olcum Araçlari";
      dom.measurementCopy.textContent = "Indoor modda bu panel aktif degil.";
    } else {
      dom.measurementTitle.textContent = "Olcum Araçlari";
      dom.measurementCopy.textContent = "Bu proje tipinde olcum paneli gosterilmiyor.";
    }
  }

  function museumTextCard(title, value) {
    if (!value) return "";
    return `
      <section class="museum-card">
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(value)}</p>
      </section>
    `;
  }

  function museumSingleValueCard(title, value) {
    return `
      <section class="museum-card">
        <h4>${escapeHtml(title)}</h4>
        <div class="museum-inline-value">${escapeHtml(value || "Bilgi girilmedi")}</div>
      </section>
    `;
  }

  function museumVisitCard(project) {
    const hasVisitorNotes = Boolean(project.visitor_notes);
    return `
      <section class="museum-card">
        <h4>Ziyaret Bilgileri</h4>
        ${hasVisitorNotes ? `<p>${escapeHtml(project.visitor_notes)}</p>` : ""}
        <div class="museum-summary-grid museum-summary-grid-compact">
          ${museumSummaryRow("Saatler", project.visiting_hours)}
          ${museumSummaryRow("Bilet / Erisim", project.ticket_access)}
          ${museumSummaryRow("Adres", project.museum_address)}
        </div>
      </section>
    `;
  }

  async function fetchAndLoadDroneProject(uuid) {
    if (state.fetchingDroneOutputs.has(uuid)) return;
    state.fetchingDroneOutputs.add(uuid);
    try {
      await API.fetchProjectAssets(uuid);
      await hydrateDroneBounds(uuid);
      await tryLoadDroneOutputs(uuid, true);
      AppToast.show("Ortofoto Cesium'a yuklendi.", {tone: "success"});
    } catch (error) {
      AppToast.show(`Hata: ${error.message}`, {tone: "error", duration: 4200});
    } finally {
      state.fetchingDroneOutputs.delete(uuid);
    }
  }

  async function ensureDroneOutputs(uuid, autoFly = true) {
    if (state.fetchingDroneOutputs.has(uuid)) return true;

    let hasOrtho = false;
    let hasTiles = false;
    try {
      const orthophoto = await API.orthoUrl(uuid);
      await AppViewer.loadOrthophoto(orthophoto, uuid);
      hasOrtho = true;
    } catch {
      hasOrtho = false;
    }

    try {
      const tileset = await API.tilesetUrl(uuid);
      if (tileset.url) {
        await AppViewer.loadTileset(tileset.url, uuid, {pipeline: "drone"});
        hasTiles = true;
      }
    } catch {
      hasTiles = false;
    }

    if (!hasOrtho && !hasTiles) {
      await fetchAndLoadDroneProject(uuid);
    }
    if (autoFly && (hasOrtho || hasTiles)) {
      AppViewer.flyTo(uuid, "drone");
    }
    return hasOrtho || hasTiles;
  }

  async function tryLoadDroneOutputs(uuid, autoFly = true) {
    let loaded = false;
    try {
      const orthophoto = await API.orthoUrl(uuid);
      await AppViewer.loadOrthophoto(orthophoto, uuid);
      loaded = true;
    } catch {
      /* yoksay */
    }
    try {
      const tileset = await API.tilesetUrl(uuid);
      if (tileset.url) {
        await AppViewer.loadTileset(tileset.url, uuid, {pipeline: "drone"});
        loaded = true;
      }
    } catch {
      /* yoksay */
    }
    if (loaded && autoFly) {
      AppViewer.flyTo(uuid, "drone");
    }
    return loaded;
  }

  async function ensureIndoorOutputs(uuid, autoFly = true) {
    try {
      const tileset = await API.indoorTilesetUrl(uuid);
      if (!tileset.url) return false;
      await AppViewer.loadTileset(tileset.url, uuid, {pipeline: "indoor"});
      if (autoFly) AppViewer.flyTo(uuid, "indoor");
      return true;
    } catch {
      return false;
    }
  }

  async function selectProject(project, options = {}) {
    state.selected[state.mode] = project.uuid;
    renderProjectList(currentProjects());

    if (state.mode === "drone") {
      syncProjectPanels(project);
      if (project.use_case === "museum" && project.status_text === "COMPLETED") {
        renderMuseumDetail(project);
      } else if (project.use_case === "construction") {
        renderConstructionDetail(project);
      } else {
        renderDroneDetail(project);
      }
      const autoFly = options.autoFly !== false;
      const hasBounds = await hydrateDroneBounds(project.uuid);
      if (autoFly && hasBounds) {
        AppViewer.flyTo(project.uuid, "drone");
      }
      if (project.status_text === "COMPLETED") {
        await ensureDroneOutputs(project.uuid, autoFly && !hasBounds);
      }
      return;
    }

    syncProjectPanels(project);
    renderIndoorDetail(project);
    if (project.status_text === "COMPLETED") {
      await ensureIndoorOutputs(project.uuid, options.autoFly !== false);
    }
  }

  async function refreshDroneProjects() {
    try {
      state.projects.drone = await API.listProjects();
      if (state.mode === "drone") {
        renderProjectList(state.projects.drone);
        const selected = state.projects.drone.find((project) => project.uuid === state.selected.drone);
        if (selected) {
          await selectProject(selected, {autoFly: false});
        }
      }
    } catch (error) {
      if (state.mode === "drone") {
        dom.projectList.innerHTML = `<li class="empty">Hata: ${escapeHtml(error.message)}</li>`;
      }
    }
  }

  async function refreshIndoorProjects() {
    try {
      state.projects.indoor = await API.listIndoorProjects();
      if (state.mode === "indoor") {
        renderProjectList(state.projects.indoor);
        const selected = state.projects.indoor.find((project) => project.uuid === state.selected.indoor);
        if (selected) {
          await selectProject(selected, {autoFly: false});
        }
      }
    } catch (error) {
      if (state.mode === "indoor") {
        dom.projectList.innerHTML = `<li class="empty">Hata: ${escapeHtml(error.message)}</li>`;
      }
    }
  }

  dom.modeDroneButton.addEventListener("click", () => setMode("drone"));
  dom.modeIndoorButton.addEventListener("click", () => setMode("indoor"));

  document.getElementById("layer-orthophoto").addEventListener("change", (event) => {
    AppViewer.setOrthoVisibility(event.target.checked);
  });
  dom.droneTilesToggle.addEventListener("change", (event) => {
    AppViewer.setDroneTilesetVisibility(event.target.checked);
  });
  dom.indoorTilesToggle.addEventListener("change", (event) => {
    AppViewer.setIndoorTilesetVisibility(event.target.checked);
  });
  document.getElementById("layer-osm-buildings").addEventListener("change", (event) => {
    void AppViewer.toggleOsmBuildings(event.target.checked);
  });
  document.getElementById("opacity-orthophoto").addEventListener("input", (event) => {
    AppViewer.setOrthoOpacity(event.target.value);
  });

  AppUpload.bind({
    getMode: () => state.mode,
    onDroneCreated: async () => {
      await refreshDroneProjects();
    },
    onIndoorCreated: async () => {
      await refreshIndoorProjects();
    },
  });

  setMode("drone");
  syncProjectPanels();
  await refreshHealth();
  await Promise.all([refreshDroneProjects(), refreshIndoorProjects()]);
  setInterval(refreshHealth, 15_000);
  setInterval(() => {
    void refreshDroneProjects();
    void refreshIndoorProjects();
  }, 10_000);
})();
