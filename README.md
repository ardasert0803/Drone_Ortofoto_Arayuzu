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
                                            |  - /api/health, /config      |
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
├── .env.example
├── .gitignore
└── README.md
```

---

## Kurulum

### 1) Cesium ion token al

[https://cesium.com/ion/tokens](https://cesium.com/ion/tokens) adresinden
ücretsiz bir hesap aç, "default" token'ı kopyala.

### 2) `.env` dosyasını oluştur

```bash
cp .env.example .env
# .env dosyasını aç, CESIUM_ION_TOKEN değerini yaz
```

### 3) NodeODM'i Docker'da başlat

```bash
cd docker
docker compose up -d
docker compose ps           # sc-nodeodm running olmalı
curl http://localhost:3000/info   # NodeODM cevap veriyor mu?
```

> **Not (eski Django mimarisinden geçiş):** Orijinal projende Docker
> Compose'ta `db` (postgis), `redis`, `web`, `celery_worker`, `celery_beat`
> servisleri vardı. Bu mimaride bunlara ihtiyaç yok:
> - **db / redis / celery** → SQLite + FastAPI'nin `BackgroundTasks`'i
>   yetiyor (uzun işin kendisini zaten NodeODM yapıyor).
> - **web** → FastAPI yerelde `uvicorn` ile koşuyor, Docker'a girmiyor.
>
> Sadece `nodeodm` kaldı. İstersen `py3dtiles` aracını da
> `docker compose --profile tools run --rm py3dtiles ...` ile çağırabilirsin.

> **GPU notu:** Image `opendronemap/nodeodm:gpu` — yani nvidia GPU
> destekli sürüm. Gereksinim:
> - Windows + Docker Desktop için: WSL2 + en güncel nvidia driver +
>   Docker Desktop Settings → Resources → "Enable GPU" açık.
> - GPU yoksa `docker-compose.yml` içinde imajı `opendronemap/nodeodm:latest`
>   yap ve `deploy:` blokunu sil. CPU'da çok daha yavaş işler ama çalışır.

### 4) Python ortamı ve bağımlılıklar

```bash
cd ../backend
python -m venv .venv

# Windows
.venv\Scripts\activate
# Linux/macOS
source .venv/bin/activate

pip install -r requirements.txt
```

### 5) FastAPI'yi çalıştır

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
