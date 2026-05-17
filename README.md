# Sektörel Cesium — Drone Ortofoto Arayüzü

Drone fotoğraflarını **NodeODM** ile ortofotoya / 3D Tile'a çevirip
**CesiumJS** üzerinde 3 boyutlu olarak gösteren web arayüzü.


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

Cesium ion token şu anda frontend tarafında gömülü. Repo paylasiminda ekstra tekrardan bir token almaya gerek kalmadan kullanma rahatlığı için. Token olmadan da local ornek ortofoto ve 3D Tiles acilir; sadece
**Cesium World Terrain** ve **OSM Buildings** gibi ion bagimli katmanlar
devre disi kalir.

Tokeni değiştirmek istenirse frontend tarafında js klasörü içerisinde app.js dosyası içerisinde 28.ci satırda const CESIUM_ION_TOKEN = "TOKEN" ile başlayan kısımda tırnak içerisindeki yeri değiştirmeniz yeter .

### 2) NodeODM'i Docker'da başlat

#### GPU'lu Docker icin Windows / WSL 2 notu

Bu repodaki `nodeodm` servisi varsayilan olarak **GPU'lu** image kullanir.
Windows'ta GPU ile calistirmak icin asagidaki ortam gerekli:

- WSL 2 kurulu ve guncel olmali eğer docker desktop kullanıyorsanız Windows üzerinde 
- Eğer linux üzerinde çalışıyorsa zaten bir sorun olmamalı
- Docker yml içerisinde zaten 3000 portunda başlıyacak şekilde ayarlı 

Kontrol komutlari:

```bash
docker compose up 
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

1. Sol panelden **+ Yeni** → Proje türünü seç ve drone fotoğraflarını seç (en az 5 tane).
2. Projenin ne olduğuna göre içerisindeki kartlar değişir şantiye tarafında ölçüm aletleri  olur müze tarafında ise sunum alanı gibi ve sunum alanını anlatan kartların dizilimi ve     sunum modu olur 
3. Görev NodeODM'e gönderilir; sol listede **QUEUED → RUNNING → COMPLETED**
   olarak ilerler. (Liste 10 saniyede bir tazelenir.)
4. **COMPLETED** olduğunda göreve tıkla → "Çıktıları indir" → ortofoto +
   3D Tiles otomatik viewer'a düşer.
5. Sağ panelden katmanları aç/kapat, ortofoto opaklığını ayarla.
6. **Şantiye tarafı ölçüm araçları**:
   - *Mesafe* — ardışık iki+ noktaya tıkla, sağ tık ile bitir.
   - *Alan* — kapalı poligon için en az 3 nokta.
   - *Yükseklik* — alt ve üst noktayı tıkla, dikey fark çıkar.
   - *Temizle* — tüm çizimleri siler.
7. **Müze tarafı sunum araçları**:
   - *Sunum Modunu Başlat* — müze projesi için hazırlanan sunum akışını açar.
   - *Sunum Modu Ayarları* — kartların sırasını, yerleşimini ve görünümünü düzenler.
   - *Kart Düzeni* — başlık, açıklama ve içerik kartlarını sahne üzerinde konumlandırmanı sağlar.
   - *Kamera Akışı* — model etrafındaki dönüş yönünü, başlangıç açısını, eğimi ve hızını ayarlarsın.
   - *Otomatik Geçiş* — kartların ne kadar sürede değişeceğini belirlersin.
   - *Canlı Preview* — yapılan sunum ayarlarını kaydetmeden önce önizleme yapmanı sağlar.

---

## Ek Notlar

- Backend ve frontend aynı port üzerinden servis edilir (`8000`).
  CORS ayarı zaten `*` olarak açık olduğu için frontend'i ayrı bir
  geliştirme sunucunda çalıştırabilirsin (örn. `python -m http.server`).
- ODM çıktıları `data/outputs/<uuid>/` altında saklanır ve FastAPI
  bunları `/data/outputs/...` URL'siyle statik servis eder. uuıd burada random bir id'yi temsil ediyor çıkan id okunup çıkan .glb dosyası içerisindeki CESIUM_RTC ve RTC_CENTER verisi içerisindeki dönüşüm matrisleri okunur ve Wgs84 elipsoid'i üzerinde doğru matrislere oturtulur yaklaşık olarak %90 gibi bir tam oturma ölçeği var biraz yükseklik farkı haricinde ortofoto ile tileset uyuşarak oturuyor
- Django mimarisi yerine uvicorn seçildi daha da guvicorn yerine daha performanslı olacağına karar verildi
- Eğer NodeODM içerisinden çıkan veri tam olarak doğru tileset.json dosyasını çıkarmama gibi bir durum vardı bu yüzden çıkan output artık bir .glb dosyası olarak çıkıyor ve içerisindeki veri okunuyor bu yüzden fallback olan py3dtiles kısmı halen daha var ama iş akışı içerisinde gerek duyulmadan sonucu veriyor.
- Ana iş akışını sağlayan dosya nodeODM için task oluşturan ardından içerisinden çıkan all.zip'i data içerisinde uuid içerisine açar ortofotoyu oluşturur onun içerisinden 3D tiles üretir ve bbox konumlarını yani sınır konumlarını hesaplar cesium da flyto sırasında direk alana oturması için viewer kameranın
- Frontend tarafındaki ana iş akışının olduğu js dosyası viewer.js dosyası içerisinde cesium viewer'ı cağırır 3D tiles'lar seçili projeye göre yükler flyto animasyonlarını tetikler 3D modeli düzenlemek için kullanılan tileset adjustment ve sunum tarafı için olan orbit kontrolü
