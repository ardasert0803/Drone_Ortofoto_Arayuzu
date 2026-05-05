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

    droneTilesToggle: document.getElementById("layer-3dtiles"),
    indoorTilesToggle: document.getElementById("layer-indoor-model"),
    // Şantiye modu
    sidebarDefaultContent: document.getElementById("sidebar-default-content"),
    sidebarConstruction: document.getElementById("sidebar-construction"),
    constrSiteName: document.getElementById("constr-site-name"),
    constrSiteMeta: document.getElementById("constr-site-meta"),
    constrQuickStats: document.getElementById("constr-quick-stats"),
    constructionLayerPanel: document.getElementById("panel-layers-construction"),
    siteInfoPanel: document.getElementById("panel-site-info"),
    siteInfoContent: document.getElementById("site-info-content"),
    projectDetailPanel: document.getElementById("panel-project-detail"),
    aboutPanel: document.getElementById("panel-about"),
    notesPanel: document.getElementById("panel-quick-notes"),
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

  function readRouteState() {
    const url = new URL(window.location.href);
    const mode = url.searchParams.get("mode") === "indoor" ? "indoor" : "drone";
    const projectUuid = url.searchParams.get("project") || "";
    return {mode, projectUuid};
  }

  function writeRouteState(mode = state.mode, projectUuid = selectedUuid(mode), options = {}) {
    const url = new URL(window.location.href);
    const nextMode = mode === "indoor" ? "indoor" : "drone";
    url.searchParams.set("mode", nextMode);
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

  async function restoreSelectionForMode(mode, options = {}) {
    const projects = state.projects[mode];
    const route = readRouteState();
    const preferredUuid = state.selected[mode] || (route.mode === mode ? route.projectUuid : "");
    const selected = projects.find((project) => project.uuid === preferredUuid);
    if (selected) {
      await selectProject(selected, {autoFly: options.autoFly === true, updateUrl: false});
      return true;
    }
    return false;
  }

  function setMode(mode, options = {}) {
    state.mode = mode === "indoor" ? "indoor" : "drone";
    const meta = modeMeta[state.mode];
    dom.projectHeading.textContent = meta.heading;
    dom.newProjectButton.textContent = meta.button;
    dom.detailTitle.textContent = meta.detailTitle;
    dom.brandSubtitle.textContent = meta.brandSubtitle;
    dom.modeDroneButton.classList.toggle("active", state.mode === "drone");
    dom.modeIndoorButton.classList.toggle("active", state.mode === "indoor");
    const inConstrMode = !dom.sidebarConstruction.hidden;
    dom.droneLayerPanel.hidden = state.mode !== "drone" || inConstrMode;
    dom.indoorLayerPanel.hidden = state.mode !== "indoor";
    AppViewer.setMode(state.mode);
    if (options.updateUrl !== false) {
      writeRouteState(state.mode, selectedUuid(state.mode), {replace: options.replaceUrl === true});
    }
    renderProjectList(currentProjects());
    const selected = currentProjects().find((project) => project.uuid === selectedUuid());
    if (selected && options.syncSelection !== false) {
      void selectProject(selected, {autoFly: false});
    } else {
      syncProjectPanels();
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
  AppNotes.init(viewer);
  AppNotes.bind();

  document.getElementById("btn-screenshot").addEventListener("click", () => {
    try {
      viewer.render();
      const canvas = viewer.canvas;
      const dataUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = dataUrl;
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
      a.download = `santiye_${ts}.png`;
      a.click();
    } catch {
      AppToast.show("Ekran görüntüsü alınamadı.", { tone: "error" });
    }
  });

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
      const showCardEdit = state.mode === "drone";
      const projectUseCase = getProjectUseCase(project);

      const summaryParts = state.mode === "drone"
        ? [useCaseLabels[projectUseCase] || null, project.location || null].filter(Boolean)
        : [project.building_name || null, project.floor_label || null, project.space_label || project.location || null].filter(Boolean);

      li.innerHTML = `
        <div class="task-card-head">
          <div class="name">${escapeHtml(project.name || project.uuid.slice(0, 8))}</div>
          ${showCardEdit ? '<button type="button" class="task-card-edit">Duzenle</button>' : ""}
        </div>
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
        <button id="btn-debug-tileset">3D Debug</button>
        <button id="btn-edit-drone">Duzenle</button>
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
    document.getElementById("btn-debug-tileset").onclick = async () => {
      if (project.status_text === "COMPLETED") {
        await ensureDroneOutputs(project.uuid, false);
      }
      const debug = AppViewer.getTilesetDebugInfo(project.uuid, "drone");
      if (!debug) {
        AppToast.show("3D tileset yuklenmemis veya bulunamadi.", {tone: "error", duration: 4200});
        return;
      }
      const center = debug.centerCartographic;
      const message = center
        ? `3D merkez lon:${center.longitude.toFixed(6)} lat:${center.latitude.toFixed(6)} h:${center.height.toFixed(2)} r:${(debug.radius || 0).toFixed(2)}`
        : "3D merkez bilgisi okunamadi.";
      AppToast.show(message, {tone: "info", duration: 8000});
      AppViewer.debugProjectAlignment(project.uuid, "drone", {
        phase: "manual-button",
        projectName: project.name || null,
      });
      AppViewer.armClickLoggerOnce({
        phase: "manual-click",
        uuid: project.uuid,
        projectName: project.name || null,
      });
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

  function enterConstructionMode(project) {
    // Sol sidebar dönüşümü
    dom.sidebarDefaultContent.hidden = true;
    dom.sidebarConstruction.hidden = false;
    dom.constrSiteName.textContent = project.name || "İsimsiz Şantiye";
    dom.constrSiteMeta.innerHTML = [
      project.location     ? `<span><span class="icon icon-pin" aria-hidden="true"></span>${escapeHtml(project.location)}</span>` : "",
      project.capture_date ? `<span><span class="icon icon-calendar" aria-hidden="true"></span>${escapeHtml(project.capture_date)}</span>` : "",
    ].join("");

    const statusLabels = { COMPLETED: "Tamamlandı", RUNNING: "İşleniyor", FAILED: "Hata", QUEUED: "Kuyrukta" };
    dom.constrQuickStats.innerHTML = [
      { iconClass: "icon-camera", label: "Fotoğraf", value: project.images_count ?? "—" },
      { iconClass: "icon-bolt",   label: "Durum",    value: statusLabels[project.status_text] || project.status_text || "—" },
    ].map(s => `
      <div class="constr-stat">
        <span class="icon ${escapeHtml(s.iconClass)} constr-stat-icon" aria-hidden="true"></span>
        <div class="constr-stat-body">
          <span class="constr-stat-label">${escapeHtml(s.label)}</span>
          <span class="constr-stat-value">${escapeHtml(String(s.value))}</span>
        </div>
      </div>
    `).join("");

    // Sağ sidebar: eski paneller gizle, yeniler göster
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

  function exitConstructionMode() {
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

  function renderSiteInfoPanel(project) {
    const rows = [
      project.location     ? `<div class="site-row"><span>Konum</span><b>${escapeHtml(project.location)}</b></div>` : "",
      project.capture_date ? `<div class="site-row"><span>Çekim tarihi</span><b>${escapeHtml(project.capture_date)}</b></div>` : "",
      project.description  ? `<div class="site-row stacked"><span>Notlar</span><b>${escapeHtml(project.description)}</b></div>` : "",
    ].join("");
    dom.siteInfoContent.innerHTML = rows || `<span class="muted">Saha bilgisi girilmedi.</span>`;

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
  }

  function syncProjectPanels(project = null) {
    const isIndoor = state.mode === "indoor";
    const projectUseCase = getProjectUseCase(project);
    const isConstruction = state.mode === "drone" && projectUseCase === "construction";

    if (isConstruction && project) {
      enterConstructionMode(project);
      return;
    }

    // Şantiye olmayan durum — construction panel'lerini kapat
    if (!dom.sidebarConstruction.hidden) {
      exitConstructionMode();
    }

    dom.measurementPanel.hidden = true;

    if (dom.measurementTitle) {
      dom.measurementTitle.textContent = isIndoor ? "Indoor Ölçüm" : "Ölçüm Araçları";
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
        await AppViewer.loadTileset(tileset.url, uuid, {pipeline: "drone", forceReload: true});
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
    if (options.updateUrl !== false) {
      writeRouteState(state.mode, project.uuid, {replace: options.replaceUrl === true});
    }
    renderProjectList(currentProjects());

    if (state.mode === "drone") {
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
        const restored = await restoreSelectionForMode("drone");
        if (!restored && !state.projects.drone.length) {
          syncProjectPanels();
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
        const restored = await restoreSelectionForMode("indoor");
        if (!restored && !state.projects.indoor.length) {
          syncProjectPanels();
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
  window.addEventListener("popstate", () => {
    const route = readRouteState();
    setMode(route.mode, {updateUrl: false, syncSelection: false});
    void restoreSelectionForMode(route.mode);
  });

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

  document.getElementById("btn-back-to-projects").addEventListener("click", () => {
    exitConstructionMode();
    state.selected.drone = null;
    writeRouteState(state.mode, null);
    dom.projectDetail.textContent = "Proje seçilmedi";
    if (dom.detailTitle) dom.detailTitle.textContent = "Seçili Drone Projesi";
    renderProjectList(currentProjects());
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

  AppUpload.bind({
    getMode: () => state.mode,
    onDroneCreated: async () => {
      await refreshDroneProjects();
    },
    onDroneUpdated: async (project) => {
      state.selected.drone = project.uuid;
      await refreshDroneProjects();
    },
    onIndoorCreated: async () => {
      await refreshIndoorProjects();
    },
  });

  const initialRoute = readRouteState();
  setMode(initialRoute.mode, {updateUrl: false, syncSelection: false});
  syncProjectPanels();
  await refreshHealth();
  await Promise.all([refreshDroneProjects(), refreshIndoorProjects()]);
  if (initialRoute.projectUuid) {
    await restoreSelectionForMode(initialRoute.mode);
  } else {
    writeRouteState(state.mode, selectedUuid(state.mode), {replace: true});
  }
  setInterval(refreshHealth, 15_000);
  setInterval(() => {
    void refreshDroneProjects();
    void refreshIndoorProjects();
  }, 10_000);
})();
