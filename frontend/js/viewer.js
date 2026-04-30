/* CesiumJS viewer kurulumu + katman yönetimi. */
window.AppViewer = (() => {
  let viewer = null;
  let currentMode = "drone";
  let osmBuildings = null;

  const orthophotoLayers = new Map();     // uuid -> ImageryLayer
  const tilesets = new Map();             // key(pipeline:uuid) -> Cesium3DTileset
  const boundingSpheres = new Map();      // key(pipeline:uuid) -> BoundingSphere

  let orthoVisible = true;
  let droneTilesVisible = true;
  let indoorTilesVisible = true;
  let osmVisible = false;

  function _key(uuid, pipeline = "drone") {
    return `${pipeline}:${uuid}`;
  }

  function _applySceneMode() {
    if (!viewer) return;
    const isIndoor = currentMode === "indoor";
    viewer.scene.globe.show = !isIndoor;
    viewer.scene.skyAtmosphere.show = !isIndoor;
    if (viewer.scene.skyBox) viewer.scene.skyBox.show = !isIndoor;
    if (viewer.scene.sun) viewer.scene.sun.show = !isIndoor;
    if (viewer.scene.moon) viewer.scene.moon.show = !isIndoor;
    viewer.scene.backgroundColor = isIndoor
      ? Cesium.Color.fromCssColorString("#11161c")
      : Cesium.Color.BLACK;
  }

  function _applyVisibility() {
    for (const layer of orthophotoLayers.values()) {
      layer.show = currentMode === "drone" && orthoVisible;
    }
    for (const [key, tileset] of tilesets.entries()) {
      const pipeline = key.startsWith("indoor:") ? "indoor" : "drone";
      tileset.show = pipeline === "indoor"
        ? currentMode === "indoor" && indoorTilesVisible
        : currentMode === "drone" && droneTilesVisible;
    }
    if (osmBuildings) {
      osmBuildings.show = currentMode === "drone" && osmVisible;
    }
  }

  async function init(ionToken) {
    if (ionToken) {
      Cesium.Ion.defaultAccessToken = ionToken;
    }

    const opts = {
      timeline: false,
      animation: false,
      sceneModePicker: true,
      baseLayerPicker: true,
      geocoder: true,
      navigationHelpButton: false,
      homeButton: true,
      infoBox: false,
      selectionIndicator: false,
    };
    if (ionToken) {
      try {
        opts.terrain = Cesium.Terrain.fromWorldTerrain();
      } catch (e) {
        console.warn("Terrain yüklenemedi:", e);
      }
    }

    viewer = new Cesium.Viewer("cesiumContainer", opts);
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.skyAtmosphere.show = true;

    const turkey = Cesium.Rectangle.fromDegrees(25.5, 35.5, 45.0, 42.5);
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(35.5, 36.0, 2_200_000),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-65),
        roll: 0,
      },
    });
    setTimeout(() => {
      viewer.camera.flyTo({
        destination: turkey,
        duration: 2.5,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      });
    }, 400);

    Cesium.Camera.DEFAULT_VIEW_RECTANGLE = turkey;
    viewer.homeButton?.viewModel?.command.beforeExecute.addEventListener((e) => {
      if (currentMode === "indoor") return;
      e.cancel = true;
      viewer.camera.flyTo({destination: turkey, duration: 1.5});
    });

    _applySceneMode();
    _applyVisibility();
    return viewer;
  }

  function getViewer() {
    return viewer;
  }

  async function loadOrthophoto(source, uuid) {
    if (!viewer) throw new Error("Viewer henüz init edilmedi");
    removeOrthophoto(uuid);

    const url = typeof source === "string" ? source : source?.url;
    const previewUrl = typeof source === "object" ? source?.preview_url : null;
    const bbox = typeof source === "object" ? source?.bbox : null;
    if (!url) throw new Error("Ortofoto URL bulunamadi");

    const tmsUrl = url.replace(/orthophoto\.tif$/, "orthophoto_tiles");
    let provider = null;
    try {
      const head = await fetch(`${tmsUrl}/tilemapresource.xml`, {method: "HEAD"});
      if (head.ok) {
        provider = await Cesium.TileMapServiceImageryProvider.fromUrl(tmsUrl);
      }
    } catch (_) {
      /* yoksay */
    }

    if (!provider && previewUrl && Array.isArray(bbox) && bbox.length === 4) {
      const rectangle = Cesium.Rectangle.fromDegrees(...bbox.map(Number));
      provider = await Cesium.SingleTileImageryProvider.fromUrl(previewUrl, {rectangle});
    }

    if (!provider) {
      console.warn("Ortofoto preview bulunamadi:", url);
      return null;
    }

    const layer = viewer.imageryLayers.addImageryProvider(provider);
    orthophotoLayers.set(uuid, layer);
    if (provider.rectangle) {
      boundingSpheres.set(_key(uuid, "drone"), Cesium.BoundingSphere.fromRectangle3D(provider.rectangle));
    }
    _applyVisibility();
    return layer;
  }

  function removeOrthophoto(uuid) {
    const layer = orthophotoLayers.get(uuid);
    if (!layer || !viewer) return;
    viewer.imageryLayers.remove(layer, true);
    orthophotoLayers.delete(uuid);
  }

  function setOrthoOpacity(value) {
    for (const layer of orthophotoLayers.values()) {
      layer.alpha = Number(value);
    }
  }

  function setOrthoVisibility(on) {
    orthoVisible = !!on;
    _applyVisibility();
  }

  async function loadTileset(url, uuid, options = {}) {
    if (!viewer) throw new Error("Viewer henüz init edilmedi");
    const pipeline = options.pipeline || "drone";
    removeTileset(uuid, pipeline);

    const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
      maximumScreenSpaceError: pipeline === "indoor" ? 8 : 16,
    });
    viewer.scene.primitives.add(tileset);
    tilesets.set(_key(uuid, pipeline), tileset);
    boundingSpheres.set(_key(uuid, pipeline), tileset.boundingSphere);
    _applyVisibility();
    return tileset;
  }

  function removeTileset(uuid, pipeline = "drone") {
    if (!viewer) return;
    const key = _key(uuid, pipeline);
    const tileset = tilesets.get(key);
    if (!tileset) return;
    viewer.scene.primitives.remove(tileset);
    tilesets.delete(key);
    boundingSpheres.delete(key);
  }

  function setDroneTilesetVisibility(on) {
    droneTilesVisible = !!on;
    _applyVisibility();
  }

  function setIndoorTilesetVisibility(on) {
    indoorTilesVisible = !!on;
    _applyVisibility();
  }

  async function toggleOsmBuildings(on) {
    osmVisible = !!on;
    if (!viewer) return;
    if (on && !osmBuildings) {
      try {
        osmBuildings = await Cesium.createOsmBuildingsAsync();
        viewer.scene.primitives.add(osmBuildings);
      } catch (e) {
        console.warn("OSM buildings yüklenemedi (Cesium ion token gerekir):", e);
      }
    }
    _applyVisibility();
  }

  function setProjectBounds(uuid, bbox, pipeline = "drone") {
    if (!viewer || !Array.isArray(bbox) || bbox.length !== 4) return;
    const [west, south, east, north] = bbox.map(Number);
    if ([west, south, east, north].some(Number.isNaN)) return;
    const rectangle = Cesium.Rectangle.fromDegrees(west, south, east, north);
    boundingSpheres.set(_key(uuid, pipeline), Cesium.BoundingSphere.fromRectangle3D(rectangle));
  }

  function flyTo(uuid, pipeline = currentMode) {
    if (!viewer) return false;
    const sphere = boundingSpheres.get(_key(uuid, pipeline));
    if (sphere) {
      viewer.camera.flyToBoundingSphere(sphere, {duration: 1.5});
      return true;
    }
    const tileset = tilesets.get(_key(uuid, pipeline));
    if (tileset) {
      viewer.flyTo(tileset, {duration: 1.5});
      return true;
    }
    return false;
  }

  function setMode(mode) {
    currentMode = mode === "indoor" ? "indoor" : "drone";
    _applySceneMode();
    _applyVisibility();
  }

  return {
    init,
    getViewer,
    loadOrthophoto,
    removeOrthophoto,
    setOrthoOpacity,
    setOrthoVisibility,
    loadTileset,
    removeTileset,
    setDroneTilesetVisibility,
    setIndoorTilesetVisibility,
    toggleOsmBuildings,
    setProjectBounds,
    flyTo,
    setMode,
  };
})();
