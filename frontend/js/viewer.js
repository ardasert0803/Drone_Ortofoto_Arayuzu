/* CesiumJS viewer kurulumu + katman yönetimi. */
window.AppViewer = (() => {
  let viewer = null;
  let currentMode = "drone";
  let osmBuildings = null;
  let debugClickHandler = null;
  let persistentClickLogger = null;
  let terrainHandle = null;
  let terrainReadyPromise = null;

  const orthophotoLayers = new Map();     // uuid -> ImageryLayer
  const orthophotoMeta = new Map();       // uuid -> debug info
  const tilesets = new Map();             // key(pipeline:uuid) -> Cesium3DTileset
  const boundingSpheres = new Map();      // key(pipeline:uuid) -> BoundingSphere
  const tileDebugMeta = new Map();        // key(pipeline:uuid) -> debug info
  const glbBoundsCache = new Map();       // contentUrl -> { mins, maxs }
  const tilesetEditorState = {
    key: null,
    entities: [],
    handler: null,
    onChange: null,
    repeatTimer: null,
  };

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
        terrainHandle = Cesium.Terrain.fromWorldTerrain();
        terrainReadyPromise = null;
        opts.terrain = terrainHandle;
      } catch (e) {
        console.warn("Terrain yüklenemedi:", e);
        terrainHandle = null;
        terrainReadyPromise = null;
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

  function _resolveContentUrl(tilesetUrl, contentUri) {
    if (!tilesetUrl || !contentUri) return null;
    try {
      const absoluteTilesetUrl = new URL(tilesetUrl, window.location.href).toString();
      return new URL(contentUri, absoluteTilesetUrl).toString();
    } catch (_) {
      return null;
    }
  }

  function _median(values) {
    if (!Array.isArray(values) || !values.length) return null;
    const sorted = values
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  }

  function _normalizeTilesetAdjustment(adjustment = null) {
    const raw = adjustment && typeof adjustment === "object" ? adjustment : {};
    const normalized = {
      east_meters: Number(raw.east_meters) || 0,
      north_meters: Number(raw.north_meters) || 0,
      up_meters: Number(raw.up_meters) || 0,
      heading_degrees: Number(raw.heading_degrees) || 0,
      pitch_degrees: Number(raw.pitch_degrees) || 0,
      roll_degrees: Number(raw.roll_degrees) || 0,
      scale: Number(raw.scale),
    };
    if (!Number.isFinite(normalized.scale) || normalized.scale <= 0) {
      normalized.scale = 1;
    }
    return normalized;
  }

  function _isIdentityTilesetAdjustment(adjustment) {
    const value = _normalizeTilesetAdjustment(adjustment);
    return (
      Math.abs(value.east_meters) < 1e-9
      && Math.abs(value.north_meters) < 1e-9
      && Math.abs(value.up_meters) < 1e-9
      && Math.abs(value.heading_degrees) < 1e-9
      && Math.abs(value.pitch_degrees) < 1e-9
      && Math.abs(value.roll_degrees) < 1e-9
      && Math.abs(value.scale - 1) < 1e-9
    );
  }

  function _cloneMatrix(matrix) {
    return Cesium.Matrix4.clone(matrix, new Cesium.Matrix4());
  }

  function _cloneCartesian(cartesian) {
    return cartesian ? Cesium.Cartesian3.clone(cartesian, new Cesium.Cartesian3()) : null;
  }

  function _ensureManualAdjustmentBase(key, tileset) {
    const debugMeta = tileDebugMeta.get(key);
    if (!debugMeta || !tileset) return null;
    if (!debugMeta.baseModelMatrix) {
      debugMeta.baseModelMatrix = _cloneMatrix(tileset.modelMatrix);
    }
    if (!debugMeta.manualAnchorCartesian) {
      const sphere = tileset.boundingSphere || boundingSpheres.get(key) || null;
      debugMeta.manualAnchorCartesian = _cloneCartesian(sphere?.center || null);
    }
    return debugMeta;
  }

  function _applyManualTilesetAdjustment(key, adjustment = null) {
    const tileset = tilesets.get(key);
    const debugMeta = _ensureManualAdjustmentBase(key, tileset);
    if (!tileset || !debugMeta?.baseModelMatrix || !debugMeta?.manualAnchorCartesian) return false;

    const normalized = _normalizeTilesetAdjustment(adjustment);
    debugMeta.manualAdjustment = _isIdentityTilesetAdjustment(normalized) ? null : normalized;

    if (!debugMeta.manualAdjustment) {
      tileset.modelMatrix = _cloneMatrix(debugMeta.baseModelMatrix);
      boundingSpheres.set(key, tileset.boundingSphere);
      _requestTilesetEditorRender(key);
      viewer?.scene?.requestRender?.();
      return true;
    }

    const anchor = debugMeta.manualAnchorCartesian;
    const enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(anchor);
    const inverseEnu = Cesium.Matrix4.inverseTransformation(enuFrame, new Cesium.Matrix4());
    const hpr = Cesium.HeadingPitchRoll.fromDegrees(
      normalized.heading_degrees,
      normalized.pitch_degrees,
      normalized.roll_degrees,
    );
    const trs = new Cesium.TranslationRotationScale();
    trs.translation = new Cesium.Cartesian3(
      normalized.east_meters,
      normalized.north_meters,
      normalized.up_meters,
    );
    trs.rotation = Cesium.Quaternion.fromHeadingPitchRoll(hpr);
    trs.scale = new Cesium.Cartesian3(normalized.scale, normalized.scale, normalized.scale);
    const localMatrix = Cesium.Matrix4.fromTranslationRotationScale(trs, new Cesium.Matrix4());
    const temp = Cesium.Matrix4.multiplyTransformation(enuFrame, localMatrix, new Cesium.Matrix4());
    const adjustmentMatrix = Cesium.Matrix4.multiplyTransformation(temp, inverseEnu, new Cesium.Matrix4());
    tileset.modelMatrix = Cesium.Matrix4.multiplyTransformation(
      adjustmentMatrix,
      debugMeta.baseModelMatrix,
      new Cesium.Matrix4(),
    );
    boundingSpheres.set(key, tileset.boundingSphere);
    _requestTilesetEditorRender(key);
    viewer?.scene?.requestRender?.();
    return true;
  }

  function _getTilesetEditorAnchor(key) {
    const sphere = boundingSpheres.get(key) || tilesets.get(key)?.boundingSphere || null;
    return _cloneCartesian(sphere?.center || tileDebugMeta.get(key)?.manualAnchorCartesian || null);
  }

  function _getTilesetEditorAxis(anchor, axisName) {
    if (!anchor) return null;
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(anchor);
    const index = axisName === "east" ? 0 : axisName === "north" ? 1 : 2;
    const column = Cesium.Matrix4.getColumn(frame, index, new Cesium.Cartesian4());
    return Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(column.x, column.y, column.z),
      new Cesium.Cartesian3(),
    );
  }

  function _offsetFromAnchor(anchor, axisName, meters) {
    const axis = _getTilesetEditorAxis(anchor, axisName);
    if (!axis) return null;
    const offset = Cesium.Cartesian3.multiplyByScalar(axis, meters, new Cesium.Cartesian3());
    return Cesium.Cartesian3.add(anchor, offset, new Cesium.Cartesian3());
  }

  function _requestTilesetEditorRender(key = tilesetEditorState.key) {
    if (!viewer || !key || tilesetEditorState.key !== key) return;
    for (const entity of tilesetEditorState.entities) {
      entity.show = true;
    }
    viewer.scene.requestRender();
  }

  function _destroyTilesetEditor() {
    if (tilesetEditorState.repeatTimer) {
      window.clearInterval(tilesetEditorState.repeatTimer);
      tilesetEditorState.repeatTimer = null;
    }
    if (tilesetEditorState.handler) {
      try {
        tilesetEditorState.handler.destroy();
      } catch (_) {
        /* yoksay */
      }
      tilesetEditorState.handler = null;
    }
    if (viewer) {
      for (const entity of tilesetEditorState.entities) {
        try {
          viewer.entities.remove(entity);
        } catch (_) {
          /* yoksay */
        }
      }
    }
    tilesetEditorState.entities = [];
    tilesetEditorState.key = null;
    tilesetEditorState.onChange = null;
  }

  function _emitTilesetEditorChange(key) {
    if (tilesetEditorState.key !== key || typeof tilesetEditorState.onChange !== "function") return;
    const adjustment = tileDebugMeta.get(key)?.manualAdjustment || null;
    tilesetEditorState.onChange(adjustment);
  }

  function _nudgeTilesetAdjustment(key, patch) {
    const current = _normalizeTilesetAdjustment(tileDebugMeta.get(key)?.manualAdjustment || null);
    if (typeof patch.east_meters === "number") current.east_meters += patch.east_meters;
    if (typeof patch.north_meters === "number") current.north_meters += patch.north_meters;
    if (typeof patch.up_meters === "number") current.up_meters += patch.up_meters;
    if (typeof patch.heading_degrees === "number") current.heading_degrees += patch.heading_degrees;
    if (typeof patch.pitch_degrees === "number") current.pitch_degrees += patch.pitch_degrees;
    if (typeof patch.roll_degrees === "number") current.roll_degrees += patch.roll_degrees;
    if (typeof patch.scale === "number") {
      current.scale = Math.max(0.01, Math.min(100.0, patch.scale));
    }
    _applyManualTilesetAdjustment(key, current);
    _emitTilesetEditorChange(key);
  }

  function _createTilesetEditorHandle(config) {
    const key = tilesetEditorState.key;
    const line = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const anchor = _getTilesetEditorAnchor(key);
          if (!anchor) return [];
          const start = _offsetFromAnchor(anchor, config.axis, config.startMeters * config.direction);
          const end = _offsetFromAnchor(anchor, config.axis, config.endMeters * config.direction);
          return start && end ? [start, end] : [];
        }, false),
        width: config.width || 8,
        material: new Cesium.PolylineArrowMaterialProperty(config.color),
        depthFailMaterial: new Cesium.PolylineArrowMaterialProperty(config.color.withAlpha(0.6)),
      },
    });
    line._scTilesetAdjust = config.patch;

    const label = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => {
        const anchor = _getTilesetEditorAnchor(key);
        return anchor ? _offsetFromAnchor(anchor, config.axis, config.labelMeters * config.direction) : null;
      }, false),
      label: {
        text: config.label,
        font: "600 13px Inter, sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: config.color.withAlpha(0.82),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelOffset: new Cesium.Cartesian2(0, config.axis === "up" ? 0 : -2),
      },
    });
    label._scTilesetAdjust = config.patch;

    tilesetEditorState.entities.push(line, label);
  }

  function _createTilesetEditorAction(config) {
    const key = tilesetEditorState.key;
    const entity = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => {
        const anchor = _getTilesetEditorAnchor(key);
        if (!anchor) return null;
        const primary = _offsetFromAnchor(anchor, config.axis, config.axisMeters);
        if (!primary) return null;
        if (!config.sideAxis) return primary;
        return _offsetFromAnchor(primary, config.sideAxis, config.sideMeters);
      }, false),
      label: {
        text: config.label,
        font: "600 13px Inter, sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: config.color.withAlpha(0.82),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity._scTilesetAdjust = config.patch;
    tilesetEditorState.entities.push(entity);
  }

  function startTilesetAdjustmentEditor(uuid, options = {}) {
    if (!viewer) return false;
    const key = _key(uuid, options.pipeline || "drone");
    if (!tilesets.has(key)) return false;

    _destroyTilesetEditor();
    if (options.adjustment !== undefined) {
      _applyManualTilesetAdjustment(key, options.adjustment || null);
    }
    tilesetEditorState.key = key;
    tilesetEditorState.onChange = typeof options.onChange === "function" ? options.onChange : null;

    _createTilesetEditorHandle({
      axis: "east",
      direction: 1,
      startMeters: 8,
      endMeters: 24,
      labelMeters: 28,
      label: "Dogu +1m",
      color: Cesium.Color.fromCssColorString("#ff6b6b"),
      patch: { east_meters: 1.0 },
    });
    _createTilesetEditorHandle({
      axis: "east",
      direction: -1,
      startMeters: 8,
      endMeters: 24,
      labelMeters: 28,
      label: "Bati -1m",
      color: Cesium.Color.fromCssColorString("#ff8e72"),
      patch: { east_meters: -1.0 },
    });
    _createTilesetEditorHandle({
      axis: "north",
      direction: 1,
      startMeters: 8,
      endMeters: 24,
      labelMeters: 28,
      label: "Kuzey +1m",
      color: Cesium.Color.fromCssColorString("#4dabf7"),
      patch: { north_meters: 1.0 },
    });
    _createTilesetEditorHandle({
      axis: "north",
      direction: -1,
      startMeters: 8,
      endMeters: 24,
      labelMeters: 28,
      label: "Guney -1m",
      color: Cesium.Color.fromCssColorString("#339af0"),
      patch: { north_meters: -1.0 },
    });
    _createTilesetEditorHandle({
      axis: "up",
      direction: 1,
      startMeters: 4,
      endMeters: 20,
      labelMeters: 24,
      label: "Yukari +0.5m",
      color: Cesium.Color.fromCssColorString("#51cf66"),
      patch: { up_meters: 0.5 },
    });
    _createTilesetEditorHandle({
      axis: "up",
      direction: -1,
      startMeters: 4,
      endMeters: 20,
      labelMeters: 24,
      label: "Asagi -0.5m",
      color: Cesium.Color.fromCssColorString("#2f9e44"),
      patch: { up_meters: -0.5 },
    });

    _createTilesetEditorAction({
      axis: "up",
      axisMeters: 28,
      sideAxis: "east",
      sideMeters: -16,
      label: "Yaw -2deg",
      color: Cesium.Color.fromCssColorString("#845ef7"),
      patch: { heading_degrees: -2.0 },
    });
    _createTilesetEditorAction({
      axis: "up",
      axisMeters: 28,
      sideAxis: "east",
      sideMeters: 16,
      label: "Yaw +2deg",
      color: Cesium.Color.fromCssColorString("#7048e8"),
      patch: { heading_degrees: 2.0 },
    });

    const clearRepeat = () => {
      if (!tilesetEditorState.repeatTimer) return;
      window.clearInterval(tilesetEditorState.repeatTimer);
      tilesetEditorState.repeatTimer = null;
    };

    tilesetEditorState.handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    tilesetEditorState.handler.setInputAction((click) => {
      clearRepeat();
      const picked = viewer.scene.pick(click.position);
      const payload = picked?.id?._scTilesetAdjust || null;
      if (!payload) return;
      _nudgeTilesetAdjustment(key, payload);
      tilesetEditorState.repeatTimer = window.setInterval(() => {
        _nudgeTilesetAdjustment(key, payload);
      }, 140);
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    tilesetEditorState.handler.setInputAction(() => {
      clearRepeat();
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    _requestTilesetEditorRender(key);
    return true;
  }

  function stopTilesetAdjustmentEditor() {
    _destroyTilesetEditor();
    viewer?.scene?.requestRender?.();
  }

  async function _fetchGlbPositionBounds(contentUrl) {
    if (!contentUrl) return null;
    if (glbBoundsCache.has(contentUrl)) {
      return glbBoundsCache.get(contentUrl);
    }

    let response = null;
    try {
      response = await fetch(contentUrl);
    } catch (_) {
      return null;
    }
    if (!response.ok) return null;

    let bytes = null;
    try {
      bytes = await response.arrayBuffer();
    } catch (_) {
      return null;
    }

    try {
      const view = new DataView(bytes);
      if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546C67) {
        return null;
      }
      const chunkLength = view.getUint32(12, true);
      const chunkType = view.getUint32(16, true);
      if (chunkType !== 0x4E4F534A) return null; // JSON

      const jsonBytes = new Uint8Array(bytes, 20, chunkLength);
      const payload = JSON.parse(new TextDecoder().decode(jsonBytes));
      const mins = [Infinity, Infinity, Infinity];
      const maxs = [-Infinity, -Infinity, -Infinity];
      let found = false;

      for (const mesh of payload.meshes || []) {
        for (const primitive of mesh.primitives || []) {
          const accessorIdx = primitive?.attributes?.POSITION;
          if (!Number.isInteger(accessorIdx)) continue;
          const accessor = payload?.accessors?.[accessorIdx];
          const localMin = accessor?.min;
          const localMax = accessor?.max;
          if (!Array.isArray(localMin) || !Array.isArray(localMax) || localMin.length < 3 || localMax.length < 3) {
            continue;
          }
          found = true;
          for (let idx = 0; idx < 3; idx += 1) {
            mins[idx] = Math.min(mins[idx], Number(localMin[idx]));
            maxs[idx] = Math.max(maxs[idx], Number(localMax[idx]));
          }
        }
      }

      if (!found || !mins.concat(maxs).every(Number.isFinite)) {
        return null;
      }

      const bounds = {mins, maxs};
      glbBoundsCache.set(contentUrl, bounds);
      return bounds;
    } catch (_) {
      return null;
    }
  }

  function _glbBoundsCorners(bounds) {
    if (!bounds?.mins || !bounds?.maxs) return [];
    const [minX, minY, minZ] = bounds.mins.map(Number);
    const [maxX, maxY, maxZ] = bounds.maxs.map(Number);
    if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return [];
    return [
      new Cesium.Cartesian3(minX, minY, minZ),
      new Cesium.Cartesian3(minX, minY, maxZ),
      new Cesium.Cartesian3(minX, maxY, minZ),
      new Cesium.Cartesian3(minX, maxY, maxZ),
      new Cesium.Cartesian3(maxX, minY, minZ),
      new Cesium.Cartesian3(maxX, minY, maxZ),
      new Cesium.Cartesian3(maxX, maxY, minZ),
      new Cesium.Cartesian3(maxX, maxY, maxZ),
    ];
  }

  function _withTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);

      Promise.resolve(promise)
        .then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value ?? null);
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        });
    });
  }

  /**
   * Cesium.Terrain.fromWorldTerrain() async yüklenir; yüklenene kadar
   * globe terrain provider'ı ellipsoid olarak kalabilir.
   * Bu fonksiyon gerçek terrain provider hazır olana kadar bekler.
   * Token yoksa veya timeout geçerse null döner.
   */
  function _waitForRealTerrain(timeoutMs = 15_000) {
    if (!viewer) return Promise.resolve(null);
    const globe = viewer.scene?.globe;
    const current = globe?.terrainProvider;
    if (current && !(current instanceof Cesium.EllipsoidTerrainProvider)) {
      return Promise.resolve(current); // zaten hazır
    }

    if (terrainHandle) {
      if (terrainHandle.ready && terrainHandle.provider) {
        return Promise.resolve(terrainHandle.provider);
      }
      if (!terrainReadyPromise) {
        terrainReadyPromise = new Promise((resolve) => {
          let settled = false;

          const finish = (provider) => {
            if (settled) return;
            settled = true;
            try {
              terrainHandle?.readyEvent?.removeEventListener(onReady);
              terrainHandle?.errorEvent?.removeEventListener(onError);
              globe?.terrainProviderChanged?.removeEventListener(onProviderChanged);
            } catch (_) {
              /* yoksay */
            }
            resolve(provider ?? null);
          };

          function onReady(provider) {
            finish(provider);
          }

          function onError() {
            finish(null);
          }

          function onProviderChanged(provider) {
            if (!(provider instanceof Cesium.EllipsoidTerrainProvider)) {
              finish(provider);
            }
          }

          terrainHandle.readyEvent.addEventListener(onReady);
          terrainHandle.errorEvent.addEventListener(onError);
          globe?.terrainProviderChanged?.addEventListener(onProviderChanged);
        });
      }
      return _withTimeout(terrainReadyPromise, timeoutMs);
    }

    if (!globe?.terrainProviderChanged) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        globe.terrainProviderChanged.removeEventListener(onChanged);
        resolve(null); // terrain hiç gelmedi (token yok vb.)
      }, timeoutMs);

      function onChanged(newProvider) {
        if (settled) return;
        if (!(newProvider instanceof Cesium.EllipsoidTerrainProvider)) {
          settled = true;
          clearTimeout(timer);
          globe.terrainProviderChanged.removeEventListener(onChanged);
          resolve(newProvider);
        }
      }

      globe.terrainProviderChanged.addEventListener(onChanged);
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

  function _tilesetNeedsTerrainPlacement(descriptor, pipeline = "drone") {
    if (pipeline !== "drone") return false;
    const region = descriptor?.root?.boundingVolume?.region;
    if (!Array.isArray(region) || region.length < 6) return false;
    return !_tilesetHasEcefTransform(descriptor);
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

  async function _applyForceGroundClamp(tileset, descriptor, debugMeta, tilesetUrl) {
    if (!viewer || !tileset || !_tilesetHasEcefTransform(descriptor)) return debugMeta;

    const terrainProvider = await _waitForRealTerrain(15_000);
    if (!terrainProvider) {
      debugMeta.forceGroundClampSkipped = "terrain-unavailable";
      return debugMeta;
    }

    const contentUri = typeof descriptor?.root?.content?.uri === "string"
      ? descriptor.root.content.uri
      : null;
    const contentUrl = _resolveContentUrl(tilesetUrl, contentUri);
    debugMeta.forceGroundClampContentUrl = contentUrl;
    if (!contentUrl) {
      debugMeta.forceGroundClampSkipped = "missing-content-url";
      return debugMeta;
    }

    const bounds = await _fetchGlbPositionBounds(contentUrl);
    const corners = _glbBoundsCorners(bounds);
    if (!corners.length) {
      debugMeta.forceGroundClampSkipped = "missing-glb-bounds";
      return debugMeta;
    }

    const rootMatrix = Array.isArray(descriptor?.root?.transform)
      ? Cesium.Matrix4.fromArray(descriptor.root.transform)
      : Cesium.Matrix4.IDENTITY;

    const transformed = corners
      .map((corner) => {
        const world = Cesium.Matrix4.multiplyByPoint(rootMatrix, corner, new Cesium.Cartesian3());
        const cartographic = Cesium.Cartographic.fromCartesian(world);
        return cartographic && Number.isFinite(cartographic.height)
          ? {world, cartographic}
          : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.cartographic.height - right.cartographic.height)
      .slice(0, 4);

    if (!transformed.length) {
      debugMeta.forceGroundClampSkipped = "invalid-corners";
      return debugMeta;
    }

    let sampled = null;
    try {
      sampled = await Cesium.sampleTerrainMostDetailed(
        terrainProvider,
        transformed.map(({cartographic}) => new Cesium.Cartographic(cartographic.longitude, cartographic.latitude)),
      );
    } catch (error) {
      console.warn("[tileset] force ground clamp sample failed", error);
      debugMeta.forceGroundClampSkipped = "sample-failed";
      return debugMeta;
    }

    const deltas = sampled
      .map((position, idx) => {
        const terrainHeight = position?.height;
        const modelHeight = transformed[idx]?.cartographic?.height;
        if (!Number.isFinite(terrainHeight) || !Number.isFinite(modelHeight)) return null;
        return terrainHeight - modelHeight;
      })
      .filter((value) => Number.isFinite(value));

    if (!deltas.length) {
      debugMeta.forceGroundClampSkipped = "missing-deltas";
      return debugMeta;
    }

    const offsetMeters = _median(deltas);
    debugMeta.forceGroundClampDeltas = deltas;
    debugMeta.forceGroundClampOffsetMeters = offsetMeters;

    if (!Number.isFinite(offsetMeters) || Math.abs(offsetMeters) < 0.5 || Math.abs(offsetMeters) > 250.0) {
      debugMeta.forceGroundClampSkipped = "offset-out-of-range";
      return debugMeta;
    }

    const lonCenter = transformed.reduce((sum, item) => sum + item.cartographic.longitude, 0.0) / transformed.length;
    const latCenter = transformed.reduce((sum, item) => sum + item.cartographic.latitude, 0.0) / transformed.length;
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
    debugMeta.forceGroundClampApplied = true;
    return debugMeta;
  }

  async function _applyForceGroundClampWithRetry(tileset, descriptor, debugMeta, tilesetUrl, attempts = 2) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      debugMeta.forceGroundClampAttempt = attempt;
      const result = await _applyForceGroundClamp(tileset, descriptor, debugMeta, tilesetUrl);
      if (result?.forceGroundClampApplied) return result;
      if (attempt < attempts) {
        viewer?.scene?.requestRender?.();
        await _sleep(700 * attempt);
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
      _applyManualTilesetAdjustment(key, options.adjustment || null);
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
    if (_tilesetNeedsTerrainPlacement(descriptor, pipeline)) {
      await _applyTerrainHeightOffsetWithRetry(tileset, descriptor, debugMeta);
    } else if (pipeline === "drone" && _tilesetHasEcefTransform(descriptor)) {
      debugMeta.terrainOffsetSkipped = "ecef-transform";
      await _applyForceGroundClampWithRetry(tileset, descriptor, debugMeta, url);
    }
    viewer.scene.primitives.add(tileset);
    tilesets.set(key, tileset);
    tileDebugMeta.set(key, debugMeta);
    boundingSpheres.set(key, tileset.boundingSphere);
    _ensureManualAdjustmentBase(key, tileset);
    _applyManualTilesetAdjustment(key, options.adjustment || null);
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
    if (tilesetEditorState.key === key) {
      stopTilesetAdjustmentEditor();
    }
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
      forceGroundClampApplied: tileDebugMeta.get(key)?.forceGroundClampApplied === true,
      forceGroundClampAttempt: tileDebugMeta.get(key)?.forceGroundClampAttempt ?? null,
      forceGroundClampOffsetMeters: tileDebugMeta.get(key)?.forceGroundClampOffsetMeters ?? null,
      forceGroundClampDeltas: tileDebugMeta.get(key)?.forceGroundClampDeltas || null,
      forceGroundClampContentUrl: tileDebugMeta.get(key)?.forceGroundClampContentUrl || null,
      forceGroundClampSkipped: tileDebugMeta.get(key)?.forceGroundClampSkipped || null,
      manualAdjustment: tileDebugMeta.get(key)?.manualAdjustment || null,
      type: tileDebugMeta.get(key)?.type || "tileset",
    };
  }

  function setTilesetAdjustment(uuid, adjustment, pipeline = "drone") {
    return _applyManualTilesetAdjustment(_key(uuid, pipeline), adjustment || null);
  }

  function getTilesetAdjustment(uuid, pipeline = "drone") {
    return tileDebugMeta.get(_key(uuid, pipeline))?.manualAdjustment || null;
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
    setTilesetAdjustment,
    getTilesetAdjustment,
    startTilesetAdjustmentEditor,
    stopTilesetAdjustmentEditor,
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
