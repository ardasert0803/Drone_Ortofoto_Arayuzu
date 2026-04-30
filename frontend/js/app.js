/* Ana uygulama orkestrasyonu. */
(async () => {
  const useCaseLabels = {
    construction: "Santiye",
    heritage: "Kulturel Miras",
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
      brandSubtitle: "Drone · Ortofoto · 3D Tile",
      caption: "<strong>Drone Tabanli Ortofoto</strong> · Turkiye merkezli yerel sanal ikiz platformu",
      empty: "Henuz drone projesi yok",
    },
    indoor: {
      heading: "Indoor Projeler",
      button: "+ Yeni Indoor Projesi",
      detailTitle: "Secili Indoor Proje",
      brandSubtitle: "Indoor · Telefon Fotogrametri · 3D Tiles",
      caption: "<strong>Indoor Fotogrametri</strong> · Telefon foto setlerinden yerel 3D mekansal model uretimi",
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
    modeCaption: document.getElementById("mode-caption"),
    brandSubtitle: document.getElementById("brand-subtitle"),
    projectHeading: document.getElementById("project-heading"),
    detailTitle: document.getElementById("detail-title"),
    newProjectButton: document.getElementById("btn-new-project"),
    modeDroneButton: document.getElementById("btn-mode-drone"),
    modeIndoorButton: document.getElementById("btn-mode-indoor"),
    droneLayerPanel: document.getElementById("panel-layers-drone"),
    indoorLayerPanel: document.getElementById("panel-layers-indoor"),
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
    dom.modeCaption.innerHTML = meta.caption;
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
      <div class="actions">
        <button id="btn-fetch">Ciktilari indir</button>
        <button id="btn-fly">Buraya uc</button>
        <button id="btn-delete-drone" class="danger">Sil</button>
      </div>
    `;

    document.getElementById("btn-fetch").onclick = () => {
      void fetchAndLoadDroneProject(project.uuid);
    };
    document.getElementById("btn-fly").onclick = () => AppViewer.flyTo(project.uuid, "drone");
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

  async function fetchAndLoadDroneProject(uuid) {
    if (state.fetchingDroneOutputs.has(uuid)) return;
    state.fetchingDroneOutputs.add(uuid);
    try {
      await API.fetchProjectAssets(uuid);
      await hydrateDroneBounds(uuid);
      await tryLoadDroneOutputs(uuid, true);
      AppToast.show("Drone ciktilari indirildi.", {tone: "success"});
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
      renderDroneDetail(project);
      const hasBounds = await hydrateDroneBounds(project.uuid);
      if (project.status_text === "COMPLETED") {
        await ensureDroneOutputs(project.uuid, options.autoFly !== false);
      } else if (hasBounds && options.autoFly !== false) {
        AppViewer.flyTo(project.uuid, "drone");
      }
      return;
    }

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
  await refreshHealth();
  await Promise.all([refreshDroneProjects(), refreshIndoorProjects()]);
  setInterval(refreshHealth, 15_000);
  setInterval(() => {
    void refreshDroneProjects();
    void refreshIndoorProjects();
  }, 10_000);
})();
