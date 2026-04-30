/* Cesium üzerinde mesafe / alan / yükseklik ölçüm araçları.
 * Her tıklamada nokta ekler; "Temizle" hepsini siler.
 * Sonuç sağ paneldeki #measurement-result kutusuna yazılır.
 */
window.AppMeasure = (() => {
  let viewer = null;
  let handler = null;
  let activeTool = null;
  let entities = [];      // çizilen markerlar/poligon
  let positions = [];     // Cartesian3 dizisi
  let resultEl = null;

  function init(_viewer) {
    viewer = _viewer;
    resultEl = document.getElementById("measurement-result");
  }

  function _setResult(text) {
    if (resultEl) resultEl.textContent = text;
  }

  function clearAll() {
    for (const e of entities) viewer.entities.remove(e);
    entities = [];
    positions = [];
    _setResult("—");
  }

  function _stop() {
    if (handler) {
      handler.destroy();
      handler = null;
    }
    activeTool = null;
    document.querySelectorAll('.tool-row button[data-tool]').forEach(b => b.classList.remove('active'));
  }

  function _start(tool) {
    if (!viewer) return;
    _stop();
    clearAll();
    activeTool = tool;
    document.querySelector(`.tool-row button[data-tool="${tool}"]`)?.classList.add('active');

    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((click) => {
      const cartesian = viewer.scene.pickPosition(click.position) ||
                        viewer.camera.pickEllipsoid(click.position, viewer.scene.globe.ellipsoid);
      if (!cartesian) return;
      positions.push(cartesian);

      const dot = viewer.entities.add({
        position: cartesian,
        point: { pixelSize: 8, color: Cesium.Color.YELLOW,
                 outlineColor: Cesium.Color.BLACK, outlineWidth: 1,
                 disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      entities.push(dot);

      if (tool === "distance") _updateDistance();
      else if (tool === "area") _updateArea();
      else if (tool === "height") _updateHeight();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // sağ tık -> bitir
    handler.setInputAction(() => _stop(), Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  }

  // ---- Mesafe ----
  function _updateDistance() {
    if (positions.length < 2) {
      _setResult("Mesafe için 2+ nokta tıkla, sağ tık ile bitir");
      return;
    }
    let total = 0;
    for (let i = 1; i < positions.length; i++) {
      total += Cesium.Cartesian3.distance(positions[i-1], positions[i]);
    }
    // çizgi entity'si — sürekli güncellensin
    if (!entities._line) {
      entities._line = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => positions, false),
          width: 2, material: Cesium.Color.YELLOW, clampToGround: true,
        },
      });
      entities.push(entities._line);
    }
    _setResult(`Mesafe: ${_fmtMeters(total)}`);
  }

  // ---- Alan ----
  function _updateArea() {
    if (positions.length < 3) {
      _setResult("Alan için 3+ nokta tıkla, sağ tık ile bitir");
      return;
    }
    if (!entities._poly) {
      entities._poly = viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.CallbackProperty(
            () => new Cesium.PolygonHierarchy(positions), false),
          material: Cesium.Color.YELLOW.withAlpha(0.3),
          outline: true, outlineColor: Cesium.Color.YELLOW,
        },
      });
      entities.push(entities._poly);
    }
    const area = _polygonAreaSqMeters(positions);
    _setResult(`Alan: ${_fmtSqMeters(area)}`);
  }

  // ---- Yükseklik (iki nokta arası dikey fark) ----
  function _updateHeight() {
    if (positions.length < 2) {
      _setResult("Yükseklik için 2 nokta tıkla (alt ve üst)");
      return;
    }
    const a = Cesium.Cartographic.fromCartesian(positions[0]);
    const b = Cesium.Cartographic.fromCartesian(positions[positions.length - 1]);
    const dh = Math.abs(b.height - a.height);
    _setResult(`Yükseklik farkı: ${dh.toFixed(2)} m`);
  }

  // ---- Yardımcılar ----
  function _fmtMeters(m) {
    return m >= 1000 ? `${(m/1000).toFixed(3)} km` : `${m.toFixed(2)} m`;
  }
  function _fmtSqMeters(a) {
    return a >= 10000 ? `${(a/10000).toFixed(3)} ha` : `${a.toFixed(2)} m²`;
  }

  // Küresel poligon alanı için spherical excess yaklaşımı.
  // Küçük alanlar için yeterince doğru.
  function _polygonAreaSqMeters(cartesians) {
    const R = 6378137.0;
    const points = cartesians.map(c => {
      const carto = Cesium.Cartographic.fromCartesian(c);
      return [carto.longitude, carto.latitude];
    });
    if (points.length < 3) return 0;
    let total = 0;
    for (let i = 0; i < points.length; i++) {
      const [lon1, lat1] = points[i];
      const [lon2, lat2] = points[(i + 1) % points.length];
      total += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
    }
    return Math.abs(total * R * R / 2.0);
  }

  function bind() {
    document.querySelectorAll('.tool-row button[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (tool === 'clear') { _stop(); clearAll(); return; }
        if (activeTool === tool) { _stop(); _setResult("Ölçüm kapatıldı"); return; }
        _start(tool);
        _setResult(`Mod: ${tool}. Sol tık nokta ekler, sağ tık bitirir.`);
      });
    });
  }

  return { init, bind, clearAll };
})();
