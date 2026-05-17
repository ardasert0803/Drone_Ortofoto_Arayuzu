window.AppUpload = (() => {
  const controllers = {};

  function bind(callbacks) {
    const onDroneCreated = callbacks?.onDroneCreated || (() => {});
    const onDroneUpdated = callbacks?.onDroneUpdated || (() => {});
    const launcher = document.getElementById("btn-new-project");
    const droneModal = createModalConfig({
      mode: "drone",
      modalId: "modal-upload",
      formId: "upload-form",
      statusId: "upload-status",
      filesInputId: "project-images",
      folderInputId: "project-image-folder",
      summaryId: "upload-file-summary",
      minFiles: 5,
      createRequest: API.createProject,
      updateRequest: API.updateProject,
      onCreated: onDroneCreated,
      onUpdated: onDroneUpdated,
      requiredNameMessage: "Proje adi zorunlu.",
      fileMessage: "En az 5 fotograf secmelisin.",
    });

    controllers.drone = droneModal;
    bindModal(droneModal);

    launcher.addEventListener("click", () => {
      droneModal.openModal();
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
    const inlineUseCaseButtons = Array.from((formContent || form).querySelectorAll("#project-type-inline-switch [data-project-use-case]"));
    const modalTitle = options.mode === "drone" ? document.getElementById("drone-modal-title") : null;
    const submitButton = options.mode === "drone" ? document.getElementById("drone-submit-button") : null;
    const editNote = options.mode === "drone" ? document.getElementById("project-edit-note") : null;
    const uploadSection = options.mode === "drone" ? document.getElementById("drone-upload-section") : null;
    const inlineSwitch = options.mode === "drone" ? document.getElementById("project-type-inline-switch") : null;
    let selectedSource = "files";
    let formMode = "create";
    let editingUuid = null;

    function getSelectedFiles() {
      return selectedSource === "folder" ? folderInput.files : filesInput.files;
    }

    function setMode(mode, project = null) {
      formMode = mode === "edit" ? "edit" : "create";
      editingUuid = formMode === "edit" ? project?.uuid || null : null;
      if (modalTitle) {
        modalTitle.textContent = formMode === "edit" ? "Projeyi Duzenle" : "Yeni Proje";
      }
      if (submitButton) {
        submitButton.textContent = formMode === "edit" ? "Kaydet" : "Gonder";
      }
      if (editNote) {
        editNote.hidden = formMode !== "edit";
      }
      if (uploadSection) {
        uploadSection.hidden = formMode === "edit";
      }
      if (inlineSwitch) {
        inlineSwitch.hidden = formMode !== "edit";
      }
    }

    function fillForm(project) {
      if (!project) return;
      Array.from(form.elements).forEach((element) => {
        if (!element?.name || element.type === "file") return;
        element.value = project[element.name] ?? "";
      });
      if (useCaseSelect && !useCaseSelect.value) {
        useCaseSelect.value = project.use_case || "construction";
      }
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
      setMode("create");
      resetProjectFlow();
      syncMuseumFields();
      refreshSummary();
      modal.classList.remove("hidden");
      if (!typeGate || !formContent) {
        form.querySelector("input[name=name]")?.focus();
      }
    }

    function openEditModal(project) {
      form.reset();
      selectedSource = "files";
      status.textContent = "";
      status.className = "status";
      setMode("edit", project);
      fillForm(project);
      if (typeGate) typeGate.hidden = true;
      if (formContent) formContent.hidden = false;
      syncMuseumFields();
      syncUseCaseButtons();
      syncSelectedTypeLabel();
      refreshSummary();
      modal.classList.remove("hidden");
      form.querySelector("input[name=name]")?.focus();
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
      if (!useCaseSelect) return;
      [...useCaseButtons, ...inlineUseCaseButtons].forEach((button) => {
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
      inlineUseCaseButtons,
      getSelectedFiles,
      refreshSummary,
      closeModal,
      openModal,
      openEditModal,
      syncMuseumFields,
      syncUseCaseButtons,
      syncSelectedTypeLabel,
      revealProjectForm,
      resetProjectFlow,
      setMode,
      getFormMode() {
        return formMode;
      },
      getEditingUuid() {
        return editingUuid;
      },
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

    [...(config.useCaseButtons || []), ...(config.inlineUseCaseButtons || [])].forEach((button) => {
      button.addEventListener("click", () => {
        if (config.getFormMode?.() === "edit") {
          if (config.useCaseSelect) {
            config.useCaseSelect.value = button.dataset.projectUseCase;
          }
          config.syncMuseumFields?.();
          config.syncUseCaseButtons?.();
          config.syncSelectedTypeLabel?.();
          return;
        }
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
      const name = config.form.elements.name.value.trim();
      if (!name) {
        config.status.textContent = config.requiredNameMessage;
        config.status.className = "status error";
        AppToast?.show(config.requiredNameMessage, {tone: "error"});
        config.form.querySelector("input[name=name]")?.focus();
        return;
      }

      const formMode = config.getFormMode?.() || "create";
      const payload = {};
      Array.from(config.form.elements).forEach((element) => {
        if (!element?.name || element.type === "file" || element.disabled) return;
        payload[element.name] = typeof element.value === "string" ? element.value.trim() : element.value;
      });

      let requestBody = payload;
      if (formMode !== "edit") {
        const selectedFiles = config.getSelectedFiles();
        if (!selectedFiles || selectedFiles.length < config.minFiles) {
          config.status.textContent = config.fileMessage;
          config.status.className = "status error";
          AppToast?.show(config.fileMessage, {tone: "error"});
          return;
        }
        requestBody = new FormData();
        Object.entries(payload).forEach(([key, value]) => {
          if (value) requestBody.append(key, value);
        });
        for (const file of selectedFiles) {
          requestBody.append("images", file, file.name);
        }
        config.status.textContent = `${selectedFiles.length} fotograf gonderiliyor...`;
      } else {
        config.status.textContent = "Proje bilgileri kaydediliyor...";
      }
      config.status.className = "status";

      try {
        const result = formMode === "edit"
          ? await config.updateRequest(config.getEditingUuid(), requestBody)
          : await config.createRequest(requestBody);
        config.status.textContent = formMode === "edit"
          ? "Proje guncellendi."
          : `Gorev olusturuldu: ${result.uuid}`;
        config.status.className = "status ok";
        AppToast?.show(formMode === "edit" ? "Proje guncellendi." : "Gorev olusturuldu.", {tone: "success"});
        setTimeout(() => config.closeModal(), 800);
        if (formMode === "edit") {
          config.onUpdated?.(result);
        } else {
          config.onCreated(result);
        }
      } catch (error) {
        config.status.textContent = `Hata: ${error.message}`;
        config.status.className = "status error";
        AppToast?.show(`Hata: ${error.message}`, {tone: "error", duration: 4200});
      }
    });
  }

  function openDroneEditor(project) {
    controllers.drone?.openEditModal(project);
  }

  return {bind, openDroneEditor};
})();
