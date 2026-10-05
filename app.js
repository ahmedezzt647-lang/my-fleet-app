const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// إنشاء وتجهيز قاعدة البيانات SQLite
const db = new sqlite3.Database('./fleet_telemetry.db', (err) => {
    if (err) console.error('خطأ في قاعدة البيانات:', err.message);
    else console.log('📁 تم الاتصال بقاعدة البيانات SQLite بنجاح');
});

db.run(`CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceId TEXT,
    plate TEXT,
    lat REAL,
    lng REAL,
    speed REAL,
    ignition INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const fleetState = {};
const colorPalette = ['#10b981', '#38bdf8', '#f97316', '#a855f7', '#ec4899'];

app.post('/api/simulate-telemetry', (req, res) => {
    const { deviceId, lat, lng, speed, ignition, plate } = req.body;
    if (!deviceId || lat === undefined || lng === undefined) {
        return res.status(400).json({ error: 'Missing deviceId, lat, or lng' });
    }
// مسار استقبال بيانات أجهزة Teltonika الحقيقية
app.post('/api/gps-telemetry', (req, res) => {
  const data = req.body;

  const deviceId = data.imei || data.deviceId || 'TELTONIKA-01';
  const plate = data.plate || 'تتبع حي';
  const lat = parseFloat(data.lat);
  const lng = parseFloat(data.lng);
  const speed = parseInt(data.speed) || 0;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'إحداثيات غير صالحة' });
  }

  const payload = {
    deviceId,
    plate,
    lat,
    lng,
    speed,
    ignition: data.ignition !== undefined ? data.ignition : true,
    timestamp: new Date()
  };

  console.log(`📡 تم استقبال موقع جديد من الجهاز [${deviceId}]:`, payload);
  res.status(200).send('OK');
});
    

    if (!fleetState[deviceId]) {
        fleetState[deviceId] = {
            deviceId,
            plate: plate || deviceId,
            lat,
            lng,
            speed: speed || 0,
            ignition: ignition !== undefined ? ignition : true,
            maxSpeed: speed || 0,
            speedHistory: [],
            timestamps: [],
            speedingCount: 0,
            lastUpdate: new Date()
        };
    }

    const v = fleetState[deviceId];
    v.lat = lat;
    v.lng = lng;
    v.speed = speed || 0;
    v.ignition = ignition !== undefined ? ignition : true;
    v.lastUpdate = new Date();

    if (v.speed > v.maxSpeed) v.maxSpeed = v.speed;
    if (v.speed > 60) v.speedingCount++;

    const timeStr = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    v.speedHistory.push(v.speed);
    v.timestamps.push(timeStr);

    if (v.speedHistory.length > 15) {
        v.speedHistory.shift();
        v.timestamps.shift();
    }

    // حفظ القراءة في قاعدة البيانات
    db.run(
        `INSERT INTO telemetry (deviceId, plate, lat, lng, speed, ignition) VALUES (?, ?, ?, ?, ?, ?)`,
        [deviceId, v.plate, lat, lng, v.speed, v.ignition ? 1 : 0]
    );

    broadcastToClients({ type: 'TELEMETRY_UPDATE', data: v });
    res.json({ status: 'success', vehicle: v });
});

app.get('/api/vehicles', (req, res) => {
    res.json(Object.values(fleetState));
});

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>شاشة تتبع السيارات والتقارير - متجاوبة</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: row; height: 100vh; background: #0f172a; overflow: hidden; }
        #map { flex: 1; height: 100%; width: 100%; }
        #sidebar { width: 360px; background: #1e293b; color: #fff; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; border-left: 1px solid #334155; z-index: 1000; }
        
        .search-box { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; margin-bottom: 12px; font-size: 14px; outline: none; }
        .search-box:focus { border-color: #38bdf8; }
        .stats-panel { display: flex; gap: 8px; margin-bottom: 12px; }
        .stat-box { flex: 1; background: #0f172a; padding: 8px; border-radius: 6px; text-align: center; border: 1px solid #334155; }
        .stat-num { font-size: 18px; font-weight: bold; }
        .stat-label { font-size: 11px; color: #94a3b8; }
        .card { background: #334155; padding: 12px; margin-bottom: 10px; border-radius: 8px; cursor: pointer; transition: transform 0.1s, background 0.2s; position: relative; overflow: hidden; }
        .card:hover { background: #475569; }
        .card.speeding { border: 1px solid #ef4444; background: #450a0a; }
        .card.selected { border: 2px solid #38bdf8; }
        .color-strip { position: absolute; top: 0; right: 0; bottom: 0; width: 6px; }
        .badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; background: #10b981; color: #fff; }
        .badge-speeding { background: #ef4444; animation: blink 1s infinite; }
        @keyframes blink { 50% { opacity: 0.5; } }
        .plate { font-weight: bold; font-size: 16px; color: #f8fafc; }
        
        #reportPanel { background: #0f172a; border-radius: 8px; padding: 12px; margin-top: 10px; border: 1px solid #38bdf8; display: none; }
        .report-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .report-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px; margin-bottom: 12px; }
        .report-item { background: #1e293b; padding: 8px; border-radius: 6px; }
        .report-val { font-weight: bold; font-size: 14px; color: #38bdf8; margin-top: 2px; }

        /* 📱 تصميم متجاوب للهواتف والأجهزة اللوحية (Responsive CSS) */
        @media (max-width: 768px) {
            body { flex-direction: column-reverse; }
            #sidebar { width: 100%; height: 45vh; border-left: none; border-top: 2px solid #334155; }
            #map { height: 55vh; }
        }
    </style>
</head>
<body>
    <div id="sidebar">
        <h3 style="margin-top: 5px; color: #f8fafc;">🏢 أسطول شركة الهوادج</h3>
        
        <div class="stats-panel">
            <div class="stat-box">
                <div id="totalCount" class="stat-num" style="color: #38bdf8;">0</div>
                <div class="stat-label">إجمالي الأسطول</div>
            </div>
            <div class="stat-box">
                <div id="speedingCount" class="stat-num" style="color: #ef4444;">0</div>
                <div class="stat-label">تجاوز السرعة</div>
            </div>
        </div>

        <input type="text" id="searchInput" class="search-box" placeholder="🔍 ابحث برقم اللوحة أو الكود..." oninput="renderSidebar()">
        
        <div id="reportPanel">
            <div class="report-header">
                <span id="reportTitle" style="font-weight: bold; color: #38bdf8;">تقرير الشاحنة</span>
                <button onclick="closeReport()" style="background: none; border: none; color: #ef4444; cursor: pointer; font-weight: bold;">✕</button>
            </div>
            <div class="report-grid">
                <div class="report-item">
                    <div style="color: #94a3b8;">أقصى سرعة</div>
                    <div id="repMaxSpeed" class="report-val">0 كم/س</div>
                </div>
                <div class="report-item">
                    <div style="color: #94a3b8;">التجاوزات</div>
                    <div id="repSpeedingCount" class="report-val" style="color: #ef4444;">0</div>
                </div>
            </div>
            <div style="height: 130px;">
                <canvas id="speedChart"></canvas>
            </div>
        </div>

        <div id="vehicleList" style="margin-top: 10px;">في انتظار البيانات...</div>
    </div>
    
    <div id="map"></div>

    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script>
        const map = L.map('map').setView([26.3800, 50.1100], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(map);

        const colorPalette = ['#10b981', '#38bdf8', '#f97316', '#a855f7', '#ec4899'];
        const markers = {};
        const polylines = {};
        const tracks = {};
        const vehicles = {};
        const vehicleColors = {};
        let selectedDeviceId = null;
        let chartInstance = null;

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(wsProtocol + '//' + window.location.host);

        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'INIT_FLEET') {
                message.data.forEach(v => updateVehicle(v));
            } else if (message.type === 'TELEMETRY_UPDATE') {
                updateVehicle(message.data);
            }
        };

        function getVehicleColor(id) {
            if (!vehicleColors[id]) {
                const index = Object.keys(vehicleColors).length % colorPalette.length;
                vehicleColors[id] = colorPalette[index];
            }
            return vehicleColors[id];
        }

        function updateVehicle(v) {
            vehicles[v.deviceId] = v;
            const latLng = [v.lat, v.lng];
            const color = getVehicleColor(v.deviceId);

            if (!tracks[v.deviceId]) {
                tracks[v.deviceId] = [];
                polylines[v.deviceId] = L.polyline([], {
                    color: color,
                    weight: 5,
                    opacity: 0.85
                }).addTo(map);
            }
            tracks[v.deviceId].push(latLng);
            polylines[v.deviceId].setLatLngs(tracks[v.deviceId]);

            if (!markers[v.deviceId]) {
                markers[v.deviceId] = L.marker(latLng).addTo(map)
                    .bindPopup('<b>السيارة: ' + v.plate + '</b><br>السرعة: ' + v.speed + ' كم/س');
            } else {
                markers[v.deviceId].setLatLng(latLng);
                markers[v.deviceId].setPopupContent('<b>السيارة: ' + v.plate + '</b><br>السرعة: ' + v.speed + ' كم/س');
            }

            if (selectedDeviceId === v.deviceId) {
                updateReportChart(v);
            }

            renderSidebar();
        }

        function selectVehicle(deviceId) {
            selectedDeviceId = deviceId;
            const v = vehicles[deviceId];
            if (!v) return;

            map.panTo([v.lat, v.lng]);
            map.setZoom(14);
            if (markers[deviceId]) markers[deviceId].openPopup();

            document.getElementById('reportPanel').style.display = 'block';
            document.getElementById('reportTitle').innerText = '📊 تقرير: ' + v.plate;
            document.getElementById('repMaxSpeed').innerText = v.maxSpeed + ' كم/س';
            document.getElementById('repSpeedingCount').innerText = v.speedingCount;

            initChart(v);
            renderSidebar();
        }

        function closeReport() {
            selectedDeviceId = null;
            document.getElementById('reportPanel').style.display = 'none';
            renderSidebar();
        }

        function initChart(v) {
            const ctx = document.getElementById('speedChart').getContext('2d');
            if (chartInstance) chartInstance.destroy();

            chartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: v.timestamps || [],
                    datasets: [{
                        label: 'السرعة (كم/س)',
                        data: v.speedHistory || [],
                        borderColor: '#38bdf8',
                        backgroundColor: 'rgba(56, 189, 248, 0.1)',
                        fill: true,
                        tension: 0.3
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { display: false },
                        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
                    }
                }
            });
        }

        function updateReportChart(v) {
            document.getElementById('repMaxSpeed').innerText = v.maxSpeed + ' كم/س';
            document.getElementById('repSpeedingCount').innerText = v.speedingCount;
            if (chartInstance) {
                chartInstance.data.labels = v.timestamps;
                chartInstance.data.datasets[0].data = v.speedHistory;
                chartInstance.update('none');
            }
        }

        function renderSidebar() {
            const list = document.getElementById('vehicleList');
            const query = document.getElementById('searchInput').value.trim().toLowerCase();
            list.innerHTML = '';

            const allVehicles = Object.values(vehicles);
            const speedingVehicles = allVehicles.filter(v => v.speed > 60);

            document.getElementById('totalCount').innerText = allVehicles.length;
            document.getElementById('speedingCount').innerText = speedingVehicles.length;

            const filtered = allVehicles.filter(v => 
                v.plate.toLowerCase().includes(query) || v.deviceId.toLowerCase().includes(query)
            );

            if (filtered.length === 0) {
                list.innerHTML = '<div style="color: #94a3b8; font-size: 13px;">لا توجد نتائج مطابقة</div>';
                return;
            }

            filtered.forEach(v => {
                const color = getVehicleColor(v.deviceId);
                const isSpeeding = v.speed > 60;
                const isSelected = selectedDeviceId === v.deviceId;
                const card = document.createElement('div');
                card.className = 'card ' + (isSpeeding ? 'speeding ' : '') + (isSelected ? 'selected' : '');
                card.onclick = () => selectVehicle(v.deviceId);
                card.innerHTML = '<div class="color-strip" style="background:' + color + '"></div>' +
                    '<div style="padding-right: 6px;">' +
                    '<div><span class="plate">' + v.plate + '</span> ' +
                    (isSpeeding ? '<span class="badge badge-speeding">⚠️ مسرع</span>' : '<span class="badge">شغال</span>') +
                    '</div>' +
                    '<div style="font-size:12px; margin-top:6px; color:' + (isSpeeding ? '#fca5a5' : '#cbd5e1') + ';">الكود: ' + v.deviceId + ' | السرعة: <b>' + v.speed + ' كم/س</b></div>' +
                    '</div>';
                list.appendChild(card);
            });
        }
    </script>
</body>
</html>
    `);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcastToClients(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'INIT_FLEET', data: Object.values(fleetState) }));
});

const HTTP_PORT = 3000;
server.listen(HTTP_PORT, () => {
    console.log(`🌐 السيرفر يعمل الآن! افتح المتصفح على: http://localhost:${HTTP_PORT}`);
});
