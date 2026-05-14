/* Backend REST API'sine ince bir wrapper.
 * Tüm uçlar fastapi tarafında /api/* altında. */
window.API = (() => {
  const base = "";

  async function jget(url) {
    const r = await fetch(base + url);
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }

  async function tget(url) {
    const r = await fetch(base + url);
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.text();
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

  async function jput(url, body) {
    const r = await fetch(base + url, {
      method: "PUT",
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
    listTasks:   ()         => jget("/api/tasks"),
    getTask:     (uuid)     => jget(`/api/tasks/${uuid}`),
    createTask:  (formData) => jpost("/api/tasks", formData),
    updateTask:  (uuid, body) => jput(`/api/tasks/${uuid}`, body),
    deleteTask:  (uuid)     => jdel(`/api/tasks/${uuid}`),
    fetchAssets: (uuid)     => jpost(`/api/tasks/${uuid}/fetch`),
    listProjects:      ()         => jget("/api/tasks"),
    getProject:        (uuid)     => jget(`/api/tasks/${uuid}`),
    createProject:     (formData) => jpost("/api/tasks", formData),
    updateProject:     (uuid, body) => jput(`/api/tasks/${uuid}`, body),
    deleteProject:     (uuid)     => jdel(`/api/tasks/${uuid}`),
    fetchProjectAssets:(uuid)     => jpost(`/api/tasks/${uuid}/fetch`),
    orthoUrl:    (uuid)     => jget(`/api/tasks/${uuid}/orthophoto/url`),
    tilesetUrl:  (uuid)     => jget(`/api/tasks/${uuid}/tileset/url`),
    projectBounds:(uuid)    => jget(`/api/tasks/${uuid}/bounds`),
    listIndoorProjects:   ()         => jget("/api/indoor/tasks"),
    getIndoorProject:     (uuid)     => jget(`/api/indoor/tasks/${uuid}`),
    createIndoorProject:  (formData) => jpost("/api/indoor/tasks", formData),
    deleteIndoorProject:  (uuid)     => jdel(`/api/indoor/tasks/${uuid}`),
    indoorTilesetUrl:     (uuid)     => jget(`/api/indoor/tasks/${uuid}/tileset/url`),
    indoorLog:            (uuid)     => tget(`/api/indoor/tasks/${uuid}/log`),
    indoorLogUrl:         (uuid)     => `/api/indoor/tasks/${uuid}/log`,
  };
})();
