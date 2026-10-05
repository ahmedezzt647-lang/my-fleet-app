const express = require('express');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const fleetState = {};
const colorPalette = ['#10b981', '#38bdf8', '#f97316', '#a855f7', '#ec4899'];

// استقبال بيانات أجهزة Teltonika عبر TCP Server (Port 8502)
const TELTONIKA_PORT = process.env.TELTONIKA_PORT || 8502;
const gpsServer = net.createServer((socket) => {
  let deviceImei = null;

  socket.on('data', (data) => {
    // 1. استقبال الـ IMEI من جهاز Teltonika عند أول اتصال
    if (data.length === 17 && data.readUInt16BE(0) === 15) {
      deviceImei = data.toString('ascii', 2, 17);
      console.log(`[Teltonika GPS] جهاز متصل جديد IMEI: ${deviceImei}`);
      socket.write(Buffer.from([0x01]));
      return;
    }

    // 2. قراءة حزم البيانات التتبعية (Codec 8)
    if (data.length > 12) {
      const recordsCount = data.readUInt8(9);
      if (recordsCount > 0 && deviceImei) {
        const longitude = data.readInt32BE(19) / 10000000;
        const latitude = data.readInt32BE(23) / 10000000;
        const speed = data.readUInt16BE(31);

        updateVehicle({
          deviceId: deviceImei,
          lat: latitude,
          lng: longitude,
          speed: speed,
          ignition: 1
        });

        const response = Buffer.alloc(4);
        response.writeUInt32BE(recordsCount, 0);
        socket.write(response);
      }
    }
  });

  socket.on('error', (err) => console.error('خطأ اتصالات Teltonika:', err.message));
});

gpsServer.listen(TELTONIKA_PORT, () => {
  console.log(`سيرفر استقبال أجهزة Teltonika يعمل على البورت: ${TELTONIKA_PORT}`);
});

app.post('/api/simulate-telemetry', (req, res) => {
  const { deviceId, lat, lng, speed, ignition, plate } = req.body;
  updateVehicle({ deviceId, lat, lng, speed, ignition, plate });
  res.json({ success: true });
});

function updateVehicle(data) {
  const { deviceId, lat, lng, speed, ignition, plate } = data;
  if (!fleetState[deviceId]) {
    const colorIndex = Object.keys(fleetState).length % colorPalette.length;
    fleetState[deviceId] = {
      deviceId,
      plate: plate || deviceId,
      lat, lng, speed, ignition,
      maxSpeed: speed,
      speedingCount: speed > 80 ? 1 : 0,
      color: colorPalette[colorIndex]
    };
  } else {
    const v = fleetState[deviceId];
    v.lat = lat;
    v.lng = lng;
    v.speed = speed;
    v.ignition = ignition;
    if (plate) v.plate = plate;
    if (speed > v.maxSpeed) v.maxSpeed = speed;
    if (speed > 80) v.speedingCount++;
  }
  broadcastToClients({ type: 'UPDATE_FLEET', data: fleetState[deviceId] });
}

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>أسطول شركة الهوادج</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body { margin: 0; font-family: sans-serif; background: #0f172a; color: #fff; display: flex; height: 100vh; }
    #sidebar { width: 320px; background: #1e293b; padding: 15px; box-sizing: border-box; overflow-y: auto; }
    #map { flex: 1; }
    .input-group { margin-top: 15px; background: #0f172a; padding: 10px; border-radius: 8px; border: 1px solid #334155; }
    input { width: 100%; padding: 8px; margin-bottom: 8px; background: #1e293b; border: 1px solid #475569; color: #fff; border-radius: 4px; box-sizing: border-box; }
    button { width: 100%; padding: 10px; background: #10b981; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
  </style>
</head>
<body>
  <div id="sidebar">
    <h2>🏢 أسطول شركة الهوادج</h2>
    
    <div class="input-group">
      <h3 style="margin-top:0; color:#38bdf8;">➕ ربط لوحة بجهاز Teltonika</h3>
      <input type="text" id="newDeviceId" placeholder="كود IMEI الخاص بجهاز Teltonika">
      <input type="text" id="newPlate" placeholder="رقم اللوحة (مثال: أ ب ج 1234)">
      <button onclick="saveVehicleFromUI()">حفظ وتأكيد</button>
    </div>

    <div id="vehicleList" style="margin-top: 15px;"></div>
  </div>
  <div id="map"></div>

  <script>
    const map = L.map('map').setView([26.3800, 50.1100], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

    const vehicles = {};
    const markers = {};

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsProtocol + '//' + window.location.host);
    
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'INIT_FLEET') {
        msg.data.forEach(v => updateVehicleOnMap(v));
      } else if (msg.type === 'UPDATE_FLEET') {
        updateVehicleOnMap(msg.data);
      }
    };

    function updateVehicleOnMap(v) {
      vehicles[v.deviceId] = v;
      if (!markers[v.deviceId]) {
        markers[v.deviceId] = L.marker([v.lat, v.lng]).addTo(map).bindPopup(v.plate);
      } else {
        markers[v.deviceId].setLatLng([v.lat, v.lng]);
      }
    }

    function saveVehicleFromUI() {
      const deviceId = document.getElementById('newDeviceId').value.trim();
      const plate = document.getElementById('newPlate').value.trim();
      if (!deviceId || !plate) return alert('يرجى كتابة IMEI ورقم اللوحة');

      fetch('/api/simulate-telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, plate, lat: 26.3800, lng: 50.1100, speed: 0, ignition: 1 })
      }).then(() => {
        alert('تم الحفظ بنجاح!');
        document.getElementById('newDeviceId').value = '';
        document.getElementById('newPlate').value = '';
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

const HTTP_PORT = process.env.PORT || 3000;
server.listen(HTTP_PORT, () => {
  console.log(`سيرفر الموقع يعمل على البورت: ${HTTP_PORT}`);
});
