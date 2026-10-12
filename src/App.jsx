import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/* ============================================================
   Servicios y características BLE estándar (Bluetooth SIG)
   ============================================================ */
const SVC = {
  HEART_RATE: 0x180d,
  BATTERY: 0x180f,
  THERMOMETER: 0x1809,
  PULSE_OXIMETER: 0x1822,
  RUNNING: 0x1814,
  ENVIRONMENT: 0x181a,
  BLOOD_PRESSURE: 0x1810,
  DEVICE_INFO: 0x180a,
};

const CHR = {
  HR_MEASUREMENT: 0x2a37,
  BODY_LOCATION: 0x2a38,
  BATTERY_LEVEL: 0x2a19,
  TEMP_MEASUREMENT: 0x2a1c,
  PLX_SPOT: 0x2a5e,
  PLX_CONTINUOUS: 0x2a5f,
  RSC_MEASUREMENT: 0x2a53,
  ENV_TEMPERATURE: 0x2a6e,
  ENV_HUMIDITY: 0x2a6f,
  ENV_PRESSURE: 0x2a6d,
  BP_MEASUREMENT: 0x2a35,
  MANUFACTURER: 0x2a29,
  MODEL: 0x2a24,
};

const HISTORY = 90; // puntos guardados para las gráficas en vivo
const BODY_LOCATIONS = ["Otro", "Pecho", "Muñeca", "Dedo", "Mano", "Lóbulo oreja", "Pie"];

/* ============================================================
   Decodificadores (formatos IEEE-11073 y specs GATT)
   ============================================================ */
function sfloat(raw) {
  if ([0x07ff, 0x0800, 0x07fe, 0x0802, 0x0801].includes(raw)) return NaN;
  let m = raw & 0x0fff;
  if (m >= 0x0800) m -= 0x1000;
  let e = (raw >> 12) & 0x0f;
  if (e >= 0x08) e -= 0x10;
  return m * Math.pow(10, e);
}

function float32(raw) {
  let m = raw & 0xffffff;
  if (m === 0x7fffff || m === 0x800000) return NaN;
  if (m >= 0x800000) m -= 0x1000000;
  let e = (raw >>> 24) & 0xff;
  if (e >= 0x80) e -= 0x100;
  return m * Math.pow(10, e);
}

const parse = {
  heartRate(dv) {
    const flags = dv.getUint8(0);
    let i = 1;
    const wide = flags & 0x01;
    const hr = wide ? dv.getUint16(i, true) : dv.getUint8(i);
    i += wide ? 2 : 1;
    const out = { hr };
    if (flags & 0x04) out.contact = !!(flags & 0x02);
    if (flags & 0x08) {
      out.energy = dv.getUint16(i, true);
      i += 2;
    }
    if (flags & 0x10) {
      const rr = [];
      while (i + 1 < dv.byteLength) {
        rr.push((dv.getUint16(i, true) / 1024) * 1000);
        i += 2;
      }
      if (rr.length) out.rrNew = rr;
    }
    return out;
  },
  temperature(dv) {
    const flags = dv.getUint8(0);
    let t = float32(dv.getUint32(1, true));
    if (flags & 0x01) t = ((t - 32) * 5) / 9; // °F → °C
    return { temp: t };
  },
  plx(dv) {
    return { spo2: sfloat(dv.getUint16(1, true)), pulseOx: sfloat(dv.getUint16(3, true)) };
  },
  running(dv) {
    const flags = dv.getUint8(0);
    const out = {
      speed: (dv.getUint16(1, true) / 256) * 3.6, // m/s → km/h
      cadence: dv.getUint8(3),
      running: !!(flags & 0x04),
    };
    let i = 4;
    if (flags & 0x01) {
      out.stride = dv.getUint16(i, true);
      i += 2;
    }
    if (flags & 0x02) out.distance = dv.getUint32(i, true) / 10;
    return out;
  },
  bloodPressure(dv) {
    const flags = dv.getUint8(0);
    const k = flags & 0x01 ? 7.50062 : 1; // kPa → mmHg
    const out = {
      sys: sfloat(dv.getUint16(1, true)) * k,
      dia: sfloat(dv.getUint16(3, true)) * k,
      map: sfloat(dv.getUint16(5, true)) * k,
    };
    let i = 7;
    if (flags & 0x02) i += 7; // timestamp
    if (flags & 0x04) out.bpPulse = sfloat(dv.getUint16(i, true));
    return out;
  },
};

