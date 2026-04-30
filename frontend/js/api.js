/* Backend REST API'sine ince bir wrapper.
 * Tüm uçlar fastapi tarafında /api/* altında. */
window.API = (() => {
  const base = "";

  async function jget(url) {
    const r = await fetch(base + url);
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }

  async function jpost(url, body) {
    const r = await fetch(base + url, {
      method: "POST",
      headers: body instanceof FormData ? {} : {"Content-Type": "application/json"},
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }

  async function jdel(url) {
    const r = await fetch(base + url, {method: "DELETE"});
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }

  return {
    health:      ()         => jget("/api/health"),
    config:      ()         => jget("/api/config"),
    listTasks:   ()         => jget("/api/tasks"),
    getTask:     (uuid)     => jget(`/api/tasks/${uuid}`),
    createTask:  (formData) => jpost("/api/tasks", formData),
    deleteTask:  (uuid)     => jdel(`/api/tasks/${uuid}`),
    fetchAssets: (uuid)     => jpost(`/api/tasks/${uuid}/fetch`),
    listProjects:      ()         => jget("/api/tasks"),
    getProject:        (uuid)     => jget(`/api/tasks/${uuid}`),
    createProject:     (formData) => jpost("/api/tasks", formData),
    deleteProject:     (uuid)     => jdel(`/api/tasks/${uuid}`),
    fetchProjectAssets:(uuid)     => jpost(`/api/tasks/${uuid}/fetch`),
    orthoUrl:    (uuid)     => jget(`/api/tasks/${uuid}/orthophoto/url`),
    tilesetUrl:  (uuid)     => jget(`/api/tasks/${uuid}/tileset/url`),
    projectBounds:(uuid)    => jget(`/api/tasks/${uuid}/bounds`),
  };
})();
