/* Yeni proje (foto upload) modali. */
window.AppUpload = (() => {
  let onCreated = null;

  function bind(callbacks) {
    onCreated = callbacks?.onCreated || (() => {});
    const modal = document.getElementById("modal-upload");
    const form  = document.getElementById("upload-form");
    const status = document.getElementById("upload-status");
    const nameInput = form.elements["name"];
    const filesInput = document.getElementById("project-images");
    const folderInput = document.getElementById("project-image-folder");
    const fileSummary = document.getElementById("upload-file-summary");
    let selectedSource = "files";

    function getSelectedFiles() {
      const source = selectedSource === "folder" ? folderInput : filesInput;
      return source.files;
    }

    function refreshFileSummary() {
      const files = getSelectedFiles();
      if (!files || !files.length) {
        fileSummary.textContent = "Henuz dosya veya klasor secilmedi";
        return;
      }

      const names = Array.from(files).slice(0, 3).map((file) =>
        file.webkitRelativePath || file.name
      );
      const suffix = files.length > 3 ? ` +${files.length - 3} dosya` : "";
      const sourceLabel = selectedSource === "folder" ? "klasorden" : "dosya seciminden";
      fileSummary.textContent = `${files.length} dosya ${sourceLabel} algilandi: ${names.join(", ")}${suffix}`;
    }

    function closeModal() {
      modal.classList.add("hidden");
    }

    function openModal() {
      form.reset();
      selectedSource = "files";
      modal.classList.remove("hidden");
      status.textContent = "";
      status.className = "status";
      refreshFileSummary();
      nameInput?.focus();
    }

    document.getElementById("btn-new-project").addEventListener("click", () => {
      openModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) {
        closeModal();
      }
    });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });

    modal.querySelectorAll("[data-close-modal]").forEach(el => {
      el.addEventListener("click", () => closeModal());
    });

    filesInput.addEventListener("change", () => {
      folderInput.value = "";
      selectedSource = "files";
      refreshFileSummary();
      AppToast?.show("Dosya secimi guncellendi.", {tone: "info", duration: 1800});
    });
    folderInput.addEventListener("change", () => {
      filesInput.value = "";
      selectedSource = "folder";
      refreshFileSummary();
      if (folderInput.files?.length) {
        AppToast?.show(`${folderInput.files.length} dosya klasorden algilandi.`, {
          tone: "success",
          duration: 2200,
        });
      }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData();
      const name = form.elements["name"].value.trim();
      const useCase = form.elements["use_case"].value;
      const dataSource = form.elements["data_source"].value;
      const location = form.elements["location"].value.trim();
      const captureDate = form.elements["capture_date"].value;
      const description = form.elements["description"].value.trim();

      if (!name) {
        status.textContent = "Proje adı zorunlu";
        status.className = "status error";
        AppToast?.show("Proje adi zorunlu.", {tone: "error"});
        nameInput?.focus();
        return;
      }

      fd.append("name", name);
      fd.append("use_case", useCase);
      fd.append("data_source", dataSource);
      if (location) fd.append("location", location);
      if (captureDate) fd.append("capture_date", captureDate);
      if (description) fd.append("description", description);
      const selectedFiles = getSelectedFiles();
      if (!selectedFiles || selectedFiles.length < 5) {
        status.textContent = "En az 5 fotoğraf seç";
        status.className = "status error";
        AppToast?.show("En az 5 fotograf secmelisin.", {tone: "error"});
        return;
      }
      for (const f of selectedFiles) fd.append("images", f, f.name);

      status.textContent = `${selectedFiles.length} fotoğraf gönderiliyor…`;
      status.className = "status";

      try {
        const res = await API.createProject(fd);
        status.textContent = `Proje oluşturuldu: ${res.uuid}`;
        status.className = "status ok";
        AppToast?.show("Proje olusturuldu.", {tone: "success"});
        setTimeout(() => closeModal(), 800);
        onCreated(res);
      } catch (err) {
        status.textContent = "Hata: " + err.message;
        status.className = "status error";
        AppToast?.show(`Hata: ${err.message}`, {tone: "error", duration: 4200});
      }
    });
  }

  return { bind };
})();