const rmssd = (rr) => {
  if (rr.length < 3) return null;
  let s = 0;
  for (let i = 1; i < rr.length; i++) s += (rr[i] - rr[i - 1]) ** 2;
  return Math.sqrt(s / (rr.length - 1));
};

const shortUuid = (uuid) =>
  uuid.endsWith("-0000-1000-8000-00805f9b34fb") ? parseInt(uuid.slice(4, 8), 16) : null;

/* ============================================================
   Estado de dispositivos
   ============================================================ */
const emptyMetrics = () => ({ hrHistory: [], spo2History: [], rr: [], hrMin: null, hrMax: null, hrSum: 0, hrN: 0 });

function reducer(state, a) {
  switch (a.type) {
    case "upsert": {
      const prev = state[a.id] || { id: a.id, metrics: emptyMetrics(), features: [], info: {} };
      return { ...state, [a.id]: { ...prev, ...a.patch } };
    }
    case "metrics": {
      const d = state[a.id];
      if (!d) return state;
      const { rrNew, ...patch } = a.patch;
      const m = { ...d.metrics, ...patch, lastUpdate: Date.now() };
      if (patch.hr != null && patch.hr > 0) {
        m.hrHistory = [...m.hrHistory, patch.hr].slice(-HISTORY);
        m.hrMin = m.hrMin == null ? patch.hr : Math.min(m.hrMin, patch.hr);
        m.hrMax = m.hrMax == null ? patch.hr : Math.max(m.hrMax, patch.hr);
        m.hrSum += patch.hr;
        m.hrN += 1;
      }
      if (rrNew?.length) {
        m.rr = [...m.rr, ...rrNew].slice(-30);
        m.lastRR = rrNew[rrNew.length - 1];
        m.hrv = rmssd(m.rr);
      }
      if (patch.spo2 != null && !Number.isNaN(patch.spo2)) m.spo2History = [...m.spo2History, patch.spo2].slice(-HISTORY);
      return { ...state, [a.id]: { ...d, metrics: m } };
    }
    case "remove": {
      const next = { ...state };
      delete next[a.id];
      return next;
    }
    default:
      return state;
  }
}

/* ============================================================
   App
   ============================================================ */
