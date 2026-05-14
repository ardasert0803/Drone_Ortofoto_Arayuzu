# Sektörel Cesium — Drone Ortofoto Arayüzü

Drone fotoğraflarını **NodeODM** ile ortofotoya / 3D Tile'a çevirip
**CesiumJS** üzerinde 3 boyutlu olarak gösteren web arayüzü.

PDF'teki proje kapsamından farkı: **web tarafı (FastAPI) Docker'da koşmuyor**.
Yerelde `uvicorn` ile çalışır, sadece ağır iş yapan **NodeODM** ve opsiyonel
**py3dtiles** container'ları Docker üzerinden gider.

---

## Mimari

```
+---------------------+        REST         +-----------------------------+
|  Tarayıcı (Cesium)  |  <───────────────►  |  FastAPI (yerelde, port 8000)|
+---------------------+   /api/tasks vs.    |  - /api/tasks (CRUD)         |
                                            |  - /api/health               |
                                            |  - /data/outputs/* statik    |
                                            +──────────────┬───────────────+
                                                           │ HTTP (NodeODM REST)
                                                           ▼
                                            +-----------------------------+
                                            |  NodeODM (Docker, port 3000)|
                                            |  opendronemap/nodeodm       |
                                            +-----------------------------+
```

---

## Klasör yapısı

```
SektörelCesium/
├── backend/                # FastAPI uygulaması (yerelde koşar)
│   ├── main.py
│   ├── config.py
│   ├── nodeodm_client.py
│   ├── requirements.txt
│   └── routers/
│       ├── health.py
│       └── tasks.py
├── frontend/               # Cesium SPA — static (FastAPI servis eder)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── api.js
│       ├── viewer.js
│       ├── measurement.js
│       ├── upload.js
│       └── app.js
├── docker/
│   └── docker-compose.yml  # NodeODM + (opsiyonel) py3dtiles
├── data/
│   ├── uploads/            # Yüklenen drone fotoları (yerel kopya)
│   ├── outputs/            # NodeODM'den indirilen ortofoto/3D tiles
│   └── tiles/              # Manuel py3dtiles dönüşümleri
├── .gitignore
└── README.md
```

---

## Kurulum

### 1) Cesium ion token notu

Cesium ion token **opsiyoneldir**. Repo paylasiminda guvenlik icin bos
birakildi. Token olmadan da local ornek ortofoto ve 3D Tiles acilir; sadece
**Cesium World Terrain** ve **OSM Buildings** gibi ion bagimli katmanlar
devre disi kalir.

Token kullanmak istersen `.env` icindeki `CESIUM_ION_TOKEN` alanini doldurup
frontend tarafinda `frontend/js/app.js` icindeki sabiti kendi tokeninla guncelle.

### 2) NodeODM'i Docker'da başlat

#### GPU'lu Docker icin Windows / WSL 2 notu

Bu repodaki `nodeodm` servisi varsayilan olarak **GPU'lu** image kullanir.
Windows'ta GPU ile calistirmak icin asagidaki ortam gerekli:

- **WSL 2** kurulu ve guncel olmali
- **Docker Desktop** `WSL 2 based engine` ile calismali
- Docker Desktop'ta ilgili Linux dagitimi icin **WSL Integration** acik olmali
- NVIDIA ekran karti ve **WSL 2 destekli guncel NVIDIA driver** kurulu olmali
- Docker Desktop tarafinda GPU destegi acik olmali

Kontrol komutlari:

```bash
wsl --status
wsl --update
docker compose version
docker info


```bash
cd docker
docker compose up -d
docker compose ps           # sc-nodeodm running olmalı
curl http://localhost:3000/info   # NodeODM cevap veriyor mu?
```
### 3) Python ortamı ve bağımlılıklar

```bash
cd ../backend
python -m venv .venv

# Windows
.venv\Scripts\activate
# Linux/macOS
source .venv/bin/activate

pip install -r requirements.txt
```

### 4) FastAPI'yi çalıştır

```bash
# backend/ içindeyken
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Tarayıcıda aç: <http://localhost:8000>

---

## Kullanım akışı

1. Sol panelden **+ Yeni** → drone fotoğraflarını seç (en az 5 tane).
2. Görev NodeODM'e gönderilir; sol listede **QUEUED → RUNNING → COMPLETED**
   olarak ilerler. (Liste 10 saniyede bir tazelenir.)
3. **COMPLETED** olduğunda göreve tıkla → "Çıktıları indir" → ortofoto +
   3D Tiles otomatik viewer'a düşer.
4. Sağ panelden katmanları aç/kapat, ortofoto opaklığını ayarla.
5. **Ölçüm araçları**:
   - *Mesafe* — ardışık iki+ noktaya tıkla, sağ tık ile bitir.
   - *Alan* — kapalı poligon için en az 3 nokta.
   - *Yükseklik* — alt ve üst noktayı tıkla, dikey fark çıkar.
   - *Temizle* — tüm çizimleri siler.

---

## NodeODM ipuçları

- 5'ten az fotoğraf ile genelde başarısız olur. Bina/şantiye için
  **40–80%** overlap'li 30+ foto öner.
- 3D Tiles üretimi için NodeODM komut satırında `--3d-tiles` desteklenir
  (opsiyon `tasks.py` içinde geçilir).
- Geri uyumluluk için orthophoto pyramid pyramid (TMS) yoksa, GeoTIFF'i
  Cesium'a düşürmek için Cesium ion'a manuel asset olarak yükleyip
  asset id ile çağırabilirsin. (Şu an `viewer.js` TMS'yi otomatik dener.)

---

## Geliştirici notları

- Backend ve frontend aynı port üzerinden servis edilir (`8000`).
  CORS ayarı zaten `*` olarak açık olduğu için frontend'i ayrı bir
  geliştirme sunucusunda çalıştırabilirsin (örn. `python -m http.server`).
- ODM çıktıları `data/outputs/<uuid>/` altında saklanır ve FastAPI
  bunları `/data/outputs/...` URL'siyle statik servis eder.
- `nodeodm_client.py` `httpx.AsyncClient` ile konuşur — yeni endpoint
  eklemek istersen tek dosyayı düzenle.
