/* Ana uygulama orkestrasyonu — sayfa açıldığında tüm parçaları bağlar. */
(async () => {
  const useCaseLabels = {
    construction: "Şantiye",
    heritage: "Kültürel Miras",
    generic: "Genel",
  };
  const dataSourceLabels = {
    drone: "Drone",
    phone: "Telefon",
    open_source: "Açık Kaynak",
  };
  const fetchingOutputs = new Set();

  // 1) Backend'den config çek (cesium token vs.)
  let config = {cesium_ion_token: ""};
  try {
    config = await API.config();
  } catch (e) {
    console.warn("Backend /api/config çekilemedi:", e);
  }

  // 2) Cesium viewer'ı kur
  const viewer = await AppViewer.init(config.cesium_ion_token);
  AppMeasure.init(viewer);
  AppMeasure.bind();

  // 3) Health bar
  const healthBar = document.getElementById("health-bar");
  const healthText = document.getElementById("health-text");
  async function refreshHealth() {
    try {
      const h = await API.health();
      if (h.nodeodm) {
        healthBar.className = "health ok";
        const v = h.nodeodm_info?.version || "?";
        healthText.textContent = `NodeODM bağlı (v${v})`;
      } else {
        healthBar.className = "health bad";
        healthText.textContent = "NodeODM erişilemez — docker container çalışıyor mu?";
      }
    } catch {
      healthBar.className = "health bad";
      healthText.textContent = "Backend yanıt vermedi";
    }
  }
  refreshHealth();
  setInterval(refreshHealth, 15_000);

  // 4) Proje listesi
  const projectListEl = document.getElementById("task-list");
  const projectDetailEl = document.getElementById("task-detail");
  let selectedProjectUuid = null;

  async function hydrateProjectBounds(uuid) {
    try {
      const {bbox} = await API.projectBounds(uuid);
      AppViewer.setProjectBounds(uuid, bbox);
      return true;
    } catch {
      return false;
    }
  }

  function renderProjectList(projects) {
    if (!projects.length) {
      projectListEl.innerHTML = '<li class="empty">Henüz proje yok</li>';
      return;
    }
    projectListEl.innerHTML = "";
    for (const project of projects) {
      const li = document.createElement("li");
      li.dataset.uuid = project.uuid;
      if (project.uuid === selectedProjectUuid) li.classList.add("active");
      const createdAt = project.date_created
        ? new Date(project.date_created).toLocaleString("tr-TR")
        : "—";
      const summaryParts = [
        useCaseLabels[project.use_case] || null,
        project.location || null,
      ].filter(Boolean);
      li.innerHTML = `
        <div class="name">${project.name || project.uuid.slice(0, 8)}</div>
        ${summaryParts.length ? `<div class="submeta">${summaryParts.join(" · ")}</div>` : ""}
        <div class="meta">
          <span>${createdAt}</span>
          <span class="status-pill ${project.status_text || ''}">${project.status_text || '?'}</span>
        </div>
      `;
      li.addEventListener("click", () => selectProject(project));
      projectListEl.appendChild(li);
    }
  }

  async function refreshProjects() {
    try {
      const projects = await API.listProjects();
      renderProjectList(projects);
    } catch (e) {
      projectListEl.innerHTML = `<li class="empty">Hata: ${e.message}</li>`;
    }
  }
  refreshProjects();
  setInterval(refreshProjects, 10_000);

  // 5) Proje seçilince detayları göster + çıktıları yükle
  async function selectProject(project) {
    selectedProjectUuid = project.uuid;
    document.querySelectorAll("#task-list li").forEach(li => {
      li.classList.toggle("active", li.dataset.uuid === project.uuid);
    });

    if (projectDetailEl) {
      const metadataRows = [
        project.use_case ? `<div class="row"><span>Proje tipi</span><b>${useCaseLabels[project.use_case] || project.use_case}</b></div>` : "",
        project.data_source ? `<div class="row"><span>Veri kaynağı</span><b>${dataSourceLabels[project.data_source] || project.data_source}</b></div>` : "",
        project.location ? `<div class="row"><span>Konum</span><b>${project.location}</b></div>` : "",
        project.capture_date ? `<div class="row"><span>Çekim tarihi</span><b>${project.capture_date}</b></div>` : "",
        project.description ? `<div class="row"><span>Açıklama</span><b>${project.description}</b></div>` : "",
      ].join("");
      projectDetailEl.innerHTML = `
      <div class="row"><span>UUID</span><b>${project.uuid.slice(0, 12)}…</b></div>
      <div class="row"><span>Durum</span><b>${project.status_text || '?'}</b></div>
      <div class="row"><span>Foto</span><b>${project.images_count ?? '—'}</b></div>
      <div class="row"><span>İlerleme</span><b>${(project.progress ?? 0).toFixed(0)}%</b></div>
      ${metadataRows}
      <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap">
        <button id="btn-fetch">Çıktıları indir</button>
        <button id="btn-fly">Buraya uç</button>
        <button id="btn-delete" class="danger">Sil</button>
      </div>
    `;

      document.getElementById("btn-fetch").onclick = () => fetchAndLoadProject(project.uuid);
      document.getElementById("btn-fly").onclick = () => AppViewer.flyTo(project.uuid);
      document.getElementById("btn-delete").onclick = async () => {
        const shouldDelete = await AppToast.confirm("Bu proje silinsin mi?", {
          confirmText: "Sil",
          cancelText: "Iptal",
        });
        if (!shouldDelete) return;
        await API.deleteProject(project.uuid);
        AppViewer.removeOrthophoto(project.uuid);
        AppViewer.removeTileset(project.uuid);
        refreshProjects();
        AppToast.show("Proje silindi.", {tone: "success"});
      };
    }

    const hasBounds = await hydrateProjectBounds(project.uuid);

    // Eğer tamamlandıysa çıktıları indirip yüklemeyi dene
    if (project.status_text === "COMPLETED") {
      await ensureProjectOutputs(project.uuid);
    }

    if (hasBounds) {
      AppViewer.flyTo(project.uuid);
    }
  }

  async function fetchAndLoadProject(uuid) {
    document.getElementById("fetch-status")?.remove();
    if (projectDetailEl) {
      projectDetailEl.insertAdjacentHTML("beforeend",
        '<div class="row" id="fetch-status"><span>İndiriliyor…</span></div>');
    }
    fetchingOutputs.add(uuid);
    try {
      await API.fetchProjectAssets(uuid);
      document.getElementById("fetch-status")?.remove();
      await hydrateProjectBounds(uuid);
      await tryLoadProjectOutputs(uuid);
      AppToast.show("Ciktilar indirildi.", {tone: "success"});
    } catch (e) {
      const el = document.getElementById("fetch-status");
      if (el) el.innerHTML = `<span style="color:var(--danger)">Hata: ${e.message}</span>`;
      AppToast.show(`Hata: ${e.message}`, {tone: "error", duration: 4200});
    } finally {
      fetchingOutputs.delete(uuid);
    }
  }

  async function ensureProjectOutputs(uuid) {
    if (fetchingOutputs.has(uuid)) return;

    let hasOrtho = true;
    let hasTiles = true;

    try {
      const o = await API.orthoUrl(uuid);
      await AppViewer.loadOrthophoto(o, uuid);
      AppViewer.flyTo(uuid);
    } catch {
      hasOrtho = false;
    }

    try {
      const t = await API.tilesetUrl(uuid);
      if (t.url) {
        await AppViewer.loadTileset(t.url, uuid);
        AppViewer.flyTo(uuid);
      } else {
        hasTiles = false;
      }
    } catch {
      hasTiles = false;
    }

    if (hasOrtho || hasTiles) return;
    await fetchAndLoadProject(uuid);
  }

  async function tryLoadProjectOutputs(uuid) {
    // Ortofoto
    try {
      const o = await API.orthoUrl(uuid);
      await AppViewer.loadOrthophoto(o, uuid);
      AppViewer.flyTo(uuid);
    } catch (e) { console.info("Ortofoto henüz yok:", e.message); }
    // 3D Tiles
    try {
      const t = await API.tilesetUrl(uuid);
      if (t.url) {
        await AppViewer.loadTileset(t.url, uuid);
        AppViewer.flyTo(uuid);
      }
    } catch (e) { console.info("3D Tiles henüz yok:", e.message); }
  }

  // 6) Katman toggle'ları
  document.getElementById("layer-orthophoto").addEventListener("change", (e) => {
    AppViewer.setOrthoVisibility(e.target.checked);
  });
  document.getElementById("layer-3dtiles").addEventListener("change", (e) => {
    AppViewer.setTilesetVisibility(e.target.checked);
  });
  document.getElementById("layer-osm-buildings").addEventListener("change", (e) => {
    AppViewer.toggleOsmBuildings(e.target.checked);
  });
  document.getElementById("opacity-orthophoto").addEventListener("input", (e) => {
    AppViewer.setOrthoOpacity(e.target.value);
  });

  // 7) Upload modali
  AppUpload.bind({
    onCreated: () => refreshProjects(),
  });
})();