function App() {
  const [devices, dispatch] = useReducer(reducer, {});
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [installEvt, setInstallEvt] = useState(null);
  const [recordCount, setRecordCount] = useState(0);

  const btDevices = useRef(new Map()); // id → BluetoothDevice
  const demoTimers = useRef(new Map()); // id → intervalId
  const names = useRef(new Map());
  const records = useRef([]); // registros en memoria (luego → base de datos)

  const supported = typeof navigator !== "undefined" && !!navigator.bluetooth;

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setInstallEvt(e);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  useEffect(() => () => demoTimers.current.forEach(clearInterval), []);

  // Publica nuevas lecturas al estado y al registro
  const push = useCallback((id, patch) => {
    dispatch({ type: "metrics", id, patch });
    const t = new Date().toISOString();
    const name = names.current.get(id) || id;
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === "number" && Number.isFinite(v)) records.current.push({ t, device: name, metric: k, value: v });
    }
    if (patch.rrNew) patch.rrNew.forEach((v) => records.current.push({ t, device: name, metric: "rr_ms", value: v }));
    if (records.current.length > 100000) records.current.splice(0, records.current.length - 100000);
    setRecordCount(records.current.length);
  }, []);

  // Suscribe una característica: lectura inicial + notificaciones
  const subscribe = async (service, charId, handler) => {
    try {
      const ch = await service.getCharacteristic(charId);
      const safe = (dv) => {
        try {
          handler(dv);
        } catch (e) {
          console.warn("Error al decodificar", charId.toString(16), e);
        }
      };
      if (ch.properties.read) {
        try {
          safe(await ch.readValue());
        } catch {}
      }
      if (ch.properties.notify || ch.properties.indicate) {
        ch.oncharacteristicvaluechanged = (e) => safe(e.target.value);
        await ch.startNotifications();
      }
      return true;
    } catch {
      return false;
    }
  };

  const readText = async (service, charId) => {
    try {
      const ch = await service.getCharacteristic(charId);
      return new TextDecoder().decode(await ch.readValue()).replace(/\0/g, "").trim();
    } catch {
      return undefined;
    }
  };

  const connect = useCallback(
    async (device) => {
      const id = device.id;
      btDevices.current.set(id, device);
      names.current.set(id, device.name || "Dispositivo BLE");
      dispatch({ type: "upsert", id, patch: { name: device.name || "Dispositivo BLE", status: "connecting", demo: false } });

      device.ongattserverdisconnected = () => dispatch({ type: "upsert", id, patch: { status: "disconnected" } });

      try {
        const server = await device.gatt.connect();
        const services = await server.getPrimaryServices();
        const features = new Set();
        const info = {};

        for (const s of services) {
          const u = shortUuid(s.uuid);
          if (u === SVC.HEART_RATE) {
            if (await subscribe(s, CHR.HR_MEASUREMENT, (dv) => push(id, parse.heartRate(dv)))) features.add("hr");
            await subscribe(s, CHR.BODY_LOCATION, (dv) => (info.location = BODY_LOCATIONS[dv.getUint8(0)] || "Otro"));
          } else if (u === SVC.BATTERY) {
            if (await subscribe(s, CHR.BATTERY_LEVEL, (dv) => push(id, { battery: dv.getUint8(0) }))) features.add("battery");
          } else if (u === SVC.THERMOMETER) {
            if (await subscribe(s, CHR.TEMP_MEASUREMENT, (dv) => push(id, parse.temperature(dv)))) features.add("temp");
          } else if (u === SVC.PULSE_OXIMETER) {
            const a = await subscribe(s, CHR.PLX_CONTINUOUS, (dv) => push(id, parse.plx(dv)));
            const b = await subscribe(s, CHR.PLX_SPOT, (dv) => push(id, parse.plx(dv)));
            if (a || b) features.add("spo2");
          } else if (u === SVC.RUNNING) {
            if (await subscribe(s, CHR.RSC_MEASUREMENT, (dv) => push(id, parse.running(dv)))) features.add("activity");
          } else if (u === SVC.ENVIRONMENT) {
            const a = await subscribe(s, CHR.ENV_TEMPERATURE, (dv) => push(id, { envTemp: dv.getInt16(0, true) / 100 }));
            const b = await subscribe(s, CHR.ENV_HUMIDITY, (dv) => push(id, { humidity: dv.getUint16(0, true) / 100 }));
            const c = await subscribe(s, CHR.ENV_PRESSURE, (dv) => push(id, { pressure: dv.getUint32(0, true) / 1000 }));
            if (a || b || c) features.add("env");
          } else if (u === SVC.BLOOD_PRESSURE) {
            if (await subscribe(s, CHR.BP_MEASUREMENT, (dv) => push(id, parse.bloodPressure(dv)))) features.add("bp");
          } else if (u === SVC.DEVICE_INFO) {
            info.manufacturer = await readText(s, CHR.MANUFACTURER);
            info.model = await readText(s, CHR.MODEL);
          }
        }

        dispatch({ type: "upsert", id, patch: { status: "connected", features: [...features], info } });
      } catch (e) {
        dispatch({ type: "upsert", id, patch: { status: "disconnected" } });
        setError(`No se pudo conectar a ${device.name || "el dispositivo"}: ${e.message}`);
      }
    },
    [push]
  );

  const scan = async () => {
    setError("");
    if (!supported) {
      setError("Este navegador no soporta Web Bluetooth. Usa Chrome o Edge (escritorio/Android) en HTTPS o localhost.");
      return;
    }
    setScanning(true);
    try {
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: Object.values(SVC),
      });
      await connect(device);
    } catch (e) {
      if (e.name !== "NotFoundError") setError(e.message); // NotFoundError = el usuario canceló
    } finally {
      setScanning(false);
    }
  };

  const startDemo = () => {
    const id = "demo-" + Date.now();
    const name = "Pulsera Demo";
    names.current.set(id, name);
    dispatch({
      type: "upsert",
      id,
      patch: {
        name,
        demo: true,
        status: "connected",
        features: ["hr", "spo2", "temp", "battery", "activity", "env", "bp"],
        info: { manufacturer: "Simulado", model: "v1", location: "Muñeca" },
      },
    });
    let hr = 72, temp = 36.6, battery = 100, spo2 = 98, tick = 0;
    const timer = setInterval(() => {
      tick++;
      hr = Math.max(50, Math.min(175, hr + (Math.random() - 0.48) * 4));
      const rr = 60000 / hr + (Math.random() - 0.5) * 60;
      push(id, { hr: Math.round(hr), contact: true, rrNew: [rr], energy: Math.round(tick * 0.4) });
      if (tick % 2 === 0) {
        spo2 = Math.max(92, Math.min(100, spo2 + (Math.random() - 0.5)));
        push(id, { spo2: Math.round(spo2), pulseOx: Math.round(hr) });
      }
      if (tick % 3 === 0) {
        temp = Math.max(35.8, Math.min(38, temp + (Math.random() - 0.5) * 0.08));
        push(id, {
          temp,
          speed: 6 + Math.random() * 2,
          cadence: Math.round(150 + Math.random() * 20),
          stride: Math.round(70 + Math.random() * 10),
          distance: tick * 1.6,
          running: hr > 110,
          envTemp: 24 + Math.random(),
          humidity: 45 + Math.random() * 5,
          pressure: 101.3 + Math.random() * 0.2,
        });
      }
      if (tick % 15 === 0) {
        battery = Math.max(0, battery - 1);
        push(id, { battery, sys: 115 + Math.random() * 10, dia: 75 + Math.random() * 6, bpPulse: Math.round(hr) });
      }
    }, 1000);
    demoTimers.current.set(id, timer);
  };

  const disconnect = (id) => {
    if (demoTimers.current.has(id)) {
      clearInterval(demoTimers.current.get(id));
      demoTimers.current.delete(id);
      dispatch({ type: "upsert", id, patch: { status: "disconnected" } });
      return;
    }
    btDevices.current.get(id)?.gatt?.disconnect();
  };

  const reconnect = (id) => {
    const d = btDevices.current.get(id);
    if (d) connect(d);
  };

  const remove = (id) => {
    disconnect(id);
    btDevices.current.delete(id);
    dispatch({ type: "remove", id });
  };

  const exportCsv = () => {
    const rows = ["fecha,dispositivo,metrica,valor", ...records.current.map((r) => `${r.t},"${r.device}",${r.metric},${r.value}`)];
    const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `registros-ble-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const list = Object.values(devices);

  return (
    <div className="app">
      <style>{CSS}</style>

      <header className="top">
        <div className="brand">
          <span className="logo">♥</span>
          <div>
            <h1>Pulsera BLE</h1>
            <p className={supported ? "ok" : "bad"}>{supported ? "Web Bluetooth disponible" : "Web Bluetooth no disponible"}</p>
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={scan} disabled={scanning}>
            {scanning ? "Buscando…" : "🔍 Buscar y conectar BLE"}
          </button>
          <button className="btn" onClick={startDemo}>▶ Demo</button>
          <button className="btn" onClick={exportCsv} disabled={!recordCount}>
            ⬇ CSV ({recordCount})
          </button>
          {installEvt && (
            <button
              className="btn"
              onClick={async () => {
                installEvt.prompt();
                await installEvt.userChoice;
                setInstallEvt(null);
              }}
            >
              📲 Instalar
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="error" onClick={() => setError("")}>
          ⚠ {error} <span className="muted">(toca para cerrar)</span>
        </div>
      )}

      {list.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📡</div>
          <h2>Sin dispositivos conectados</h2>
          <p>
            Pulsa <b>Buscar y conectar BLE</b> para emparejar una pulsera, banda de pecho, oxímetro o sensor compatible.
            <br />
            Se leen los servicios estándar: ritmo cardiaco, SpO₂, temperatura, batería, actividad, ambiente y presión arterial.
          </p>
          <p className="muted">¿Sin dispositivo a mano? Usa el botón <b>Demo</b> para ver datos simulados.</p>
        </div>
      ) : (
        list.map((d) => (
          <DevicePanel key={d.id} d={d} onDisconnect={disconnect} onReconnect={reconnect} onRemove={remove} />
        ))
      )}

      <footer className="muted">Los datos solo viven en memoria durante la sesión. Exporta a CSV para guardarlos.</footer>
    </div>
  );
}

/* ============================================================
   Componentes de UI
   ============================================================ */
const STATUS_LABEL = { connecting: "Conectando…", connected: "Conectado", disconnected: "Desconectado" };

function DevicePanel({ d, onDisconnect, onReconnect, onRemove }) {
  const m = d.metrics;
  const f = new Set(d.features);
  const ago = useNow(d.status === "connected");
  const lastSeen = m.lastUpdate ? Math.round((ago - m.lastUpdate) / 1000) : null;

  return (
    <section className="device">
      <div className="device-head">
        <div>
          <h2>
            <span className={`dot ${d.status}`} /> {d.name} {d.demo && <span className="tag">DEMO</span>}
          </h2>
          <p className="muted">
            {STATUS_LABEL[d.status]}
            {d.info.manufacturer && ` · ${d.info.manufacturer}`}
            {d.info.model && ` ${d.info.model}`}
            {d.info.location && ` · ${d.info.location}`}
            {lastSeen != null && d.status === "connected" && ` · última lectura hace ${lastSeen}s`}
          </p>
        </div>
        <div className="actions">
          {d.status === "connected" && <button className="btn sm" onClick={() => onDisconnect(d.id)}>Desconectar</button>}
          {d.status === "disconnected" && !d.demo && <button className="btn sm primary" onClick={() => onReconnect(d.id)}>Reconectar</button>}
          <button className="btn sm ghost" onClick={() => onRemove(d.id)}>Quitar</button>
        </div>
      </div>

      {d.status === "connected" && d.features.length === 0 && (
        <p className="muted pad">Conectado, pero no se encontraron servicios estándar compatibles en este dispositivo.</p>
      )}

      <div className="grid">
        {f.has("hr") && <HeartCard m={m} />}
        {f.has("hr") && <HrvCard m={m} />}
        {f.has("spo2") && <Spo2Card m={m} />}
        {f.has("temp") && (
          <Card title="Temperatura corporal" icon="🌡" accent="#ffb703">
            <Big value={fmt(m.temp, 1)} unit="°C" />
            <p className="muted">{tempLabel(m.temp)}</p>
          </Card>
        )}
        {f.has("battery") && <BatteryCard level={m.battery} />}
        {f.has("activity") && (
          <Card title="Actividad" icon="🏃" accent="#4cc9f0">
            <Stats
              items={[
                ["Cadencia", fmt(m.cadence, 0), "pasos/min"],
                ["Velocidad", fmt(m.speed, 1), "km/h"],
                ["Zancada", fmt(m.stride, 0), "cm"],
                ["Distancia", m.distance != null ? fmt(m.distance / 1000, 2) : "--", "km"],
              ]}
            />
            {m.running != null && <p className="muted">{m.running ? "Corriendo" : "Caminando"}</p>}
          </Card>
        )}
        {f.has("env") && (
          <Card title="Ambiente" icon="🌤" accent="#90be6d">
            <Stats
              items={[
                ["Temp.", fmt(m.envTemp, 1), "°C"],
                ["Humedad", fmt(m.humidity, 0), "%"],
                ["Presión", fmt(m.pressure, 1), "kPa"],
              ]}
            />
          </Card>
        )}
        {f.has("bp") && (
          <Card title="Presión arterial" icon="🩺" accent="#b5179e">
            <Big value={m.sys != null ? `${fmt(m.sys, 0)}/${fmt(m.dia, 0)}` : "--"} unit="mmHg" />
            <p className="muted">{m.bpPulse != null ? `Pulso ${fmt(m.bpPulse, 0)} lpm` : "Esperando medición"}</p>
          </Card>
        )}
      </div>
    </section>
  );
}

function Card({ title, icon, accent, children, wide }) {
  return (
    <div className={`card ${wide ? "wide" : ""}`} style={{ "--accent": accent }}>
      <div className="card-title">
        <span>{icon}</span> {title}
      </div>
      {children}
    </div>
  );
}

const Big = ({ value, unit }) => (
  <div className="big">
    {value}
    <small>{unit}</small>
  </div>
);

const Stats = ({ items }) => (
  <div className="stats">
    {items.map(([label, v, unit]) => (
      <div key={label}>
        <span className="muted">{label}</span>
        <b>
          {v} <small>{unit}</small>
        </b>
      </div>
    ))}
  </div>
);

function HeartCard({ m }) {
  const zone = hrZone(m.hr);
  const avg = m.hrN ? Math.round(m.hrSum / m.hrN) : null;
  return (
    <Card title="Ritmo cardiaco" icon="❤" accent={zone.color} wide>
      <div className="hr-row">
        <span className="heart" style={{ animationDuration: m.hr ? `${60 / m.hr}s` : "0s", color: zone.color }}>♥</span>
        <Big value={m.hr ?? "--"} unit="lpm" />
        <span className="zone" style={{ background: zone.color }}>{zone.label}</span>
      </div>
      <Sparkline data={m.hrHistory} color={zone.color} />
      <Stats
        items={[
          ["Mín", m.hrMin ?? "--", "lpm"],
          ["Prom", avg ?? "--", "lpm"],
          ["Máx", m.hrMax ?? "--", "lpm"],
          ["Energía", m.energy ?? "--", "kJ"],
        ]}
      />
      {m.contact != null && (
        <p className={m.contact ? "ok" : "bad"}>{m.contact ? "● Contacto con la piel" : "○ Sin contacto con la piel"}</p>
      )}
    </Card>
  );
}

function HrvCard({ m }) {
  return (
    <Card title="Variabilidad (HRV)" icon="〰" accent="#f72585">
      <Big value={fmt(m.hrv, 0)} unit="ms RMSSD" />
      <p className="muted">
        {m.lastRR != null ? `Último intervalo RR: ${Math.round(m.lastRR)} ms` : "El dispositivo no envía intervalos RR"}
      </p>
    </Card>
  );
}

function Spo2Card({ m }) {
  const v = m.spo2;
  const ok = v != null && !Number.isNaN(v);
  const color = !ok ? "#555" : v >= 95 ? "#06d6a0" : v >= 90 ? "#ffb703" : "#ef476f";
  const r = 42, c = 2 * Math.PI * r;
  const pct = ok ? Math.max(0, Math.min(1, (v - 70) / 30)) : 0;
  return (
    <Card title="Oxígeno en sangre" icon="🫁" accent={color}>
      <div className="ring-row">
        <svg width="110" height="110" viewBox="0 0 110 110">
          <circle cx="55" cy="55" r={r} stroke="#22304f" strokeWidth="10" fill="none" />
          <circle
            cx="55" cy="55" r={r} stroke={color} strokeWidth="10" fill="none" strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 55 55)"
            style={{ transition: "stroke-dashoffset .6s" }}
          />
          <text x="55" y="62" textAnchor="middle" fill="currentColor" fontSize="24" fontWeight="700">
            {ok ? Math.round(v) : "--"}
          </text>
        </svg>
        <div>
          <Big value="SpO₂" unit="%" />
          <p className="muted">{m.pulseOx != null && !Number.isNaN(m.pulseOx) ? `Pulso ${Math.round(m.pulseOx)} lpm` : ""}</p>
        </div>
      </div>
      <Sparkline data={m.spo2History} color={color} height={36} />
    </Card>
  );
}

function BatteryCard({ level }) {
  const color = level == null ? "#555" : level > 50 ? "#06d6a0" : level > 20 ? "#ffb703" : "#ef476f";
  return (
    <Card title="Batería" icon="🔋" accent={color}>
      <Big value={level ?? "--"} unit="%" />
      <div className="bar">
        <div style={{ width: `${level ?? 0}%`, background: color }} />
      </div>
    </Card>
  );
}

function Sparkline({ data, color, height = 70 }) {
  if (!data || data.length < 2) return <div className="spark-empty" style={{ height }}>Esperando datos…</div>;
  const w = 300;
  const min = Math.min(...data) - 2, max = Math.max(...data) + 2;
  const pts = data.map((v, i) => [(i / (HISTORY - 1)) * w, height - ((v - min) / (max - min || 1)) * height]);
  const line = pts.map((p) => p.join(",")).join(" ");
  const area = `0,${height} ${line} ${pts[pts.length - 1][0]},${height}`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }}>
      <polygon points={area} fill={color} opacity="0.15" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ============================================================
   Utilidades
   ============================================================ */
function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const fmt = (v, d) => (v == null || Number.isNaN(v) ? "--" : Number(v).toFixed(d));

function hrZone(hr) {
  if (!hr) return { label: "Sin datos", color: "#64748b" };
  if (hr < 60) return { label: "Reposo", color: "#4cc9f0" };
  if (hr < 100) return { label: "Normal", color: "#06d6a0" };
  if (hr < 140) return { label: "Elevado", color: "#ffb703" };
  return { label: "Alto", color: "#ef476f" };
}

function tempLabel(t) {
  if (t == null || Number.isNaN(t)) return "Esperando medición";
  if (t < 35.5) return "Baja";
  if (t <= 37.5) return "Normal";
  if (t <= 38) return "Febrícula";
  return "Fiebre";
}

/* ============================================================
   Estilos
   ============================================================ */
const CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:#0b1020;color:#e2e8f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.app{max-width:1200px;margin:0 auto;padding:16px 16px calc(24px + env(safe-area-inset-bottom))}
h1,h2{margin:0}
h1{font-size:1.3rem} h2{font-size:1.1rem}
.muted{color:#8b9bb8;font-size:.85rem}
.ok{color:#06d6a0;font-size:.85rem;margin:4px 0 0}
.bad{color:#ef476f;font-size:.85rem;margin:4px 0 0}
.top{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;margin-bottom:16px}
.brand{display:flex;gap:12px;align-items:center}
.logo{width:44px;height:44px;border-radius:12px;background:#ff4d6d;display:grid;place-items:center;font-size:24px;color:#fff}
.actions{display:flex;flex-wrap:wrap;gap:8px}
.btn{background:#1b2540;color:#e2e8f0;border:1px solid #2a3758;border-radius:10px;padding:10px 14px;font-size:.95rem;cursor:pointer;font-weight:600}
.btn:hover:not(:disabled){background:#24305a}
.btn:disabled{opacity:.5;cursor:default}
.btn.primary{background:#ff4d6d;border-color:#ff4d6d;color:#fff}
.btn.primary:hover:not(:disabled){background:#ff6b85}
.btn.sm{padding:6px 10px;font-size:.8rem}
.btn.ghost{background:transparent}
.error{background:#3b1220;border:1px solid #ef476f;color:#ffd6dd;padding:10px 14px;border-radius:10px;margin-bottom:16px;cursor:pointer}
.empty{text-align:center;padding:60px 16px;background:#121a2e;border:1px dashed #2a3758;border-radius:16px}
.empty-icon{font-size:48px}
.empty p{max-width:560px;margin:12px auto;line-height:1.5}
.device{background:#0f162a;border:1px solid #1f2a47;border-radius:16px;padding:16px;margin-bottom:16px}
.device-head{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;margin-bottom:14px}
.device-head p{margin:4px 0 0}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#64748b;margin-right:4px}
.dot.connected{background:#06d6a0;box-shadow:0 0 8px #06d6a0}
.dot.connecting{background:#ffb703;animation:blink 1s infinite}
.dot.disconnected{background:#ef476f}
.tag{font-size:.65rem;background:#4361ee;color:#fff;padding:2px 6px;border-radius:6px;vertical-align:middle}
.pad{padding:8px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{background:#121a2e;border:1px solid #1f2a47;border-top:3px solid var(--accent);border-radius:14px;padding:14px;min-width:0}
.card.wide{grid-column:span 2}
@media (max-width:540px){.card.wide{grid-column:span 1}}
.card-title{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#8b9bb8;margin-bottom:8px;display:flex;gap:6px;align-items:center}
.big{font-size:2.4rem;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
.big small{font-size:.9rem;font-weight:500;color:#8b9bb8;margin-left:6px}
.hr-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.heart{font-size:2.6rem;animation:beat 1s infinite;display:inline-block}
.zone{font-size:.75rem;font-weight:700;color:#0b1020;padding:3px 8px;border-radius:999px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:8px;margin-top:10px}
.stats div{display:flex;flex-direction:column}
.stats b{font-size:1.05rem;font-variant-numeric:tabular-nums}
.stats small{color:#8b9bb8;font-weight:400;font-size:.7rem}
.spark{width:100%;display:block;margin-top:10px}
.spark-empty{display:grid;place-items:center;color:#56637f;font-size:.8rem;margin-top:10px;border:1px dashed #1f2a47;border-radius:8px}
.ring-row{display:flex;align-items:center;gap:12px}
.bar{height:10px;background:#22304f;border-radius:999px;overflow:hidden;margin-top:10px}
.bar div{height:100%;transition:width .6s}
footer{text-align:center;margin-top:24px}
@keyframes beat{0%,100%{transform:scale(1)}15%{transform:scale(1.25)}30%{transform:scale(1)}45%{transform:scale(1.12)}}
@keyframes blink{50%{opacity:.3}}
`;

/* ============================================================
   Arranque + registro del Service Worker (PWA)
   ============================================================ */
createRoot(document.getElementById("root")).render(<App />);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
