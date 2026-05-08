/* Cesium üzerinde şantiye ölçüm araçları.
 * Çoklu ölçüm: her yeni araç önceki tamamlanmış ölçümleri silmez.
 * "Temizle" tuşu tüm ölçümleri kaldırır.
 */
window.AppMeasure = (() => {
  let viewer = null;
  let resultEl = null;
  let copyBtn = null;

  // Tamamlanmış ölçümler (entities'leri viewer'da yaşıyor)
  let completedEntities = [];

  // Aktif (devam eden) ölçüm state'i
  let active = _freshActive();

  function _freshActive() {
    return { tool: null, entities: [], positions: [], _line: null, _poly: null };
  }

  const MARKER_COLOR     = Cesium.Color.fromCssColorString("#f59e0b");
  const LINE_COLOR       = Cesium.Color.fromCssColorString("#f59e0b");
  const POLY_FILL        = Cesium.Color.fromCssColorString("#f59e0b").withAlpha(0.22);
  const LABEL_BG         = Cesium.Color.fromCssColorString("#92400e").withAlpha(0.90);

  function init(_viewer) {
    viewer = _viewer;
    resultEl = document.getElementById("measurement-result");
    copyBtn  = document.getElementById("btn-copy-measurement");
  }

  function _setResult(text, copyText) {
    if (resultEl) resultEl.textContent = text;
    if (copyBtn) {
      if (copyText) {
        copyBtn.hidden = false;
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(copyText).then(() => {
            if (window.AppToast) AppToast.show("Kopyalandı", { tone: "success", duration: 1500 });
          }).catch(() => {});
        };
      } else {
        copyBtn.hidden = true;
      }
    }
  }

  function clearAll() {
    if (active.handler) { active.handler.destroy(); active.handler = null; }
    for (const e of completedEntities) { try { viewer.entities.remove(e); } catch {} }
    for (const e of active.entities)   { try { viewer.entities.remove(e); } catch {} }
    completedEntities = [];
    active = _freshActive();
    document.querySelectorAll('button[data-tool]').forEach(b => b.classList.remove('active'));
    if (resultEl) resultEl.classList.remove('recording');
    _setResult("—");
  }

  function _commitActive() {
    if (!active.tool || active.positions.length === 0) return;
    completedEntities.push(...active.entities);
    active = _freshActive();
  }

  function _stop() {
    if (active.handler) {
      active.handler.destroy();
      active.handler = null;
    }
    _addCompletionLabel();
    _commitActive();
    document.querySelectorAll('button[data-tool]').forEach(b => b.classList.remove('active'));
    if (resultEl) resultEl.classList.remove('recording');
  }

  function _addCompletionLabel() {
    if (!active.tool || active.positions.length === 0) return;
    const text = resultEl ? resultEl.textContent : "";
    if (!text || text === "—") return;
    const midpoint = _midpoint(active.positions, active.tool);
    if (!midpoint) return;
    const label = viewer.entities.add({
      position: midpoint,
      label: {
        text,
        font: "bold 13px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -12),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        backgroundEnabled: true,
        backgroundColor: LABEL_BG,
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        heightReference: Cesium.HeightReference.NONE,
      },
    });
    active.entities.push(label);
  }

  function _midpoint(positions, tool) {
    if (!positions.length) return null;
    if (positions.length === 1) return positions[0];
    if (tool === "area") {
      const sum = positions.reduce(
        (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }),
        { x: 0, y: 0, z: 0 }
      );
      return new Cesium.Cartesian3(sum.x / positions.length, sum.y / positions.length, sum.z / positions.length);
    }
    const mid = Math.floor((positions.length - 1) / 2);
    return positions[mid];
  }

  function _start(tool) {
    if (!viewer) return;
    // Önceki aktif ölçümü tamamla (silmeden koru)
    if (active.handler) { active.handler.destroy(); active.handler = null; }
    _commitActive();

    active = _freshActive();
    active.tool = tool;
    document.querySelector(`button[data-tool="${tool}"]`)?.classList.add('active');
    if (resultEl) resultEl.classList.add('recording');

    active.handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    active.handler.setInputAction((click) => {
      const cartesian = viewer.scene.pickPosition(click.position) ||
                        viewer.camera.pickEllipsoid(click.position, viewer.scene.globe.ellipsoid);
      if (!cartesian) return;
      active.positions.push(cartesian);

      const dot = viewer.entities.add({
        position: cartesian,
        point: {
          pixelSize: 10,
          color: MARKER_COLOR,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      active.entities.push(dot);

      if (tool === "distance")   _updateDistance();
      else if (tool === "area")  _updateArea();
      else if (tool === "height") _updateHeight();
      else if (tool === "slope") _updateSlope();
      else if (tool === "coordinate") _updateCoordinate();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    active.handler.setInputAction(() => {
      _stop();
      _setResult(resultEl ? resultEl.textContent : "—");
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  }

  // ---- Mesafe ----
  function _updateDistance() {
    if (active.positions.length < 2) {
      _setResult("Mesafe için 2+ nokta tıkla, sağ tık bitir");
      return;
    }
    let total = 0;
    for (let i = 1; i < active.positions.length; i++) {
      total += Cesium.Cartesian3.distance(active.positions[i - 1], active.positions[i]);
    }
    if (!active._line) {
      active._line = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => active.positions, false),
          width: 3,
          material: LINE_COLOR,
          clampToGround: true,
        },
      });
      active.entities.push(active._line);
    }
    _setResult(`Mesafe: ${_fmtMeters(total)}`);
  }

  // ---- Alan ----
  function _updateArea() {
    if (active.positions.length < 3) {
      _setResult("Alan için 3+ nokta tıkla, sağ tık bitir");
      return;
    }
    if (!active._poly) {
      active._poly = viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.CallbackProperty(
            () => new Cesium.PolygonHierarchy(active.positions), false),
          material: POLY_FILL,
          outline: true,
          outlineColor: LINE_COLOR,
          outlineWidth: 2,
        },
      });
      active.entities.push(active._poly);
    }
    const area = _polygonAreaSqMeters(active.positions);
    _setResult(`Alan: ${_fmtSqMeters(area)}`);
  }

  // ---- Yükseklik ----
  function _updateHeight() {
    if (active.positions.length < 2) {
      _setResult("Yükseklik için 2 nokta tıkla (alt · üst)");
      return;
    }
    const a = Cesium.Cartographic.fromCartesian(active.positions[0]);
    const b = Cesium.Cartographic.fromCartesian(active.positions[active.positions.length - 1]);
    const dh = Math.abs(b.height - a.height);
    _setResult(`Yükseklik farkı: ${dh.toFixed(2)} m`);
  }

  // ---- Eğim ----
  function _updateSlope() {
    if (active.positions.length < 2) {
      _setResult("Eğim için 2 nokta tıkla");
      return;
    }
    const a = Cesium.Cartographic.fromCartesian(active.positions[0]);
    const b = Cesium.Cartographic.fromCartesian(active.positions[active.positions.length - 1]);
    const pA = Cesium.Cartesian3.fromRadians(a.longitude, a.latitude, 0);
    const pB = Cesium.Cartesian3.fromRadians(b.longitude, b.latitude, 0);
    const horiz = Cesium.Cartesian3.distance(pA, pB);
    const vert  = Math.abs(b.height - a.height);

    if (!active._line) {
      active._line = viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(() => active.positions, false),
          width: 3,
          material: LINE_COLOR,
          clampToGround: false,
        },
      });
      active.entities.push(active._line);
    }

    if (horiz < 0.01) {
      _setResult(`Yükseklik farkı: ${vert.toFixed(2)} m\n(Yatay mesafe sıfıra yakın)`);
      return;
    }
    const rad  = Math.atan2(vert, horiz);
    const deg  = (rad * 180 / Math.PI).toFixed(1);
    const pct  = (Math.tan(rad) * 100).toFixed(1);
    const result = `Eğim: ${deg}° / %${pct}\nYatay: ${_fmtMeters(horiz)}  Düşey: ${vert.toFixed(2)} m`;
    _setResult(result, result);
  }

  // ---- Koordinat ----
  function _updateCoordinate() {
    if (active.positions.length < 1) {
      _setResult("Koordinat için 1 nokta tıkla");
      return;
    }
    const pos   = active.positions[active.positions.length - 1];
    const carto = Cesium.Cartographic.fromCartesian(pos);
    const lon = Cesium.Math.toDegrees(carto.longitude).toFixed(6);
    const lat = Cesium.Math.toDegrees(carto.latitude).toFixed(6);
    const alt = carto.height.toFixed(2);
    const result = `Enlem:     ${lat}°\nBoylam:    ${lon}°\nYükseklik: ${alt} m`;
    _setResult(result, `${lat}, ${lon}, ${alt}`);
  }

  // ---- Yardımcılar ----
  function _fmtMeters(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(3)} km` : `${m.toFixed(2)} m`;
  }
  function _fmtSqMeters(a) {
    return a >= 10000 ? `${(a / 10000).toFixed(3)} ha` : `${a.toFixed(2)} m²`;
  }

  function _polygonAreaSqMeters(cartesians) {
    const R = 6378137.0;
    const pts = cartesians.map(c => {
      const carto = Cesium.Cartographic.fromCartesian(c);
      return [carto.longitude, carto.latitude];
    });
    if (pts.length < 3) return 0;
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      const [lon1, lat1] = pts[i];
      const [lon2, lat2] = pts[(i + 1) % pts.length];
      total += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
    }
    return Math.abs(total * R * R / 2.0);
  }

  function bind() {
    document.querySelectorAll('#panel-measurement button[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (tool === 'clear') {
          _stop();
          clearAll();
          return;
        }
        if (active.tool === tool) {
          _stop();
          return;
        }
        _start(tool);
        const hints = {
          distance:   "Sol tık nokta ekler · sağ tık ölçümü tamamlar",
          area:       "3+ nokta seç · sağ tık poligonu kapatır",
          height:     "Alt noktayı, sonra üst noktayı tıkla",
          slope:      "İki nokta tıkla · eğim ve yüzde hesaplanır",
          coordinate: "Bir nokta tıkla · koordinat gösterilir",
        };
        _setResult(hints[tool] || "");
      });
    });
  }

  return { init, bind, clearAll };
})();
