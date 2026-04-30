window.AppToast = (() => {
  let root = null;

  function ensureRoot() {
    if (!root) root = document.getElementById("toast-root");
    return root;
  }

  function show(message, options = {}) {
    const host = ensureRoot();
    if (!host) return;

    const tone = options.tone || "info";
    const duration = options.duration ?? 3200;
    const toast = document.createElement("div");
    toast.className = `toast ${tone}`;
    toast.innerHTML = `<div class="toast-message">${message}</div>`;
    host.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("visible"));

    const dismiss = () => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 220);
    };

    if (duration > 0) {
      setTimeout(dismiss, duration);
    }

    toast.addEventListener("click", dismiss);
    return dismiss;
  }

  function confirm(message, options = {}) {
    const host = ensureRoot();
    if (!host) return Promise.resolve(false);

    return new Promise((resolve) => {
      const toast = document.createElement("div");
      toast.className = "toast toast-confirm visible";
      toast.innerHTML = `
        <div class="toast-message">${message}</div>
        <div class="toast-actions">
          <button type="button" class="toast-btn ghost">${options.cancelText || "Vazgec"}</button>
          <button type="button" class="toast-btn danger">${options.confirmText || "Sil"}</button>
        </div>
      `;
      host.appendChild(toast);

      const cleanup = (result) => {
        toast.classList.remove("visible");
        setTimeout(() => toast.remove(), 220);
        resolve(result);
      };

      const [cancelBtn, confirmBtn] = toast.querySelectorAll(".toast-btn");
      cancelBtn?.addEventListener("click", () => cleanup(false));
      confirmBtn?.addEventListener("click", () => cleanup(true));
    });
  }

  return { show, confirm };
})();
