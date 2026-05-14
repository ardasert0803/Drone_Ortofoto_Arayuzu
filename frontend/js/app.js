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
  const projectMeta = {
    heading: "Drone Projeleri",
    button: "+ Yeni Drone Projesi",
    detailTitle: "Secili Drone Projesi",
    brandSubtitle: "Drone · Kaliteli Ortofoto",
    empty: "Henuz drone projesi yok",
  };

  const state = {
    mode: "drone",
    projects: [],
    selected: null,
    fetchingDroneOutputs: new Set(),
    tilesetEditing: null,
  };
  const CESIUM_ION_TOKEN = "";

  const dom = {
    projectList: document.getElementById("task-list"),
    projectDetail: document.getElementById("task-detail"),
    brandSubtitle: document.getElementById("brand-subtitle"),
    projectHeading: document.getElementById("project-heading"),
    detailTitle: document.getElementById("detail-title"),
    newProjectButton: document.getElementById("btn-new-project"),
    modeDroneButton: document.getElementById("btn-mode-drone"),
    droneLayerPanel: document.getElementById("panel-layers-drone"),
    measurementPanel: document.getElementById("panel-measurement"),
    measurementTitle: document.getElementById("measurement-title"),

    droneTilesToggle: document.getElementById("layer-3dtiles"),
    // Şantiye modu
    sidebarDefaultContent: document.getElementById("sidebar-default-content"),
    sidebarConstruction: document.getElementById("sidebar-construction"),
    sidebarProjectBadge: document.getElementById("sidebar-project-badge"),
    constrSiteName: document.getElementById("constr-site-name"),
    constrSiteMeta: document.getElementById("constr-site-meta"),
    constrQuickStats: document.getElementById("constr-quick-stats"),
    constructionLayerPanel: document.getElementById("panel-layers-construction"),
    siteInfoPanel: document.getElementById("panel-site-info"),
    siteInfoContent: document.getElementById("site-info-content"),
    projectDetailPanel: document.getElementById("panel-project-detail"),
    aboutPanel: document.getElementById("panel-about"),
    notesPanel: document.getElementById("panel-quick-notes"),
    tilesetEditHud: document.getElementById("tileset-edit-hud"),
    tilesetEditTitle: document.getElementById("tileset-edit-title"),
    tilesetEditSubtitle: document.getElementById("tileset-edit-subtitle"),
    tilesetEditSave: document.getElementById("btn-tileset-edit-save"),
    tilesetEditCancel: document.getElementById("btn-tileset-edit-cancel"),
    tilesetEditReset: document.getElementById("btn-tileset-edit-reset"),
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
    return state.projects;
  }

  function findDroneProject(uuid) {
    return state.projects.find((project) => project.uuid === uuid) || null;
  }

  function upsertDroneProject(project) {
    const index = state.projects.findIndex((entry) => entry.uuid === project.uuid);
    if (index >= 0) {
      state.projects.splice(index, 1, project);
    } else {
      state.projects.unshift(project);
    }
  }

  function selectedUuid() {
    return state.selected;
  }

  function readRouteState() {
    const url = new URL(window.location.href);
    const projectUuid = url.searchParams.get("project") || "";
    return {projectUuid};
  }

  function writeRouteState(projectUuid = selectedUuid(), options = {}) {
    const url = new URL(window.location.href);
    url.searchParams.delete("mode");
    if (projectUuid) {
      url.searchParams.set("project", projectUuid);
    } else {
      url.searchParams.delete("project");
    }
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) return;
    const historyMethod = options.replace ? "replaceState" : "pushState";
    window.history[historyMethod]({}, "", nextUrl);
  }

  function getProjectUseCase(project) {
    const normalized = typeof project?.use_case === "string" ? project.use_case.trim().toLowerCase() : "";
    if (normalized) return normalized;
    const sourceText = [project?.name, project?.description, project?.location]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("tr-TR");
    if (sourceText.includes("müze") || sourceText.includes("muze")) return "museum";
    if (sourceText.includes("şantiye") || sourceText.includes("santiye") || sourceText.includes("insa")) {
      return "construction";
    }
    return "generic";
  }

  async function restoreSelection(options = {}) {
    const projects = state.projects;
    const route = readRouteState();
    const preferredUuid = state.selected || route.projectUuid;
    const selected = projects.find((project) => project.uuid === preferredUuid);
    if (selected) {
      await selectProject(selected, {autoFly: options.autoFly === true, updateUrl: false});
      return true;
    }
    return false;
  }

  function initializeDroneMode(options = {}) {
    if (state.tilesetEditing && options.preserveTilesetEditor !== true) {
      void closeTilesetPlacementEditor({restoreOriginal: true, silent: true});
    }
    state.mode = "drone";
    dom.projectHeading.textContent = projectMeta.heading;
    dom.newProjectButton.textContent = projectMeta.button;
    dom.detailTitle.textContent = projectMeta.detailTitle;
    dom.brandSubtitle.textContent = projectMeta.brandSubtitle;
    dom.modeDroneButton.classList.add("active");
    const inConstrMode = !dom.sidebarConstruction.hidden;
    dom.droneLayerPanel.hidden = inConstrMode;
    AppViewer.setMode("drone");
    if (options.updateUrl !== false) {
      writeRouteState(selectedUuid(), {replace: options.replaceUrl === true});
    }
    renderProjectList(currentProjects());
    const selected = currentProjects().find((project) => project.uuid === selectedUuid());
    if (selected && options.syncSelection !== false) {
      void selectProject(selected, {autoFly: false});
    } else {
      syncProjectPanels();
      dom.projectDetail.textContent = "Drone projesi secilmedi";
    }
  }

  function setMode(_mode = "drone", options = {}) {
    initializeDroneMode(options);
  }

  const viewer = await AppViewer.init(CESIUM_ION_TOKEN);
  AppMeasure.init(viewer);
  AppMeasure.bind();
  AppNotes.init(viewer);
  AppNotes.bind();
  AppAnnotate.bind();
  AppPresentation.bind();
  AppPresentationSettings.bind({
    onSaved: async (project) => {
      state.selected = project.uuid;
      await refreshDroneProjects();
    },
  });

  document.getElementById("btn-screenshot").addEventListener("click", () => {
    try {
      viewer.render();
      const dataUrl = viewer.canvas.toDataURL("image/png");
      AppAnnotate.open(dataUrl);
    } catch {
      AppToast.show("Ekran görüntüsü alınamadı.", { tone: "error" });
    }
  });

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
      dom.projectList.innerHTML = `<li class="empty">${projectMeta.empty}</li>`;
      return;
    }

    dom.projectList.innerHTML = "";
    for (const project of projects) {
      const li = document.createElement("li");
      li.dataset.uuid = project.uuid;
      if (project.uuid === selectedUuid()) li.classList.add("active");
      const projectUseCase = getProjectUseCase(project);
      const summaryParts = [useCaseLabels[projectUseCase] || null, project.location || null].filter(Boolean);

      li.innerHTML = `
        <div class="task-card-head">
          <div class="name">${escapeHtml(project.name || project.uuid.slice(0, 8))}</div>
          <button type="button" class="task-card-edit">Duzenle</button>
        </div>
        ${summaryParts.length ? `<div class="submeta">${summaryParts.map(escapeHtml).join(" · ")}</div>` : ""}
        <div class="meta">
          <span class="meta-left">
            <span class="pipeline-badge">Drone</span>
            <span>${formatDate(project.date_created)}</span>
          </span>
          <span class="status-pill ${escapeHtml(project.status_text || "")}">${escapeHtml(project.status_text || "?")}</span>
        </div>
      `;
      li.addEventListener("click", () => {
        void selectProject(project);
      });
      li.querySelector(".task-card-edit")?.addEventListener("click", (event) => {
        event.stopPropagation();
        AppUpload.openDroneEditor(project);
      });
      dom.projectList.appendChild(li);
    }
  }

  function renderDroneDetail(project) {
    dom.detailTitle.textContent = "Secili Drone Projesi";
    const projectUseCase = getProjectUseCase(project);
    const metadataRows = [
      projectUseCase ? row("Proje tipi", useCaseLabels[projectUseCase] || projectUseCase) : "",
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
    // Şantiye modunda task-detail kullanılmıyor; bilgiler panel-site-info'ya gidecek.
    dom.projectDetail.innerHTML = "";
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
        <div class="museum-presentation-actions">
          <button id="btn-presentation-mode" class="pres-launch-btn" type="button">
            <span class="icon icon-presentation pres-launch-icon"></span>
            <div class="pres-launch-text">
              <span class="pres-launch-title">Sunum Modunu Başlat</span>
              <span class="pres-launch-sub">3D model etrafında dönerek müzeyi sergile</span>
            </div>
          </button>
          <button id="btn-presentation-settings" class="pres-launch-btn pres-settings-btn" type="button">
            <span class="icon icon-adjustments pres-launch-icon"></span>
            <div class="pres-launch-text">
              <span class="pres-launch-title">Sunum Modu Ayarlari</span>
              <span class="pres-launch-sub">Kartlari, metinleri ve kamera akisini duzenle</span>
            </div>
          </button>
        </div>
        ${droneActionsMarkup()}
      </div>
    `;

    bindDroneActions(project);
    document.getElementById("btn-presentation-mode")?.addEventListener("click", () => {
      AppPresentation.open(project, project.uuid);
    });
    document.getElementById("btn-presentation-settings")?.addEventListener("click", () => {
      AppPresentationSettings.open(project);
    });
  }

  function droneActionsMarkup() {
    return `
      <div class="actions">
        <button id="btn-edit-tileset">3D Yerlestir</button>
        <button id="btn-edit-drone">Duzenle</button>
        <button id="btn-delete-drone" class="danger">Sil</button>
      </div>
    `;
  }

  function bindDroneActions(project) {
    document.getElementById("btn-edit-tileset").onclick = () => {
      void openTilesetPlacementEditor(project);
    };
    document.getElementById("btn-edit-drone").onclick = () => {
      AppUpload.openDroneEditor(project);
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
      state.selected = null;
      await refreshDroneProjects();
      AppToast.show("Drone projesi silindi.", {tone: "success"});
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

  function constructionToolCard(title, items) {
    const rows = items
      .filter(([label, body]) => label || body)
      .map(([label, body]) => `
        <div class="construction-tool-row">
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(body)}</span>
        </div>
      `)
      .join("");
    return `
      <section class="construction-card">
        <h4>${escapeHtml(title)}</h4>
        <div class="construction-tool-grid">${rows}</div>
      </section>
    `;
  }

  function _statusLabel(statusText) {
    const statusLabels = { COMPLETED: "Tamamlandı", RUNNING: "İşleniyor", FAILED: "Hata", QUEUED: "Kuyrukta" };
    return statusLabels[statusText] || statusText || "—";
  }

  function populateProjectSidebar(project, kind = "construction") {
    const isMuseum = kind === "museum";
    dom.sidebarProjectBadge.textContent = isMuseum ? "Müze" : "Şantiye";
    dom.sidebarProjectBadge.className = `site-badge${isMuseum ? " museum" : ""}`;
    dom.constrSiteName.textContent = isMuseum
      ? (project.museum_name || project.name || "İsimsiz Müze")
      : (project.name || "İsimsiz Şantiye");
    dom.constrSiteMeta.innerHTML = [
      project.location ? `<span><span class="icon icon-pin" aria-hidden="true"></span>${escapeHtml(project.location)}</span>` : "",
      project.capture_date ? `<span><span class="icon icon-calendar" aria-hidden="true"></span>${escapeHtml(project.capture_date)}</span>` : "",
    ].join("");

    const stats = isMuseum
      ? [
          { iconClass: "icon-camera", label: "Fotoğraf", value: project.images_count ?? "—" },
          { iconClass: "icon-calendar", label: "Dönem", value: project.historical_period || "—" },
        ]
      : [
          { iconClass: "icon-camera", label: "Fotoğraf", value: project.images_count ?? "—" },
          { iconClass: "icon-bolt", label: "Durum", value: _statusLabel(project.status_text) },
        ];

    dom.constrQuickStats.innerHTML = stats.map((item) => `
      <div class="constr-stat">
        <span class="icon ${escapeHtml(item.iconClass)} constr-stat-icon" aria-hidden="true"></span>
        <div class="constr-stat-body">
          <span class="constr-stat-label">${escapeHtml(item.label)}</span>
          <span class="constr-stat-value">${escapeHtml(String(item.value))}</span>
        </div>
      </div>
    `).join("");
  }

  function showProjectFocusSidebar(project, kind = "construction") {
    dom.sidebarDefaultContent.hidden = true;
    dom.sidebarConstruction.hidden = false;
    populateProjectSidebar(project, kind);
  }

  function resetProjectFocusPanels() {
    dom.sidebarDefaultContent.hidden = false;
    dom.sidebarConstruction.hidden = true;
    dom.constructionLayerPanel.hidden = true;
    dom.siteInfoPanel.hidden = true;
    dom.measurementPanel.hidden = true;
    dom.notesPanel.hidden = true;
    dom.droneLayerPanel.hidden = (state.mode !== "drone");
    dom.projectDetailPanel.hidden = false;
    dom.aboutPanel.hidden = false;
    AppMeasure.clearAll();
    AppNotes.clearProject();
  }

  function enterConstructionMode(project) {
    showProjectFocusSidebar(project, "construction");

    dom.droneLayerPanel.hidden = true;
    dom.projectDetailPanel.hidden = true;
    dom.aboutPanel.hidden = true;
    dom.constructionLayerPanel.hidden = false;
    dom.measurementPanel.hidden = false;
    dom.siteInfoPanel.hidden = false;
    dom.notesPanel.hidden = false;

    if (dom.measurementTitle) dom.measurementTitle.textContent = "Ölçüm Araçları";

    AppNotes.setProject(project.uuid);

    // Katman senkronizasyonu: mevcut drone panel durumunu kopyala
    const orthoCheck = document.getElementById("layer-orthophoto");
    const tilesCheck = document.getElementById("layer-3dtiles");
    const opacitySlider = document.getElementById("opacity-orthophoto");
    const constrOrtho   = document.getElementById("layer-ortho-constr");
    const constrTiles   = document.getElementById("layer-3d-constr");
    const constrOpacity = document.getElementById("opacity-ortho-constr");
    if (constrOrtho && orthoCheck)     constrOrtho.checked   = orthoCheck.checked;
    if (constrTiles && tilesCheck)     constrTiles.checked   = tilesCheck.checked;
    if (constrOpacity && opacitySlider) constrOpacity.value  = opacitySlider.value;

    renderSiteInfoPanel(project);
  }

  function enterMuseumMode(project) {
    showProjectFocusSidebar(project, "museum");
    dom.droneLayerPanel.hidden = false;
    dom.projectDetailPanel.hidden = false;
    dom.aboutPanel.hidden = false;
    dom.constructionLayerPanel.hidden = true;
    dom.siteInfoPanel.hidden = true;
    dom.measurementPanel.hidden = true;
    dom.notesPanel.hidden = true;
    AppMeasure.clearAll();
    AppNotes.clearProject();
  }

  function _siteInfoCard(label, value, iconClass) {
    return `
      <div class="site-mini-card">
        <span class="icon ${escapeHtml(iconClass)} site-mini-icon" aria-hidden="true"></span>
        <div class="site-mini-body">
          <span class="site-mini-label">${escapeHtml(label)}</span>
          <b class="site-mini-value">${escapeHtml(value)}</b>
        </div>
      </div>`;
  }

  function renderSiteInfoPanel(project) {
    // Status pill
    const statusPill = document.getElementById("site-status-pill");
    if (statusPill) {
      const toneMap = { COMPLETED: "ok", RUNNING: "warn", FAILED: "danger", QUEUED: "info" };
      const labelMap = { COMPLETED: "Tamamlandı", RUNNING: "İşleniyor", FAILED: "Hata", QUEUED: "Kuyrukta" };
      statusPill.textContent = labelMap[project.status_text] || project.status_text || "—";
      statusPill.className = `site-status-pill ${toneMap[project.status_text] || ""}`;
    }

    // Mini kartlar + açıklama
    const cards = [
      project.location     ? _siteInfoCard("Konum", project.location, "icon-pin") : "",
      project.capture_date ? _siteInfoCard("Çekim", project.capture_date, "icon-calendar") : "",
    ].join("");

    const desc = project.description
      ? `<div class="site-desc-block"><span class="site-desc-label">Notlar</span><p class="site-desc-text">${escapeHtml(project.description)}</p></div>`
      : "";

    dom.siteInfoContent.innerHTML = (cards + desc) || `<p class="site-empty-note">Saha bilgisi girilmedi.</p>`;

    document.getElementById("btn-constr-fly").onclick = async () => {
      const hasBounds = await hydrateDroneBounds(project.uuid);
      const flew = AppViewer.flyTo(project.uuid, "drone");
      if (!flew && project.status_text === "COMPLETED") {
        await ensureDroneOutputs(project.uuid, true);
      } else if (!flew && !hasBounds) {
        AppToast.show("Saha konumu henüz hazır değil.", { tone: "info" });
      }
    };
    document.getElementById("btn-constr-refresh").onclick = () => {
      void fetchAndLoadDroneProject(project.uuid);
    };
    document.getElementById("btn-constr-tileset-edit").onclick = () => {
      void openTilesetPlacementEditor(project);
    };
  }

  function setTilesetEditHud(project) {
    if (!dom.tilesetEditHud) return;
    dom.tilesetEditTitle.textContent = `3D Yerlestirme · ${project.name || project.uuid.slice(0, 8)}`;
    dom.tilesetEditSubtitle.textContent = "Oklar ve yaw etiketleri ile modeli duzenle. Basili tutarsan hizli ilerler.";
    dom.tilesetEditHud.hidden = false;
  }

  function clearTilesetEditHud() {
    if (!dom.tilesetEditHud) return;
    dom.tilesetEditHud.hidden = true;
  }

  function syncProjectPanels(project = null) {
    const projectUseCase = getProjectUseCase(project);
    const isConstruction = projectUseCase === "construction";
    const isMuseum = projectUseCase === "museum";

    if (isConstruction && project) {
      enterConstructionMode(project);
      return;
    }

    if (isMuseum && project) {
      enterMuseumMode(project);
      return;
    }

    if (!dom.sidebarConstruction.hidden) {
      resetProjectFocusPanels();
    }

    dom.measurementPanel.hidden = true;

    if (dom.measurementTitle) {
      dom.measurementTitle.textContent = "Ölçüm Araçları";
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
    const project = findDroneProject(uuid);
    const adjustment = project?.tileset_adjustment || null;

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
        await AppViewer.loadTileset(tileset.url, uuid, {pipeline: "drone", adjustment});
        hasTiles = true;
      }
    } catch (error) {
      console.warn("[tileset] ensure load failed", uuid, error);
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
    const project = findDroneProject(uuid);
    const adjustment = project?.tileset_adjustment || null;
    let loaded = false;
    try {
      const orthophoto = await API.orthoUrl(uuid);
      await AppViewer.loadOrthophoto(orthophoto, uuid, {forceReload: true});
      loaded = true;
    } catch {
      /* yoksay */
    }
    try {
      const tileset = await API.tilesetUrl(uuid);
      if (tileset.url) {
        await AppViewer.loadTileset(tileset.url, uuid, {pipeline: "drone", forceReload: true, adjustment});
        loaded = true;
      }
    } catch (error) {
      console.warn("[tileset] try load failed", uuid, error);
    }
    if (loaded && autoFly) {
      AppViewer.flyTo(uuid, "drone");
    }
    return loaded;
  }

  async function selectProject(project, options = {}) {
    if (state.tilesetEditing?.uuid && state.tilesetEditing.uuid !== project.uuid) {
      await closeTilesetPlacementEditor({restoreOriginal: true, silent: true});
    }
    state.selected = project.uuid;
    if (options.updateUrl !== false) {
      writeRouteState(project.uuid, {replace: options.replaceUrl === true});
    }
    renderProjectList(currentProjects());

    const projectUseCase = getProjectUseCase(project);
    syncProjectPanels(project);
    if (projectUseCase === "museum" && project.status_text === "COMPLETED") {
      renderMuseumDetail(project);
    } else if (projectUseCase === "construction") {
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
  }

  async function openTilesetPlacementEditor(project) {
    if (!project || project.status_text !== "COMPLETED") {
      AppToast.show("3D yerlestirme icin proje once tamamlanmis olmali.", {tone: "info"});
      return;
    }
    if (state.tilesetEditing?.uuid && state.tilesetEditing.uuid !== project.uuid) {
      await closeTilesetPlacementEditor({restoreOriginal: true, silent: true});
    }
    if (state.tilesetEditing?.uuid === project.uuid) {
      AppToast.show("3D yerlestirme modu zaten acik.", {tone: "info"});
      return;
    }
    const loaded = await ensureDroneOutputs(project.uuid, false);
    if (!loaded && !AppViewer.getTilesetDebugInfo(project.uuid, "drone")) {
      AppToast.show("Bu proje icin 3D tiles bulunamadi.", {tone: "error", duration: 4200});
      return;
    }
    const originalAdjustment = project.tileset_adjustment || null;
    const started = AppViewer.startTilesetAdjustmentEditor(project.uuid, {
      pipeline: "drone",
      adjustment: originalAdjustment,
    });
    if (!started) {
      AppToast.show("3D yerlestirme modu baslatilamadi.", {tone: "error"});
      return;
    }
    state.tilesetEditing = {
      uuid: project.uuid,
      pipeline: "drone",
      originalAdjustment,
      project,
    };
    setTilesetEditHud(project);
    AppToast.show("3D yerlestirme modu acildi.", {tone: "success", duration: 2200});
  }

  async function saveTilesetAdjustment(project, adjustment, context = {}) {
    const updated = await API.updateProject(project.uuid, {
      tileset_adjustment: adjustment,
    });
    const nextProject = {
      ...project,
      ...updated,
      tileset_adjustment: updated.tileset_adjustment || null,
    };
    upsertDroneProject(nextProject);
    AppViewer.setTilesetAdjustment(project.uuid, nextProject.tileset_adjustment || null, context.pipeline || "drone");
    if (state.selected === project.uuid) {
      await selectProject(nextProject, {autoFly: false, updateUrl: false});
    } else {
      renderProjectList(currentProjects());
    }
    AppToast.show("3D model yerlestirmesi kaydedildi.", {tone: "success"});
    return nextProject;
  }

  async function closeTilesetPlacementEditor(options = {}) {
    const editing = state.tilesetEditing;
    if (!editing) return;
    if (options.restoreOriginal) {
      AppViewer.setTilesetAdjustment(editing.uuid, editing.originalAdjustment || null, editing.pipeline);
    }
    AppViewer.stopTilesetAdjustmentEditor();
    state.tilesetEditing = null;
    clearTilesetEditHud();
    if (!options.silent) {
      AppToast.show(options.restoreOriginal ? "3D yerlestirme iptal edildi." : "3D yerlestirme modu kapatildi.", {tone: "info"});
    }
  }

  async function saveActiveTilesetPlacement() {
    const editing = state.tilesetEditing;
    if (!editing) return;
    const project = findDroneProject(editing.uuid) || editing.project;
    const adjustment = AppViewer.getTilesetAdjustment(editing.uuid, editing.pipeline);
    const updated = await saveTilesetAdjustment(project, adjustment, {pipeline: editing.pipeline});
    AppViewer.stopTilesetAdjustmentEditor();
    state.tilesetEditing = null;
    clearTilesetEditHud();
    return updated;
  }

  async function refreshDroneProjects() {
    try {
      state.projects = await API.listProjects();
      renderProjectList(state.projects);
      const restored = await restoreSelection();
      if (!restored && !state.projects.length) {
        syncProjectPanels();
      }
    } catch (error) {
      dom.projectList.innerHTML = `<li class="empty">Hata: ${escapeHtml(error.message)}</li>`;
    }
  }

  async function refreshIndoorProjects() {
    return Promise.resolve();
  }

  dom.modeDroneButton.addEventListener("click", () => setMode("drone"));
  window.addEventListener("popstate", () => {
    initializeDroneMode({updateUrl: false, syncSelection: false});
    void restoreSelection({autoFly: true});
  });

  document.getElementById("layer-orthophoto").addEventListener("change", (event) => {
    AppViewer.setOrthoVisibility(event.target.checked);
  });
  dom.droneTilesToggle.addEventListener("change", (event) => {
    AppViewer.setDroneTilesetVisibility(event.target.checked);
  });
  document.getElementById("layer-osm-buildings").addEventListener("change", (event) => {
    void AppViewer.toggleOsmBuildings(event.target.checked);
  });
  document.getElementById("opacity-orthophoto").addEventListener("input", (event) => {
    AppViewer.setOrthoOpacity(event.target.value);
  });

  document.getElementById("btn-back-to-projects").addEventListener("click", () => {
    if (state.tilesetEditing) {
      void closeTilesetPlacementEditor({restoreOriginal: true, silent: true});
    }
    resetProjectFocusPanels();
    state.selected = null;
    writeRouteState(null);
    dom.projectDetail.textContent = "Proje seçilmedi";
    if (dom.detailTitle) dom.detailTitle.textContent = "Seçili Drone Projesi";
    renderProjectList(currentProjects());
    AppViewer.flyToHome({ duration: 1.8 });
  });

  // Şantiye katman paneli event listenerları — drone panel ile senkron
  document.getElementById("layer-ortho-constr").addEventListener("change", (e) => {
    document.getElementById("layer-orthophoto").checked = e.target.checked;
    AppViewer.setOrthoVisibility(e.target.checked);
  });
  document.getElementById("layer-3d-constr").addEventListener("change", (e) => {
    document.getElementById("layer-3dtiles").checked = e.target.checked;
    AppViewer.setDroneTilesetVisibility(e.target.checked);
  });
  document.getElementById("opacity-ortho-constr").addEventListener("input", (e) => {
    document.getElementById("opacity-orthophoto").value = e.target.value;
    AppViewer.setOrthoOpacity(e.target.value);
  });
  dom.tilesetEditSave?.addEventListener("click", () => {
    void saveActiveTilesetPlacement();
  });
  dom.tilesetEditCancel?.addEventListener("click", () => {
    void closeTilesetPlacementEditor({restoreOriginal: true});
  });
  dom.tilesetEditReset?.addEventListener("click", () => {
    const editing = state.tilesetEditing;
    if (!editing) return;
    AppViewer.setTilesetAdjustment(editing.uuid, null, editing.pipeline);
  });
  document.addEventListener("keydown", (event) => {
    if (!state.tilesetEditing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      void closeTilesetPlacementEditor({restoreOriginal: true});
    } else if (
      (event.key === "Enter" && (event.ctrlKey || event.metaKey))
      || (event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey))
    ) {
      if (event.target && /input|textarea|select/i.test(event.target.tagName || "")) return;
      event.preventDefault();
      void saveActiveTilesetPlacement();
    }
  });

  AppUpload.bind({
    getMode: () => state.mode,
    onDroneCreated: async () => {
      await refreshDroneProjects();
    },
    onDroneUpdated: async (project) => {
      state.selected = project.uuid;
      await refreshDroneProjects();
    },
    onIndoorCreated: async () => {
      await refreshIndoorProjects();
    },
  });

  const initialRoute = readRouteState();
  initializeDroneMode({updateUrl: false, syncSelection: false});
  syncProjectPanels();
  await refreshDroneProjects();
  if (initialRoute.projectUuid) {
    await restoreSelection({autoFly: true});
  } else {
    writeRouteState(selectedUuid(), {replace: true});
  }
  setInterval(() => {
    void refreshDroneProjects();
  }, 10_000);
})();
