/* Drone ve indoor upload modallari. */
window.AppUpload = (() => {
  function bind(callbacks) {
    const getMode = callbacks?.getMode || (() => "drone");
    const onDroneCreated = callbacks?.onDroneCreated || (() => {});
    const onIndoorCreated = callbacks?.onIndoorCreated || (() => {});
    const launcher = document.getElementById("btn-new-project");

    const modalConfigs = {
      drone: createModalConfig({
        mode: "drone",
        modalId: "modal-upload",
        formId: "upload-form",
        statusId: "upload-status",
        filesInputId: "project-images",
        folderInputId: "project-image-folder",
        summaryId: "upload-file-summary",
        minFiles: 5,
        createRequest: API.createProject,
        onCreated: onDroneCreated,
        requiredNameMessage: "Proje adi zorunlu.",
        fileMessage: "En az 5 fotograf secmelisin.",
      }),
      indoor: createModalConfig({
        mode: "indoor",
        modalId: "modal-upload-indoor",
        formId: "indoor-upload-form",
        statusId: "indoor-upload-status",
        filesInputId: "indoor-images",
        folderInputId: "indoor-image-folder",
        summaryId: "indoor-upload-file-summary",
        minFiles: 15,
        createRequest: API.createIndoorProject,
        onCreated: onIndoorCreated,
        requiredNameMessage: "Indoor proje adi zorunlu.",
        fileMessage: "Indoor is akisi icin en az 15 fotograf secmelisin.",
      }),
    };

    Object.values(modalConfigs).forEach(bindModal);

    launcher.addEventListener("click", () => {
      const mode = getMode() === "indoor" ? "indoor" : "drone";
      modalConfigs[mode].openModal();
    });
  }

  function createModalConfig(options) {
    const modal = document.getElementById(options.modalId);
    const form = document.getElementById(options.formId);
    const status = document.getElementById(options.statusId);
    const filesInput = document.getElementById(options.filesInputId);
    const folderInput = document.getElementById(options.folderInputId);
    const summary = document.getElementById(options.summaryId);
    const useCaseSelect = form.querySelector("select[name=use_case]");
    const museumFields = form.querySelector("#museum-fields");
    const typeGate = form.querySelector("#project-type-gate");
    const formContent = form.querySelector("#project-form-content");
    const selectedTypeLabel = form.querySelector("#selected-project-type-label");
    const useCaseButtons = Array.from((typeGate || form).querySelectorAll("[data-project-use-case]"));
    let selectedSource = "files";

    function getSelectedFiles() {
      return selectedSource === "folder" ? folderInput.files : filesInput.files;
    }

    function refreshSummary() {
      const files = getSelectedFiles();
      if (!files || !files.length) {
        summary.textContent = "Henuz dosya veya klasor secilmedi";
        return;
      }

      const names = Array.from(files).slice(0, 3).map((file) => file.webkitRelativePath || file.name);
      const suffix = files.length > 3 ? ` +${files.length - 3} dosya` : "";
      const sourceLabel = selectedSource === "folder" ? "klasorden" : "dosya seciminden";
      summary.textContent = `${files.length} dosya ${sourceLabel} algilandi: ${names.join(", ")}${suffix}`;
    }

    function closeModal() {
      modal.classList.add("hidden");
    }

    function openModal() {
      form.reset();
      selectedSource = "files";
      status.textContent = "";
      status.className = "status";
      resetProjectFlow();
      syncMuseumFields();
      refreshSummary();
      modal.classList.remove("hidden");
      if (!typeGate || !formContent) {
        form.querySelector("input[name=name]")?.focus();
      }
    }

    function syncMuseumFields() {
      if (!museumFields || !useCaseSelect) return;
      const isMuseum = useCaseSelect.value === "museum";
      museumFields.hidden = !isMuseum;
      museumFields.querySelectorAll("input, textarea, select").forEach((field) => {
        field.disabled = !isMuseum;
      });
    }

    function syncUseCaseButtons() {
      if (!useCaseButtons.length || !useCaseSelect) return;
      useCaseButtons.forEach((button) => {
        button.classList.toggle("active", button.dataset.projectUseCase === useCaseSelect.value);
      });
    }

    function syncSelectedTypeLabel() {
      if (!selectedTypeLabel || !useCaseSelect) return;
      const selectedOption = useCaseSelect.selectedOptions?.[0];
      selectedTypeLabel.textContent = (selectedOption?.textContent || useCaseSelect.value || "Proje").trim();
    }

    function revealProjectForm(nextUseCase) {
      const shouldFocusName = Boolean(typeGate && !typeGate.hidden);
      if (useCaseSelect && nextUseCase) {
        useCaseSelect.value = nextUseCase;
      }
      if (typeGate) typeGate.hidden = true;
      if (formContent) formContent.hidden = false;
      syncMuseumFields();
      syncUseCaseButtons();
      syncSelectedTypeLabel();
      if (shouldFocusName) {
        form.querySelector("input[name=name]")?.focus();
      }
    }

    function resetProjectFlow() {
      if (useCaseSelect) {
        useCaseSelect.value = "construction";
      }
      if (typeGate) typeGate.hidden = false;
      if (formContent) formContent.hidden = true;
      syncUseCaseButtons();
      syncSelectedTypeLabel();
    }

    return {
      ...options,
      modal,
      form,
      status,
      filesInput,
      folderInput,
      summary,
      useCaseSelect,
      museumFields,
      typeGate,
      formContent,
      selectedTypeLabel,
      useCaseButtons,
      getSelectedFiles,
      refreshSummary,
      closeModal,
      openModal,
      syncMuseumFields,
      syncUseCaseButtons,
      syncSelectedTypeLabel,
      revealProjectForm,
      resetProjectFlow,
      useFiles() {
        selectedSource = "files";
      },
      useFolder() {
        selectedSource = "folder";
      },
    };
  }

  function bindModal(config) {
    config.useCaseSelect?.addEventListener("change", () => {
      config.syncMuseumFields?.();
      config.syncUseCaseButtons?.();
      config.syncSelectedTypeLabel?.();
    });

    config.useCaseButtons?.forEach((button) => {
      button.addEventListener("click", () => {
        config.revealProjectForm?.(button.dataset.projectUseCase);
      });
    });

    config.modal.addEventListener("click", (event) => {
      if (event.target === config.modal) config.closeModal();
    });

    config.modal.querySelectorAll("[data-close-modal]").forEach((element) => {
      element.addEventListener("click", () => config.closeModal());
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !config.modal.classList.contains("hidden")) {
        config.closeModal();
      }
    });

    config.filesInput.addEventListener("change", () => {
      config.folderInput.value = "";
      config.useFiles();
      config.folderInput.value = "";
      config.refreshSummary();
      AppToast?.show("Dosya secimi guncellendi.", {tone: "info", duration: 1800});
    });

    config.folderInput.addEventListener("change", () => {
      config.filesInput.value = "";
      config.useFolder();
      config.refreshSummary();
      if (config.folderInput.files?.length) {
        AppToast?.show(`${config.folderInput.files.length} dosya klasorden algilandi.`, {
          tone: "success",
          duration: 2200,
        });
      }
    });

    config.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData();
      const name = config.form.elements.name.value.trim();
      if (!name) {
        config.status.textContent = config.requiredNameMessage;
        config.status.className = "status error";
        AppToast?.show(config.requiredNameMessage, {tone: "error"});
        config.form.querySelector("input[name=name]")?.focus();
        return;
      }

      const selectedFiles = config.getSelectedFiles();
      if (!selectedFiles || selectedFiles.length < config.minFiles) {
        config.status.textContent = config.fileMessage;
        config.status.className = "status error";
        AppToast?.show(config.fileMessage, {tone: "error"});
        return;
      }

      Array.from(config.form.elements).forEach((element) => {
        if (!element?.name || element.type === "file" || element.disabled) return;
        const value = typeof element.value === "string" ? element.value.trim() : element.value;
        if (value) formData.append(element.name, value);
      });
      for (const file of selectedFiles) {
        formData.append("images", file, file.name);
      }

      config.status.textContent = `${selectedFiles.length} fotograf gonderiliyor...`;
      config.status.className = "status";

      try {
        const result = await config.createRequest(formData);
        config.status.textContent = `Gorev olusturuldu: ${result.uuid}`;
        config.status.className = "status ok";
        AppToast?.show("Gorev olusturuldu.", {tone: "success"});
        setTimeout(() => config.closeModal(), 800);
        config.onCreated(result);
      } catch (error) {
        config.status.textContent = `Hata: ${error.message}`;
        config.status.className = "status error";
        AppToast?.show(`Hata: ${error.message}`, {tone: "error", duration: 4200});
      }
    });
  }

  return {bind};
})();
