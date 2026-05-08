/* CesiumJS viewer kurulumu + katman yönetimi. */
window.AppViewer = (() => {
  let viewer = null;
  let currentMode = "drone";
  let osmBuildings = null;
  let debugClickHandler = null;
  let persistentClickLogger = null;

  const orthophotoLayers = new Map();     // uuid -> ImageryLayer
  const orthophotoMeta = new Map();       // uuid -> debug info
  const tilesets = new Map();             // key(pipeline:uuid) -> Cesium3DTileset
  const boundingSpheres = new Map();      // key(pipeline:uuid) -> BoundingSphere
  const tileDebugMeta = new Map();        // key(pipeline:uuid) -> debug info

  let orthoVisible = true;
  let droneTilesVisible = true;
  let indoorTilesVisible = true;
  let osmVisible = false;

  let _orbitHandler = null;
  let _orbitState   = null;
  let _orbitPaused  = false;

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
      geocoder: false,
      navigationHelpButton: false,
      homeButton: false,
      infoBox: false,
      selectionIndicator: false,
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
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

    Cesium.Camera.DEFAULT_VIEW_RECTANGLE = Cesium.Rectangle.fromDegrees(25.5, 35.5, 45.0, 42.5);

    // Başlangıç: globe açısı — önce anında bir noktaya otur, sonra animasyon
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(35.0, 39.0, 14_000_000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-75), roll: 0 },
    });
    setTimeout(() => flyToHome({ duration: 2.4 }), 350);

    viewer.homeButton?.viewModel?.command.beforeExecute.addEventListener((e) => {
      if (currentMode === "indoor") return;
      e.cancel = true;
      flyToHome({ duration: 1.8 });
    });

    _installPersistentClickLogger();
    _applySceneMode();
    _applyVisibility();
    return viewer;
  }

  function getViewer() {
    return viewer;
  }

  function _cartographicFromCartesian(cartesian) {
    if (!cartesian) return null;
    const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
    if (!cartographic) return null;
    return {
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      height: cartographic.height,
    };
  }

  function _rectangleToDegrees(rectangle) {
    if (!rectangle) return null;
    return {
      west: Cesium.Math.toDegrees(rectangle.west),
      south: Cesium.Math.toDegrees(rectangle.south),
      east: Cesium.Math.toDegrees(rectangle.east),
      north: Cesium.Math.toDegrees(rectangle.north),
    };
  }

  function _matrixTranslationCartographic(matrix) {
    if (!matrix) return null;
    const translation = Cesium.Matrix4.getTranslation(matrix, new Cesium.Cartesian3());
    return _cartographicFromCartesian(translation);
  }

  function _bboxEquals(left, right) {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return ["west", "south", "east", "north"].every((key) => Number(left[key]) === Number(right[key]));
  }

  function _regionToCartographics(region) {
    if (!Array.isArray(region) || region.length < 6) return [];
    const [west, south, east, north] = region.map(Number);
    if (![west, south, east, north].every(Number.isFinite)) return [];
    const lonCenter = (west + east) / 2;
    const latCenter = (south + north) / 2;
    return [
      new Cesium.Cartographic(west, south),
      new Cesium.Cartographic(west, north),
      new Cesium.Cartographic(east, south),
      new Cesium.Cartographic(east, north),
      new Cesium.Cartographic(lonCenter, latCenter),
    ];
  }

  function _sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  /**
   * Cesium.Terrain.fromWorldTerrain() async yüklenir; yüklenene kadar
   * viewer.terrainProvider EllipsoidTerrainProvider olarak kalır.
   * Bu fonksiyon gerçek terrain provider hazır olana kadar bekler.
   * Token yoksa veya timeout geçerse null döner.
   */
  function _waitForRealTerrain(timeoutMs = 15_000) {
    if (!viewer) return Promise.resolve(null);
    const current = viewer.terrainProvider;
    if (current && !(current instanceof Cesium.EllipsoidTerrainProvider)) {
      return Promise.resolve(current); // zaten hazır
    }
    if (!viewer.terrainProviderChanged) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        viewer.terrainProviderChanged.removeEventListener(onChanged);
        resolve(null); // terrain hiç gelmedi (token yok vb.)
      }, timeoutMs);

      function onChanged(newProvider) {
        if (settled) return;
        if (!(newProvider instanceof Cesium.EllipsoidTerrainProvider)) {
          settled = true;
          clearTimeout(timer);
          viewer.terrainProviderChanged.removeEventListener(onChanged);
          resolve(newProvider);
        }
      }

      viewer.terrainProviderChanged.addEventListener(onChanged);
    });
  }

  /**
   * ODM tilesetlerinde root.transform ile ECEF yerleşimi yapıldığında
   * region[4] (minHeight) LOCAL koordinatlardadır (WGS84 değil).
   * Bu durumda terrain örneği ile yanlış fark hesaplanıp model havaya kaldırılır.
   *
   * Kural: root.transform içinde büyük ECEF translation varsa (>1M m)
   * tileset zaten doğru konumda; ek offset uygulamayız.
   * Transform yoksa veya identity'ye yakınsa region heights WGS84'tür —
   * ince offset hâlâ uygulanabilir.
   */
  function _tilesetHasEcefTransform(descriptor) {
    const t = descriptor?.root?.transform;
    if (!Array.isArray(t) || t.length !== 16) return false;
    // Sütun-major 4×4: translation = [t[12], t[13], t[14]]
    return Math.hypot(t[12], t[13], t[14]) > 1_000_000; // >1000 km → ECEF konumu
  }

  async function _applyTerrainHeightOffset(tileset, descriptor, debugMeta) {
    if (!viewer || !tileset) return null;
    if (debugMeta?.terrainOffsetApplied) return debugMeta;

    // root.transform ile ECEF'e yerleştirilmiş tileset → offset gereksiz ve zararlı
    if (_tilesetHasEcefTransform(descriptor)) {
      debugMeta.terrainOffsetSkipped = "ecef-transform";
      return debugMeta;
    }

    // Terrain provider async yükleniyor — hazır değilse bekle
    const terrainProvider = await _waitForRealTerrain(15_000);
    if (!terrainProvider) return null;

    const region = Array.isArray(descriptor?.root?.boundingVolume?.region)
      ? descriptor.root.boundingVolume.region.map(Number)
      : null;
    if (!region || region.length < 6) return null;

    const positions = _regionToCartographics(region);
    if (!positions.length) return null;

    let sampled = null;
    try {
      sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, positions);
    } catch (error) {
      console.warn("[tileset] terrain sample failed", error);
      return null;
    }

    const terrainHeights = sampled
      .map((position) => position?.height)
      .filter((height) => Number.isFinite(height));
    if (!terrainHeights.length) return null;

    const modelMinHeight = Number(region[4]);
    const terrainReferenceHeight = Math.min(...terrainHeights);
    const offsetMeters = terrainReferenceHeight - modelMinHeight;

    debugMeta.terrainHeights = terrainHeights;
    debugMeta.terrainReferenceHeight = terrainReferenceHeight;
    debugMeta.modelMinHeight = modelMinHeight;
    debugMeta.terrainOffsetMeters = offsetMeters;

    // Offset yoksa veya çok büyükse (muhtemelen hatalı) uygulama
    if (!Number.isFinite(offsetMeters) || Math.abs(offsetMeters) < 0.5 || Math.abs(offsetMeters) > 80.0) {
      return debugMeta;
    }

    const lonCenter = (region[0] + region[2]) / 2;
    const latCenter = (region[1] + region[3]) / 2;
    const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(
      new Cesium.Cartographic(lonCenter, latCenter, 0.0),
      new Cesium.Cartesian3(),
    );
    const offset = Cesium.Cartesian3.multiplyByScalar(normal, offsetMeters, new Cesium.Cartesian3());
    const translation = Cesium.Matrix4.fromTranslation(offset);
    tileset.modelMatrix = Cesium.Matrix4.multiplyTransformation(
      translation,
      tileset.modelMatrix,
      new Cesium.Matrix4(),
    );
    debugMeta.terrainOffsetApplied = true;
    return debugMeta;
  }

  async function _applyTerrainHeightOffsetWithRetry(tileset, descriptor, debugMeta, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      debugMeta.terrainOffsetAttempt = attempt;
      const result = await _applyTerrainHeightOffset(tileset, descriptor, debugMeta);
      if (result?.terrainOffsetApplied) return result;
      // Yükseklik alındı ama offset aralık dışıydı — daha fazla retry'a gerek yok
      if (result?.terrainHeights?.length) return result;
      if (attempt < attempts) {
        viewer?.scene?.requestRender?.();
        await _sleep(800 * attempt); // sampleTerrainMostDetailed için tile yüklenme süresi
      }
    }
    return debugMeta;
  }

  function _primitiveBoundingSphere(primitive) {
    if (!primitive) return null;
    try {
      const sphere = primitive.boundingSphere;
      if (!sphere) return null;
      return {
        radius: sphere.radius,
        centerCartographic: _cartographicFromCartesian(sphere.center),
      };
    } catch (error) {
      console.debug("[3d-debug] primitive boundingSphere henuz hazir degil", error);
      return null;
    }
  }

  function _debugProjectAlignment(uuid, pipeline = "drone", extra = {}) {
    let debug = null;
    try {
      debug = getTilesetDebugInfo(uuid, pipeline);
    } catch (error) {
      console.warn("[3d-debug] debugProjectAlignment failed", uuid, pipeline, error);
      return null;
    }
    if (!debug) return null;
    const ortho = orthophotoMeta.get(uuid) || null;
    const payload = {
      uuid,
      pipeline,
      ortho,
      tileset: debug,
      camera: _cartographicFromCartesian(viewer?.camera?.positionWC),
      ...extra,
    };
    console.groupCollapsed(`[3d-debug] ${pipeline}:${uuid}`);
    console.log(payload);
    console.groupEnd();
    return payload;
  }

  function _debugAfterNextRender(uuid, pipeline, primitive, extra = {}) {
    if (!viewer) return;
    const callback = () => {
      viewer.scene.postRender.removeEventListener(callback);
      _debugProjectAlignment(uuid, pipeline, {
        ...extra,
        modelBoundingSphere: _primitiveBoundingSphere(primitive),
      });
    };
    viewer.scene.postRender.addEventListener(callback);
    viewer.scene.requestRender();
  }

  function _pickWorldPosition(screenPosition) {
    if (!viewer || !screenPosition) return null;
    const scene = viewer.scene;
    const ray = viewer.camera.getPickRay(screenPosition);
    const globePick = ray ? scene.globe.pick(ray, scene) : null;
    const depthPick = scene.pickPositionSupported ? scene.pickPosition(screenPosition) : null;
    return depthPick || globePick || viewer.camera.pickEllipsoid(screenPosition, scene.globe.ellipsoid);
  }

  function armClickLoggerOnce(context = {}) {
    if (!viewer) return false;
    if (debugClickHandler) {
      debugClickHandler.destroy();
      debugClickHandler = null;
    }
    debugClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    debugClickHandler.setInputAction((click) => {
      const cartesian = _pickWorldPosition(click.position);
      const cartographic = _cartographicFromCartesian(cartesian);
      console.log("[3d-click]", {
        ...context,
        screen: click.position ? {x: click.position.x, y: click.position.y} : null,
        cartographic,
      });
      debugClickHandler?.destroy();
      debugClickHandler = null;
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    console.info("[3d-click] Haritada bir noktaya tikla; koordinatlar console'a yazilacak.");
    return true;
  }

  function _installPersistentClickLogger() {
    if (!viewer) return;
    if (persistentClickLogger) {
      persistentClickLogger.destroy();
      persistentClickLogger = null;
    }
    persistentClickLogger = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    persistentClickLogger.setInputAction((click) => {
      const cartesian = _pickWorldPosition(click.position);
      const cartographic = _cartographicFromCartesian(cartesian);
      console.log("[map-click]", {
        mode: currentMode,
        screen: click.position ? {x: click.position.x, y: click.position.y} : null,
        cartographic,
      });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  async function loadOrthophoto(source, uuid, options = {}) {
    if (!viewer) throw new Error("Viewer henüz init edilmedi");
    const url = typeof source === "string" ? source : source?.url;
    const previewUrl = typeof source === "object" ? source?.preview_url : null;
    const bbox = typeof source === "object" ? source?.bbox : null;
    if (!url) throw new Error("Ortofoto URL bulunamadi");
    const nextBbox = Array.isArray(bbox) && bbox.length === 4
      ? {
          west: Number(bbox[0]),
          south: Number(bbox[1]),
          east: Number(bbox[2]),
          north: Number(bbox[3]),
        }
      : null;
    const currentLayer = orthophotoLayers.get(uuid) || null;
    const currentMeta = orthophotoMeta.get(uuid) || null;
    if (
      options.forceReload !== true
      && currentLayer
      && currentMeta
      && currentMeta.url === url
      && currentMeta.previewUrl === previewUrl
      && _bboxEquals(currentMeta.sourceBbox, nextBbox)
    ) {
      return currentLayer;
    }

    removeOrthophoto(uuid);

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
    orthophotoMeta.set(uuid, {
      sourceBbox: nextBbox,
      providerRectangle: _rectangleToDegrees(provider.rectangle),
      providerType: provider?.constructor?.name || "UnknownImageryProvider",
      previewUrl,
      url,
    });
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
    orthophotoMeta.delete(uuid);
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
    const key = _key(uuid, pipeline);
    const currentTileset = tilesets.get(key) || null;
    const currentDebug = tileDebugMeta.get(key) || null;
    if (options.forceReload !== true && currentTileset && currentDebug?.sourceUrl === url) {
      return currentTileset;
    }

    removeTileset(uuid, pipeline);

    const descriptorResponse = await fetch(url);
    if (!descriptorResponse.ok) {
      throw new Error(`Tileset JSON yuklenemedi: ${descriptorResponse.status}`);
    }
    const descriptor = await descriptorResponse.json();
    const contentUri = descriptor?.root?.content?.uri;

    const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
      maximumScreenSpaceError: pipeline === "indoor" ? 8 : 16,
    });
    viewer.scene.primitives.add(tileset);
    const debugMeta = {
      type: "tileset",
      sourceUrl: url,
      rootTransform: Array.isArray(descriptor?.root?.transform) ? descriptor.root.transform : null,
      contentUri: typeof contentUri === "string" ? contentUri : null,
      transformTranslationCartographic: Array.isArray(descriptor?.root?.transform)
        ? _matrixTranslationCartographic(Cesium.Matrix4.fromArray(descriptor.root.transform))
        : null,
      region: Array.isArray(descriptor?.root?.boundingVolume?.region)
        ? descriptor.root.boundingVolume.region.map(Number)
        : null,
    };
    await _applyTerrainHeightOffsetWithRetry(tileset, descriptor, debugMeta);
    tilesets.set(key, tileset);
    tileDebugMeta.set(key, debugMeta);
    boundingSpheres.set(key, tileset.boundingSphere);
    _applyVisibility();
    _debugProjectAlignment(uuid, pipeline, {
      phase: "load-3dtileset",
      tilesetBoundingSphere: _primitiveBoundingSphere(tileset),
    });
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
    tileDebugMeta.delete(key);
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

  function getTilesetDebugInfo(uuid, pipeline = "drone") {
    if (!viewer) return null;
    const key = _key(uuid, pipeline);
    const tileset = tilesets.get(key);
    if (!tileset) return null;
    const sphere = boundingSpheres.get(key) || null;
    let centerCartographic = null;
    if (sphere?.center) {
      const cartographic = Cesium.Cartographic.fromCartesian(sphere.center);
      if (cartographic) {
        centerCartographic = {
          longitude: Cesium.Math.toDegrees(cartographic.longitude),
          latitude: Cesium.Math.toDegrees(cartographic.latitude),
          height: cartographic.height,
        };
      }
    }
    return {
      show: tileset.show,
      radius: sphere?.radius ?? null,
      centerCartographic,
      primitiveBoundingSphere: _primitiveBoundingSphere(tileset),
      rootTransform: tileDebugMeta.get(key)?.rootTransform || (Array.isArray(tileset.root?.transform) ? Array.from(tileset.root.transform) : null),
      transformTranslationCartographic: tileDebugMeta.get(key)?.transformTranslationCartographic || null,
      region: tileDebugMeta.get(key)?.region || null,
      contentUri: tileDebugMeta.get(key)?.contentUri || null,
      terrainHeights: tileDebugMeta.get(key)?.terrainHeights || null,
      terrainReferenceHeight: tileDebugMeta.get(key)?.terrainReferenceHeight ?? null,
      modelMinHeight: tileDebugMeta.get(key)?.modelMinHeight ?? null,
      terrainOffsetMeters: tileDebugMeta.get(key)?.terrainOffsetMeters ?? null,
      terrainOffsetApplied: tileDebugMeta.get(key)?.terrainOffsetApplied === true,
      terrainOffsetAttempt: tileDebugMeta.get(key)?.terrainOffsetAttempt ?? null,
      type: tileDebugMeta.get(key)?.type || "tileset",
    };
  }

  function startOrbit(uuid, options = {}) {
    if (!viewer) return false;
    const pipeline = options.pipeline || currentMode;
    const sphere = boundingSpheres.get(_key(uuid, pipeline));
    if (!sphere?.center) return false;

    stopOrbit();
    _orbitPaused = false;

    _orbitState = {
      center:  sphere.center.clone(),
      pitch:   Cesium.Math.toRadians(options.pitch ?? -30),
      range:   sphere.radius * (options.rangeFactor ?? 2.8),
      heading: 0,
      speed:   Cesium.Math.toRadians(options.speedDegsPerSec ?? 4),
      lastMs:  null,
    };

    function _tick() {
      if (_orbitPaused || !_orbitState) return;
      const now = Date.now();
      if (_orbitState.lastMs !== null) {
        const dt = Math.min((now - _orbitState.lastMs) / 1000, 0.1);
        _orbitState.heading += _orbitState.speed * dt;
      }
      _orbitState.lastMs = now;
      viewer.camera.lookAt(
        _orbitState.center,
        new Cesium.HeadingPitchRange(_orbitState.heading, _orbitState.pitch, _orbitState.range)
      );
    }

    _orbitHandler = _tick;
    viewer.scene.preRender.addEventListener(_orbitHandler);
    return true;
  }

  function stopOrbit() {
    if (_orbitHandler) {
      try { viewer?.scene?.preRender?.removeEventListener(_orbitHandler); } catch {}
      _orbitHandler = null;
    }
    _orbitState  = null;
    _orbitPaused = false;
    if (viewer) {
      try { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch {}
    }
  }

  function setOrbitPaused(paused) {
    _orbitPaused = !!paused;
    if (!paused && _orbitState) _orbitState.lastMs = null; // prevent heading jump on resume
  }

  function flyToHome(options = {}) {
    if (!viewer) return;
    // 8 500 km yükseklik, pitch -60° → Earth nadir'den 30° ötede → globe görünür ve eğri belli
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(35.0, 39.0, 8_500_000),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-75),
        roll: 0,
      },
      duration: options.duration ?? 2.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
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
    getTilesetDebugInfo,
    debugProjectAlignment: _debugProjectAlignment,
    armClickLoggerOnce,
    flyToHome,
    flyTo,
    setMode,
    startOrbit,
    stopOrbit,
    setOrbitPaused,
  };
})();
