/* CesiumJS viewer kurulumu + katman yönetimi.
 * Global: window.AppViewer
 *   .init(token)        -> Cesium.Viewer döner
 *   .loadOrthophoto(url, taskUuid)
 *   .removeOrthophoto(taskUuid)
 *   .loadTileset(url, taskUuid)
 *   .removeTileset(taskUuid)
 *   .toggleOsmBuildings(on)
 *   .setOrthoOpacity(value)
 *   .setProjectBounds(taskUuid, bbox)
 *   .flyTo(taskUuid)
 */
window.AppViewer = (() => {
  let viewer = null;
  const orthophotoLayers = new Map();   // uuid -> ImageryLayer
  const tilesets         = new Map();   // uuid -> Cesium.Cesium3DTileset
  const lastBoundingSphere = new Map(); // uuid -> Cesium.BoundingSphere
  let osmBuildings = null;

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
        pitch:   Cesium.Math.toRadians(-65),
        roll:    0,
      },
    });
    // Sonra yumuşak bir uçuş ile Türkiye'ye odaklan
    setTimeout(() => {
      viewer.camera.flyTo({
        destination: turkey,
        duration: 2.5,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      });
    }, 400);

    // Cesium varsayılan çalışma alanı = Türkiye sınırları
    Cesium.Camera.DEFAULT_VIEW_RECTANGLE = turkey;
    // Home butonuna basıldığında Türkiye'ye dön
    viewer.homeButton?.viewModel?.command.beforeExecute.addEventListener((e) => {
      e.cancel = true;
      viewer.camera.flyTo({destination: turkey, duration: 1.5});
    });

    return viewer;
  }

  function getViewer() { return viewer; }

  // ---------------------------------------------------------------- Ortofoto
  async function loadOrthophoto(source, uuid) {
    if (!viewer) throw new Error("Viewer henüz init edilmedi");
    removeOrthophoto(uuid);

    const url = typeof source === "string" ? source : source?.url;
    const previewUrl = typeof source === "object" ? source?.preview_url : null;
    const bbox = typeof source === "object" ? source?.bbox : null;
    if (!url) throw new Error("Ortofoto URL bulunamadi");

    // GeoTIFF tarayıcıda doğrudan render edilemez. Pratik yol:
    //   1) NodeODM çıktısında orthophoto_tiles/ TMS pyramid varsa onu yükle
    //   2) Yoksa georeferenced preview varsa tek görsel olarak yükle
    //   3) Yoksa kullanıcıyı uyar (Cesium ion'a manuel yükleme gerekir)
    const tmsUrl = url.replace(/orthophoto\.tif$/, "orthophoto_tiles");
    let provider = null;
    try {
      const head = await fetch(tmsUrl + "/tilemapresource.xml", {method: "HEAD"});
      if (head.ok) {
        provider = await Cesium.TileMapServiceImageryProvider.fromUrl(tmsUrl);
      }
    } catch (_) { /* yoksay */ }

    if (!provider && previewUrl && Array.isArray(bbox) && bbox.length === 4) {
      const rectangle = Cesium.Rectangle.fromDegrees(...bbox.map(Number));
      provider = await Cesium.SingleTileImageryProvider.fromUrl(previewUrl, {rectangle});
    }

    if (!provider) {
      console.warn(
        "Ortofoto preview bulunamadi. " +
        "GeoTIFF'i Cesium ion'a yükleyip asset id ile çağırmak gerek. " +
        "Manuel indirme: " + url
      );
      return null;
    }

    const layer = viewer.imageryLayers.addImageryProvider(provider);
    orthophotoLayers.set(uuid, layer);

    if (provider.rectangle) {
      lastBoundingSphere.set(
        uuid,
        Cesium.BoundingSphere.fromRectangle3D(provider.rectangle)
      );
    }
    return layer;
  }

  function removeOrthophoto(uuid) {
    const layer = orthophotoLayers.get(uuid);
    if (layer) {
      viewer.imageryLayers.remove(layer, true);
      orthophotoLayers.delete(uuid);
    }
  }

  function setOrthoOpacity(value) {
    for (const layer of orthophotoLayers.values()) {
      layer.alpha = Number(value);
    }
  }

  function setOrthoVisibility(on) {
    for (const layer of orthophotoLayers.values()) {
      layer.show = !!on;
    }
  }

  // -------------------------------------------------------------- 3D Tiles
  async function loadTileset(url, uuid) {
    if (!viewer) throw new Error("Viewer henüz init edilmedi");
    removeTileset(uuid);

    const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
      maximumScreenSpaceError: 16,
    });
    viewer.scene.primitives.add(tileset);
    tilesets.set(uuid, tileset);
    lastBoundingSphere.set(uuid, tileset.boundingSphere);
    return tileset;
  }

  function removeTileset(uuid) {
    const t = tilesets.get(uuid);
    if (t) {
      viewer.scene.primitives.remove(t);
      tilesets.delete(uuid);
    }
  }
  function setTilesetVisibility(on) {
    for (const t of tilesets.values()) t.show = !!on;
  }

  // ------------------------------------------------------------- OSM buildings
  async function toggleOsmBuildings(on) {
    if (!viewer) return;
    if (on && !osmBuildings) {
      try {
        osmBuildings = await Cesium.createOsmBuildingsAsync();
        viewer.scene.primitives.add(osmBuildings);
      } catch (e) {
        console.warn("OSM buildings yüklenemedi (Cesium ion token gerekir):", e);
      }
    } else if (osmBuildings) {
      osmBuildings.show = !!on;
    }
  }

  function setProjectBounds(uuid, bbox) {
    if (!viewer || !Array.isArray(bbox) || bbox.length !== 4) return;
    const [west, south, east, north] = bbox.map(Number);
    if ([west, south, east, north].some(Number.isNaN)) return;
    const rectangle = Cesium.Rectangle.fromDegrees(west, south, east, north);
    lastBoundingSphere.set(uuid, Cesium.BoundingSphere.fromRectangle3D(rectangle));
  }

  // ------------------------------------------------------------- Fly-to
  function flyTo(uuid) {
    const bs = lastBoundingSphere.get(uuid);
    if (bs) {
      viewer.camera.flyToBoundingSphere(bs, {duration: 1.5});
      return true;
    }
    const t = tilesets.get(uuid);
    if (t) {
      viewer.flyTo(t);
      return true;
    }
    return false;
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
    setTilesetVisibility,
    toggleOsmBuildings,
    setProjectBounds,
    flyTo,
  };
})();
