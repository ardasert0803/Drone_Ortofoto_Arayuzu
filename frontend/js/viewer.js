window.AppViewer = (() => {
  let viewer = null;
  let currentMode = "drone";
  let osmBuildings = null;
  let debugClickHandler = null;
  let persistentClickLogger = null;
  let terrainHandle = null;
  let terrainReadyPromise = null;
  let toolbarObserver = null;

  const orthophotoLayers = new Map();
  const orthophotoMeta = new Map();
  const tilesets = new Map();
  const boundingSpheres = new Map();
  const tileDebugMeta = new Map();
  const glbBoundsCache = new Map();
  const tilesetEditorState = {
    key: null,
    entities: [],
    handler: null,
    onChange: null,
    repeatTimer: null,
    targets: [],
    hoveredTargetId: null,
    cameraState: null,
  };
  let tilesetEditorTargetSeq = 0;

  let orthoVisible = true;
  let droneTilesVisible = true;
  let osmVisible = false;

  let _orbitHandler = null;
  let _orbitState = null;
  let _orbitPaused = false;

  function _key(uuid, pipeline = "drone") {
    return `${pipeline}:${uuid}`;
  }

  function _applySceneMode() {
    if (!viewer) return;
    viewer.scene.globe.show = true;
    viewer.scene.skyAtmosphere.show = true;
    if (viewer.scene.skyBox) viewer.scene.skyBox.show = true;
    if (viewer.scene.sun) viewer.scene.sun.show = true;
    if (viewer.scene.moon) viewer.scene.moon.show = true;
    viewer.scene.backgroundColor = Cesium.Color.BLACK;
  }

  function _applyVisibility() {
    for (const layer of orthophotoLayers.values()) {
      layer.show = currentMode === "drone" && orthoVisible;
    }
    for (const [key, tileset] of tilesets.entries()) {
      const isDroneTileset = key.startsWith("drone:");
      tileset.show = isDroneTileset && currentMode === "drone" && droneTilesVisible;
    }
    if (osmBuildings) {
      osmBuildings.show = currentMode === "drone" && osmVisible;
    }
  }

  function _removeCesiumToolbar() {
    const container = viewer?.container;
    if (!container) return;

    const removeToolbars = () => {
      container.querySelectorAll(".cesium-viewer-toolbar").forEach((element) => {
        element.hidden = true;
        element.remove();
      });
    };

    removeToolbars();

    if (toolbarObserver) return;
    toolbarObserver = new MutationObserver(() => {
      removeToolbars();
    });
    toolbarObserver.observe(container, { childList: true, subtree: true });
  }

  async function _validateIonToken(ionToken) {
    if (!ionToken) return { ok: false, reason: "missing" };
    const suffix = ionToken.slice(-8);
    try {
      const response = await fetch("https://api.cesium.com/v1/assets/1/endpoint", {
        method: "GET",
        headers: { Authorization: `Bearer ${ionToken}` },
        cache: "no-store",
      });
      if (response.ok) {
        console.info(`Cesium ion token dogrulandi (...${suffix}).`);
        return { ok: true };
      }
      let details = "";
      try {
        const payload = await response.json();
        details = payload?.code || payload?.message || "";
      } catch {
        details = "";
      }
      console.warn(`Cesium ion token reddedildi (...${suffix}) [${response.status}] ${details}`.trim());
      return { ok: false, reason: details || `http_${response.status}` };
    } catch (error) {
      console.warn(`Cesium ion token dogrulanamadi (...${suffix}).`, error);
      return { ok: false, reason: "network" };
    }
  }

  async function init(ionToken) {
    const ionStatus = await _validateIonToken(ionToken);
    const activeIonToken = ionStatus.ok ? ionToken : "";
    if (activeIonToken) {
      Cesium.Ion.defaultAccessToken = activeIonToken;
    }

    const opts = {
      timeline: false,
      animation: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      geocoder: false,
      navigationHelpButton: false,
      homeButton: false,
      infoBox: false,
      selectionIndicator: false,
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
    };
    if (activeIonToken) {
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
    _removeCesiumToolbar();
    viewer.scene.globe.depthTestAgainstTerrain = !!activeIonToken;
    viewer.scene.skyAtmosphere.show = true;

    Cesium.Camera.DEFAULT_VIEW_RECTANGLE = Cesium.Rectangle.fromDegrees(25.5, 35.5, 45.0, 42.5);

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(35.0, 39.0, 14_000_000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-75), roll: 0 },
    });
    setTimeout(() => flyToHome({ duration: 2.4 }), 350);

    viewer.homeButton?.viewModel?.command.beforeExecute.addEventListener((e) => {
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

  function _windowPositionFromCartesian(cartesian) {
    if (!viewer || !cartesian) return null;
    const point = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
      viewer.scene,
      cartesian,
      new Cesium.Cartesian2(),
    );
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return point;
  }

  function _screenDistanceToPoint(left, right) {
    if (!left || !right) return Number.POSITIVE_INFINITY;
    return Math.hypot(left.x - right.x, left.y - right.y);
  }

  function _screenDistanceToSegment(point, start, end) {
    if (!point || !start || !end) return Number.POSITIVE_INFINITY;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSq = (dx * dx) + (dy * dy);
    if (lengthSq <= 0.0001) return _screenDistanceToPoint(point, start);
    const t = Math.max(0, Math.min(1, (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSq));
    const projection = { x: start.x + (dx * t), y: start.y + (dy * t) };
    return _screenDistanceToPoint(point, projection);
  }

  function _setTilesetEditorHover(targetId = null) {
    if (tilesetEditorState.hoveredTargetId === targetId) return;
    tilesetEditorState.hoveredTargetId = targetId;
    for (const target of tilesetEditorState.targets) {
      const hovered = target.id === targetId;
      if (target.lineEntity?.polyline) {
        target.lineEntity.polyline.width = hovered ? target.baseLineWidth + 4 : target.baseLineWidth;
      }
      if (target.pointEntity?.point) {
        target.pointEntity.point.pixelSize = hovered ? target.basePointSize + 6 : target.basePointSize;
        target.pointEntity.point.outlineWidth = hovered ? target.basePointOutlineWidth + 1 : target.basePointOutlineWidth;
      }
      if (target.labelEntity?.label) {
        target.labelEntity.label.scale = hovered ? 1.08 : 1.0;
        target.labelEntity.label.backgroundColor = hovered
          ? target.baseLabelColor.withAlpha(0.96)
          : target.baseLabelColor.withAlpha(0.82);
      }
    }
    if (viewer?.canvas) {
      viewer.canvas.style.cursor = targetId ? "pointer" : "";
    }
    viewer?.scene?.requestRender?.();
  }

  function _pauseTilesetEditorCameraControls() {
    if (!viewer || tilesetEditorState.cameraState) return;
    const controller = viewer.scene?.screenSpaceCameraController;
    if (!controller) return;
    tilesetEditorState.cameraState = {
      enableRotate: controller.enableRotate,
      enableTranslate: controller.enableTranslate,
      enableTilt: controller.enableTilt,
      enableLook: controller.enableLook,
    };
    controller.enableRotate = false;
    controller.enableTranslate = false;
    controller.enableTilt = false;
    controller.enableLook = false;
  }

  function _resumeTilesetEditorCameraControls() {
    if (!viewer || !tilesetEditorState.cameraState) return;
    const controller = viewer.scene?.screenSpaceCameraController;
    if (!controller) {
      tilesetEditorState.cameraState = null;
      return;
    }
    controller.enableRotate = tilesetEditorState.cameraState.enableRotate;
    controller.enableTranslate = tilesetEditorState.cameraState.enableTranslate;
    controller.enableTilt = tilesetEditorState.cameraState.enableTilt;
    controller.enableLook = tilesetEditorState.cameraState.enableLook;
    tilesetEditorState.cameraState = null;
  }

  function _registerTilesetEditorTarget(target) {
    tilesetEditorState.targets.push(target);
    for (const entity of target.entities) {
      entity._scTilesetAdjust = target.patch;
      entity._scTilesetAdjustId = target.id;
      tilesetEditorState.entities.push(entity);
    }
  }

  function _findTilesetEditorTarget(screenPosition) {
    if (!viewer || !screenPosition) return null;

    const picked = viewer.scene.drillPick(screenPosition, 10) || [];
    for (const item of picked) {
      const targetId = (item && item.id && item.id._scTilesetAdjustId)
        || (item && item.primitive && item.primitive.id && item.primitive.id._scTilesetAdjustId)
        || null;
      if (!targetId) continue;
      const match = tilesetEditorState.targets.find((target) => target.id === targetId);
      if (match) return match;
    }

    let bestTarget = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const target of tilesetEditorState.targets) {
      let distance = Number.POSITIVE_INFINITY;
      if (typeof target.getSegment === "function") {
        const segment = target.getSegment();
        const start = _windowPositionFromCartesian(segment?.[0] || null);
        const end = _windowPositionFromCartesian(segment?.[1] || null);
        distance = Math.min(distance, _screenDistanceToSegment(screenPosition, start, end));
      }
      if (typeof target.getPosition === "function") {
        const point = _windowPositionFromCartesian(target.getPosition());
        distance = Math.min(distance, _screenDistanceToPoint(screenPosition, point));
      }
      if (typeof target.getLabelPosition === "function") {
        const point = _windowPositionFromCartesian(target.getLabelPosition());
        distance = Math.min(distance, _screenDistanceToPoint(screenPosition, point));
      }
      if (distance <= target.hitRadiusPx && distance < bestDistance) {
        bestTarget = target;
        bestDistance = distance;
      }
    }
    return bestTarget;
  }

  function _destroyTilesetEditor() {
    if (tilesetEditorState.repeatTimer) {
      window.clearInterval(tilesetEditorState.repeatTimer);
      tilesetEditorState.repeatTimer = null;
    }
    _resumeTilesetEditorCameraControls();
    _setTilesetEditorHover(null);
    if (tilesetEditorState.handler) {
      try {
        tilesetEditorState.handler.destroy();
      } catch (_) {
      }
      tilesetEditorState.handler = null;
    }
    if (viewer) {
      for (const entity of tilesetEditorState.entities) {
        try {
          viewer.entities.remove(entity);
        } catch (_) {
        }
      }
    }
    tilesetEditorState.entities = [];
    tilesetEditorState.targets = [];
    tilesetEditorState.key = null;
    tilesetEditorState.onChange = null;
    tilesetEditorState.hoveredTargetId = null;
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
    const getSegment = () => {
      const anchor = _getTilesetEditorAnchor(key);
      if (!anchor) return null;
      const start = _offsetFromAnchor(anchor, config.axis, config.startMeters * config.direction);
      const end = _offsetFromAnchor(anchor, config.axis, config.endMeters * config.direction);
      return start && end ? [start, end] : null;
    };
    const getLabelPosition = () => {
      const anchor = _getTilesetEditorAnchor(key);
      return anchor ? _offsetFromAnchor(anchor, config.axis, config.labelMeters * config.direction) : null;
    };
    const getPointPosition = () => {
      const segment = getSegment();
      return segment?.[1] || null;
    };
    const line = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => getSegment() || [], false),
        width: config.width || 12,
        material: new Cesium.PolylineArrowMaterialProperty(config.color),
        depthFailMaterial: new Cesium.PolylineArrowMaterialProperty(config.color.withAlpha(0.6)),
      },
    });

    const point = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => getPointPosition(), false),
      point: {
        pixelSize: config.pointSize || 20,
        color: config.color.withAlpha(0.34),
        outlineColor: Cesium.Color.WHITE.withAlpha(0.96),
        outlineWidth: config.pointOutlineWidth || 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    const label = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => getLabelPosition(), false),
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

    _registerTilesetEditorTarget({
      id: `tileset-editor-target-${++tilesetEditorTargetSeq}`,
      patch: config.patch,
      entities: [line, point, label],
      lineEntity: line,
      pointEntity: point,
      labelEntity: label,
      baseLineWidth: config.width || 12,
      basePointSize: config.pointSize || 20,
      basePointOutlineWidth: config.pointOutlineWidth || 3,
      baseLabelColor: config.color,
      hitRadiusPx: config.hitRadiusPx || 26,
      getSegment,
      getPosition: getPointPosition,
      getLabelPosition,
    });
  }

  function _createTilesetEditorAction(config) {
    const key = tilesetEditorState.key;
    const getPosition = () => {
      const anchor = _getTilesetEditorAnchor(key);
      if (!anchor) return null;
      const primary = _offsetFromAnchor(anchor, config.axis, config.axisMeters);
      if (!primary) return null;
      if (!config.sideAxis) return primary;
      return _offsetFromAnchor(primary, config.sideAxis, config.sideMeters);
    };
    const point = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => getPosition(), false),
      point: {
        pixelSize: config.pointSize || 18,
        color: config.color.withAlpha(0.34),
        outlineColor: Cesium.Color.WHITE.withAlpha(0.96),
        outlineWidth: config.pointOutlineWidth || 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const label = viewer.entities.add({
      position: new Cesium.CallbackProperty(() => getPosition(), false),
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
        pixelOffset: new Cesium.Cartesian2(0, -22),
      },
    });

    _registerTilesetEditorTarget({
      id: `tileset-editor-target-${++tilesetEditorTargetSeq}`,
      patch: config.patch,
      entities: [point, label],
      pointEntity: point,
      labelEntity: label,
      basePointSize: config.pointSize || 18,
      basePointOutlineWidth: config.pointOutlineWidth || 3,
      baseLabelColor: config.color,
      hitRadiusPx: config.hitRadiusPx || 28,
      getPosition,
      getLabelPosition: getPosition,
    });
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
      _resumeTilesetEditorCameraControls();
    };

    tilesetEditorState.handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    tilesetEditorState.handler.setInputAction((click) => {
      clearRepeat();
      const target = _findTilesetEditorTarget(click.position);
      if (!target?.patch) return;
      _setTilesetEditorHover(target.id);
      _pauseTilesetEditorCameraControls();
      _nudgeTilesetAdjustment(key, target.patch);
      tilesetEditorState.repeatTimer = window.setInterval(() => {
        _nudgeTilesetAdjustment(key, target.patch);
      }, 140);
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    tilesetEditorState.handler.setInputAction((movement) => {
      const target = _findTilesetEditorTarget(movement.endPosition);
      _setTilesetEditorHover(target?.id || null);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
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
      if (chunkType !== 0x4E4F534A) return null;

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

  function _waitForRealTerrain(timeoutMs = 15_000) {
    if (!viewer) return Promise.resolve(null);
    const globe = viewer.scene?.globe;
    const current = globe?.terrainProvider;
    if (current && !(current instanceof Cesium.EllipsoidTerrainProvider)) {
      return Promise.resolve(current);
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
        resolve(null);
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

  function _tilesetHasEcefTransform(descriptor) {
    const t = descriptor?.root?.transform;
    if (!Array.isArray(t) || t.length !== 16) return false;
    return Math.hypot(t[12], t[13], t[14]) > 1_000_000;
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

    if (_tilesetHasEcefTransform(descriptor)) {
      debugMeta.terrainOffsetSkipped = "ecef-transform";
      return debugMeta;
    }

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
      if (result?.terrainHeights?.length) return result;
      if (attempt < attempts) {
        viewer?.scene?.requestRender?.();
        await _sleep(800 * attempt);
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
      maximumScreenSpaceError: 16,
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
      heading: Cesium.Math.toRadians(options.heading ?? 0),
      speed:   Cesium.Math.toRadians((options.direction === "counterclockwise" ? -1 : 1) * (options.speedDegsPerSec ?? 4)),
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
    if (!paused && _orbitState) _orbitState.lastMs = null;
  }

  function flyToHome(options = {}) {
    if (!viewer) return;
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
    currentMode = mode === "drone" ? "drone" : "drone";
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
