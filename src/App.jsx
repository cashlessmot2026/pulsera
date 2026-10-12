import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";

/* ============================================================
   Supabase (la anon key es pública por diseño; la seguridad la da RLS)
   ============================================================ */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://xetflthjncbypzigtsay.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhldGZsdGhqbmNieXB6aWd0c2F5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2NTI0MjgsImV4cCI6MjEwNDIyODQyOH0.G1e01PJoqoKPxlzmgHvDwddy4PZBg15qoEc2lmmrsa8";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const TABLE = "lecturas";
const SYNC_MS = 3000; // cada cuánto se envía el lote pendiente
const BATCH = 500;
const SESSION_ID = crypto.randomUUID(); // agrupa las lecturas de esta sesión de la app

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

// Servicios propietarios frecuentes en pulseras/relojes genéricos. Web Bluetooth solo deja ver
// los servicios declarados en optionalServices, así que se listan para poder explorarlos.
const VENDOR_SERVICES = {
  0xfee7: "Propietario (WeChat/genérico)",
  0xfee0: "Propietario (Mi Band y clones)",
  0xfee1: "Propietario (Mi Band y clones)",
  0xfee9: "Propietario genérico",
  0xfeea: "Propietario (Da Fit)",
  0xfe95: "Xiaomi",
  0xfe59: "Nordic DFU",
  0xfff0: "Propietario genérico (FFF0)",
  0xffe0: "Propietario genérico (FFE0)",
  0xffd0: "Propietario genérico (FFD0)",
  0xffc0: "Propietario genérico (FFC0)",
  0xffb0: "Propietario genérico (FFB0)",
  0xffa0: "Propietario genérico (FFA0)",
  0xff00: "Propietario genérico (FF00)",
  0xae00: "Chip JieLi (AE00)",
  0xae30: "Chip JieLi (AE30)",
  0x18d0: "Propietario (Lefun/ZeRun)",
  0x0af0: "Propietario (VeryFit/IDO)",
  0x1802: "Alerta inmediata",
  0x1805: "Hora actual",
  0x181c: "Datos de usuario",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e": "Nordic UART (FitPro y otros)",
  "f0080001-0451-4000-b000-000000000000": "Propietario (H Band/Veepoo)",
  "000001ff-3c17-d293-8e48-14fe2e4da212": "Propietario (GloryFit)",
  "0000d0ff-3c17-d293-8e48-14fe2e4da212": "Propietario (Telink)",
};
VENDOR_SERVICES["6e400001-b5a3-f393-e0a9-e50e24dcca9d"] = "Nordic UART variante (FitPro)";

/* ============================================================
   Protocolo FitPro (pulseras genéricas con Nordic UART: M3/M4/M5, JW-10…)
   Basado en la ingeniería inversa de Gadgetbridge (FitProConstants/FitProDeviceSupport).
   Paquete: CD | lenHi lenLo (total-3) | grupo | 01 | comando | dataLenHi dataLenLo | datos…
   ============================================================ */
const isUartService = (u) => /^6e400001-b5a3-f393-e0a9-e50e24dcca9[de]$/.test(u);
const isUartTx = (u) => /^6e400002-b5a3-f393-e0a9-e50e24dcca9[de]$/.test(u);
const isUartRx = (u) => /^6e400003-b5a3-f393-e0a9-e50e24dcca9[de]$/.test(u);

const fitpro = {
  craft(group, cmd, data = []) {
    const total = 8 + data.length;
    return new Uint8Array([0xcd, ((total - 3) >> 8) & 255, (total - 3) & 255, group, 0x01, cmd, (data.length >> 8) & 255, data.length & 255, ...data]);
  },
  ack(p) {
    const size = ((p[1] << 8) | p[2]) + 3;
    return new Uint8Array([0xdc, 0x00, 0x05, p[3], 0x01, (size >> 8) & 255, size & 255, 0x01]);
  },
  time() {
    const d = new Date();
    const v =
      (d.getSeconds() | ((d.getFullYear() - 2000) << 26) | ((d.getMonth() + 1) << 22) | (d.getDate() << 17) | (d.getHours() << 12) | (d.getMinutes() << 6)) >>> 0;
    return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  },
  init() {
    const c = fitpro.craft;
    return [
      c(0x12, 0x0a, [0x02]),
      c(0x12, 0x01, fitpro.time()), // fecha y hora
      c(0x1a, 0x0a),
      c(0x1a, 0x0c),
      c(0x12, 0x15, [0x06]), // idioma español
      c(0x12, 0xff, [0x01]),
      c(0x1a, 0x01),
      c(0x1a, 0x0f),
      c(0x1a, 0x10), // info de hardware
      c(0x20, 0x02), // info de la pulsera
      c(0x15, 0x06, [0x01]), // pasos en tiempo real / resumen del día
    ];
  },
  measureHr: (on) => fitpro.craft(0x12, 0x18, [on ? 1 : 0]),
  // Decodifica un paquete completo → { patch, ack }
  decode(p) {
    if (p[0] !== 0xcd || p.length < 8) return {};
    const group = p[3], cmd = p[5];
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (group === 0x15 && cmd === 0x0e && p.length >= 20) {
      const patch = {};
      if (p[19] > 0) patch.hr = p[19];
      if (p[17] > 0 && p[18] > 0) Object.assign(patch, { sys: p[17], dia: p[18], bpPulse: p[19] || undefined });
      if (p[13] >= 70 && p[13] <= 100) patch.spo2 = p[13];
      return { patch, ack: true };
    }
    if (group === 0x15 && cmd === 0x0c && p.length >= 20) {
      return { patch: { steps: dv.getUint32(10), stepDistance: dv.getUint32(14), calories: dv.getUint16(18) }, ack: true };
    }
    if ((group === 0x15 && [0x02, 0x03, 0x07, 0x08, 0x10].includes(cmd)) || group === 0x20 || group === 0x1a) return { ack: true };
    return {};
  },
};

/* ============================================================
   Protocolo SMA (app "SMART-TIME PRO", com.sma.smartv3 / SDK com.szabh.smable3)
   Basado en la ingeniería inversa del proyecto Fogg (github.com/MiguelDLM/Fogg, docs/SMA_BLE_PROTOCOL.md).
   Trama: AB | header(01, |0x10 respuesta, |0x20 NACK) | len BE (payload+3) | crc16 BE | cmd | key | flag | payload…
   CRC-16/MODBUS sobre cmd+key+flag+payload. Enteros del payload en little-endian; tiempos en segundos desde 2000-01-01.
   ============================================================ */
const CRC16_MODBUS = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc16 = (bytes) => {
  let crc = 0;
  for (const b of bytes) crc = (crc >>> 8) ^ CRC16_MODBUS[(crc ^ b) & 0xff];
  return crc & 0xffff;
};
const SMA_EPOCH = 946684800; // 2000-01-01T00:00:00Z

const sma = {
  FLAG: { UPDATE: 0x00, READ: 0x10, READ_CONTINUE: 0x11, CREATE: 0x20 },
  frame(cmd, key, flag, payload = [], reply = false) {
    const body = [cmd, key, flag, ...payload];
    const crc = crc16(body);
    const len = body.length;
    return new Uint8Array([0xab, reply ? 0x11 : 0x01, (len >> 8) & 255, len & 255, (crc >> 8) & 255, crc & 255, ...body]);
  },
  session: () => sma.frame(0x03, 0x02, 0x20, [0xff, 0xff, 0xff, 0xff]),
  time() {
    const d = new Date();
    return sma.frame(0x02, 0x01, 0x00, [d.getFullYear() - 2000, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]);
  },
  readPower: () => sma.frame(0x02, 0x03, 0x10),
  read: (key) => sma.frame(0x05, key, 0x10),
  readContinue: (key) => sma.frame(0x05, key, 0x11),
  ack: (cmd, key) => sma.frame(cmd, key, 0x00, [], true),
  findWatch: (on) => sma.frame(0x02, 0x34, 0x00, [on ? 1 : 0]),
  // bits: 7..6 estado (2=iniciar, 1=detener) · bit0 pulso · bit1 SpO2 · bit2 presión
  measure: (on) => sma.frame(0x02, 0x36, 0x00, [on ? 0x87 : 0x47]),
  HEALTH_KEYS: [0x03, 0x04, 0x09, 0x08, 0x02], // pulso, presión, SpO2, temperatura, actividad
  init: () => [sma.session(), sma.time(), sma.readPower()],
  sync: () => sma.HEALTH_KEYS.map((k) => sma.read(k)),
  // Decodifica los registros de salud → lista de { at: Date, patch }
  records(key, p) {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const size = { 0x02: 16, 0x03: 6, 0x04: 6, 0x08: 6, 0x09: 6 }[key];
    const out = [];
    if (!size) return out;
    for (let o = 0; o + size <= p.length; o += size) {
      const at = new Date((dv.getInt32(o, true) + SMA_EPOCH) * 1000);
      let patch = null;
      if (key === 0x03 && p[o + 4] > 0) patch = { hr: p[o + 4] };
      else if (key === 0x04 && p[o + 4] > 0) patch = { sys: p[o + 4], dia: p[o + 5] };
      else if (key === 0x09 && p[o + 4] > 0) patch = { spo2: p[o + 4] };
      else if (key === 0x08) {
        const raw = dv.getInt16(o + 4, true);
        if (raw > 0) patch = { temp: raw > 1000 ? raw / 100 : raw / 10 };
      } else if (key === 0x02) {
        patch = { steps: p[o + 5] | (p[o + 6] << 8) | (p[o + 7] << 16), stepDistance: dv.getInt32(o + 12, true) };
      }
      if (patch) out.push({ at, patch });
    }
    return out;
  },
};

const vendorKey = (k) => (/^\d+$/.test(k) ? Number(k) : k);
const ALL_SERVICES = [...Object.values(SVC), ...Object.keys(VENDOR_SERVICES).map(vendorKey)];

const uuidLabel = (uuid) => {
  const s = shortUuid(uuid);
  return s != null ? "0x" + s.toString(16).padStart(4, "0").toUpperCase() : uuid;
};
const serviceName = (uuid) => VENDOR_SERVICES[shortUuid(uuid) ?? uuid] || "Desconocido";
const toHex = (dv) =>
  Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), (b) => b.toString(16).padStart(2, "0")).join(" ");
const propsList = (p) =>
  ["read", "write", "writeWithoutResponse", "notify", "indicate"].filter((k) => p[k]).map((k) => (k === "writeWithoutResponse" ? "writeNR" : k));
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
    case "log": {
      const d = state[a.id];
      if (!d) return state;
      return { ...state, [a.id]: { ...d, log: [a.entry, ...(d.log || [])].slice(0, 80) } };
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
  const chars = useRef(new Map()); // `${id}|${servicio}|${caracteristica}` → BluetoothRemoteGATTCharacteristic
  const drivers = useRef(new Map()); // id → { tx, buf, chain } para protocolos propietarios (FitPro)
  const demoTimers = useRef(new Map()); // id → intervalId
  const names = useRef(new Map());
  const records = useRef([]); // registros en memoria (para CSV)
  const queue = useRef([]); // lecturas pendientes de enviar a Supabase
  const [saveDb, setSaveDb] = useState(true);
  const saveDbRef = useRef(true);
  const [db, setDb] = useState({ synced: 0, pending: 0, error: "", last: null });

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

  useEffect(() => {
    saveDbRef.current = saveDb;
    if (!saveDb) queue.current = [];
  }, [saveDb]);

  // Envío periódico por lotes a Supabase; si falla, las lecturas vuelven a la cola
  useEffect(() => {
    let busy = false;
    const flush = async () => {
      if (busy || !queue.current.length) return;
      busy = true;
      const batch = queue.current.splice(0, BATCH);
      const { error } = await supabase.from(TABLE).insert(batch);
      if (error) {
        queue.current.unshift(...batch);
        if (queue.current.length > 50000) queue.current.splice(0, queue.current.length - 50000);
        setDb((s) => ({ ...s, pending: queue.current.length, error: error.message }));
      } else {
        setDb((s) => ({ synced: s.synced + batch.length, pending: queue.current.length, error: "", last: Date.now() }));
      }
      busy = false;
    };
    const t = setInterval(flush, SYNC_MS);
    return () => clearInterval(t);
  }, []);

  // Publica nuevas lecturas al estado, al registro CSV y a la cola de Supabase
  // `at` (opcional): fecha real de la medición, para registros históricos descargados de la pulsera
  const push = useCallback((id, patch, at) => {
    dispatch({ type: "metrics", id, patch });
    const t = (at || new Date()).toISOString();
    const name = names.current.get(id) || id;
    const rows = [];
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === "number" && Number.isFinite(v)) rows.push({ metric: k, value: v });
    }
    if (patch.rrNew) patch.rrNew.forEach((v) => rows.push({ metric: "rr_ms", value: v }));
    rows.forEach((r) => records.current.push({ t, device: name, ...r }));
    if (records.current.length > 100000) records.current.splice(0, records.current.length - 100000);
    setRecordCount(records.current.length);
    if (saveDbRef.current) {
      rows.forEach((r) =>
        queue.current.push({ recorded_at: t, session_id: SESSION_ID, device_id: id, device_name: name, ...r })
      );
    }
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

  // Escrituras en serie (BLE no admite dos operaciones GATT simultáneas), con pausa entre paquetes
  const sendPackets = (id, packets, gap = 200) => {
    const drv = drivers.current.get(id);
    if (!drv) return Promise.resolve();
    drv.chain = drv.chain.then(async () => {
      for (const data of packets) {
        try {
          if (drv.tx.properties.writeWithoutResponse) await drv.tx.writeValueWithoutResponse(data);
          else await drv.tx.writeValueWithResponse(data);
          dispatch({ type: "log", id, entry: { t: Date.now(), dir: "tx", chr: uuidLabel(drv.tx.uuid), hex: toHex(new DataView(data.buffer)) } });
        } catch (e) {
          console.warn("Error al escribir a la pulsera", e);
        }
        await new Promise((r) => setTimeout(r, gap));
      }
    });
    return drv.chain;
  };

  const onUartData = (id, dv) => {
    const drv = drivers.current.get(id);
    if (drv?.protocol === "sma") onSmaData(id, dv);
    else if (drv?.protocol === "fitpro") onFitproData(id, dv);
  };

  // Reensambla tramas SMA (AB …) y las procesa
  const onSmaData = (id, dv) => {
    const drv = drivers.current.get(id);
    const bytes = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    if (!drv.buf.length && bytes[0] !== 0xab) return;
    drv.buf.push(...bytes);
    while (drv.buf.length >= 9) {
      if (drv.buf[0] !== 0xab) {
        drv.buf = [];
        break;
      }
      const total = ((drv.buf[2] << 8) | drv.buf[3]) + 6;
      if (total > 4096) {
        drv.buf = [];
        break;
      }
      if (drv.buf.length < total) break;
      const f = drv.buf.splice(0, total);
      if (((f[4] << 8) | f[5]) !== crc16(f.slice(6))) continue; // trama corrupta
      handleSmaFrame(id, drv, f[1], f[6], f[7], f[8], new Uint8Array(f.slice(9)));
    }
  };

  const handleSmaFrame = (id, drv, header, cmd, key, flag, payload) => {
    if (header & 0x20) return; // NACK: la pulsera no admite el comando
    if (cmd === 0x03 && key === 0x02) {
      dispatch({ type: "upsert", id, patch: { session: true } });
      sendPackets(id, sma.sync()); // sesión abierta → descargar historial
      return;
    }
    if (cmd === 0x02 && key === 0x03 && payload.length) {
      push(id, { battery: payload[0] });
      return;
    }
    if (cmd === 0x02 && key === 0x36 && payload.length) {
      // progreso de la medición: al terminar (o fallar) se leen los resultados
      sendPackets(id, [sma.read(0x03), sma.read(0x04), sma.read(0x09)]);
      return;
    }
    if (cmd === 0x05) {
      if (!payload.length) return; // fin de datos o ACK vacío
      const recs = sma.records(key, payload).sort((a, b) => a.at - b.at);
      for (const r of recs) {
        const k = `${key}|${r.at.getTime()}`;
        if (drv.seen.has(k)) continue; // ya registrado en esta sesión
        drv.seen.add(k);
        push(id, r.patch, r.at);
      }
      const packets = [sma.ack(cmd, key)];
      if (flag !== 0x00 && (drv.continues[key] = (drv.continues[key] || 0) + 1) <= 30) packets.push(sma.readContinue(key));
      sendPackets(id, packets, 80);
    }
  };

  // Reensambla paquetes FitPro (pueden llegar partidos en varias notificaciones de 20 bytes)
  const onFitproData = (id, dv) => {
    const drv = drivers.current.get(id);
    if (!drv) return;
    const bytes = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    if (!drv.buf.length && bytes[0] !== 0xcd) return; // fragmento suelto o ACK de la pulsera
    drv.buf.push(...bytes);
    while (drv.buf.length >= 3) {
      const total = ((drv.buf[1] << 8) | drv.buf[2]) + 3;
      if (total > 2048) {
        drv.buf = [];
        break;
      }
      if (drv.buf.length < total) break;
      const pkt = new Uint8Array(drv.buf.splice(0, total));
      const { patch, ack } = fitpro.decode(pkt);
      if (ack) sendPackets(id, [fitpro.ack(pkt)], 50);
      if (patch && Object.keys(patch).length) push(id, patch);
      if (drv.buf.length && drv.buf[0] !== 0xcd) drv.buf = [];
    }
  };

  const measureTimers = useRef(new Map());

  const command = (id, action) => {
    const drv = drivers.current.get(id);
    if (!drv) return;
    const isSma = drv.protocol === "sma";
    clearTimeout(measureTimers.current.get(id));
    if (action === "hr-start") {
      drv.continues = {};
      sendPackets(id, [isSma ? sma.measure(true) : fitpro.measureHr(true)]);
      dispatch({ type: "upsert", id, patch: { measuring: true } });
      if (isSma) {
        // Respaldo por si la pulsera no avisa el fin de la medición: leer resultados a los 30, 60 y 90 s
        let n = 0;
        const poll = () => {
          sendPackets(id, [sma.read(0x03), sma.read(0x04), sma.read(0x09)]);
          if (++n < 3) measureTimers.current.set(id, setTimeout(poll, 30000));
          else dispatch({ type: "upsert", id, patch: { measuring: false } });
        };
        measureTimers.current.set(id, setTimeout(poll, 30000));
      }
    } else if (action === "hr-stop") {
      sendPackets(id, [isSma ? sma.measure(false) : fitpro.measureHr(false)]);
      dispatch({ type: "upsert", id, patch: { measuring: false } });
    } else if (action === "sync") {
      drv.continues = {};
      sendPackets(id, isSma ? [sma.time(), sma.readPower(), ...sma.sync()] : fitpro.init());
    } else if (action === "find") {
      sendPackets(id, [isSma ? sma.findWatch(true) : fitpro.craft(0x12, 0x0b, [1])]);
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
        // Si no expone ningún servicio conocido, getPrimaryServices lanza NotFoundError: no es fatal
        const services = await server.getPrimaryServices().catch(() => []);
        const features = new Set();
        const info = {};
        const explore = [];
        const standard = new Set(Object.values(SVC));
        let uartTx = null, uartRx = null;

        for (const s of services) {
          const u = shortUuid(s.uuid);
          if (!standard.has(u)) {
            // Servicio propietario: listar características y escuchar sus notificaciones en crudo
            const entry = { service: s.uuid, name: serviceName(s.uuid), chars: [] };
            const list = await s.getCharacteristics().catch(() => []);
            for (const ch of list) {
              const key = `${id}|${s.uuid}|${ch.uuid}`;
              chars.current.set(key, ch);
              entry.chars.push({ key, uuid: ch.uuid, props: propsList(ch.properties) });
              if (isUartTx(ch.uuid)) uartTx = ch;
              if (ch.properties.notify || ch.properties.indicate) {
                const uart = isUartRx(ch.uuid);
                if (uart) uartRx = ch;
                ch.oncharacteristicvaluechanged = (e) => {
                  const dv = e.target.value;
                  dispatch({ type: "log", id, entry: { t: Date.now(), dir: "rx", chr: uuidLabel(ch.uuid), hex: toHex(dv) } });
                  if (uart) onUartData(id, dv);
                };
                await ch.startNotifications().catch(() => {});
              }
            }
            explore.push(entry);
            continue;
          }
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

        let protocol = null;
        if (uartTx && uartRx) {
          // Nordic UART estándar (…dca9e) → SMA (SMART-TIME PRO); variante …dca9d → FitPro
          protocol = uartTx.uuid.endsWith("9e") ? "sma" : "fitpro";
          drivers.current.set(id, { protocol, tx: uartTx, buf: [], chain: Promise.resolve(), seen: new Set(), continues: {} });
          ["hr", "spo2", "bp", "steps", "battery"].forEach((f) => features.add(f));
          if (protocol === "sma") features.add("temp");
          info.protocol = protocol === "sma" ? "SMA" : "FitPro";
        }

        dispatch({ type: "upsert", id, patch: { status: "connected", features: [...features], info, explore, protocol } });
        if (protocol) sendPackets(id, protocol === "sma" ? sma.init() : fitpro.init());
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
        optionalServices: ALL_SERVICES,
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
      if (tick === 1 || tick % 15 === 0) {
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

  // Explorador: escribir bytes (hex) o leer una característica propietaria
  const writeChar = async (id, key, hex) => {
    const ch = chars.current.get(key);
    const bytes = hex.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
    if (!ch || !bytes || bytes.length % 2) return setError("Hex inválido: usa pares de dígitos, ej. 'ab 01 ff'.");
    const data = new Uint8Array(bytes.match(/../g).map((b) => parseInt(b, 16)));
    if (drivers.current.get(id)?.tx === ch) return sendPackets(id, [data]); // misma cola que el driver
    try {
      if (ch.properties.writeWithoutResponse) await ch.writeValueWithoutResponse(data);
      else await ch.writeValueWithResponse(data);
      dispatch({ type: "log", id, entry: { t: Date.now(), dir: "tx", chr: uuidLabel(ch.uuid), hex: toHex(new DataView(data.buffer)) } });
    } catch (e) {
      setError(`Error al escribir: ${e.message}`);
    }
  };

  const readChar = async (id, key) => {
    const ch = chars.current.get(key);
    try {
      const dv = await ch.readValue();
      dispatch({ type: "log", id, entry: { t: Date.now(), dir: "read", chr: uuidLabel(ch.uuid), hex: toHex(dv) } });
    } catch (e) {
      setError(`Error al leer: ${e.message}`);
    }
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

      <div className={`dbbar ${db.error ? "err" : ""}`}>
        <label>
          <input type="checkbox" checked={saveDb} onChange={(e) => setSaveDb(e.target.checked)} /> Guardar en Supabase
        </label>
        <span className="muted">
          {!saveDb
            ? "Guardado desactivado"
            : db.error
            ? `⚠ Error: ${db.error} · ${db.pending} pendientes`
            : `☁ ${db.synced} lecturas guardadas · ${db.pending} pendientes${
                db.last ? ` · último envío ${new Date(db.last).toLocaleTimeString()}` : ""
              }`}
        </span>
      </div>

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
          <DevicePanel
            key={d.id}
            d={d}
            onDisconnect={disconnect}
            onReconnect={reconnect}
            onRemove={remove}
            onWrite={writeChar}
            onRead={readChar}
            onCommand={command}
          />
        ))
      )}

      <footer className="muted">Las lecturas se guardan en Supabase (tabla “{TABLE}”). También puedes exportarlas a CSV.</footer>
    </div>
  );
}

/* ============================================================
   Componentes de UI
   ============================================================ */
const STATUS_LABEL = { connecting: "Conectando…", connected: "Conectado", disconnected: "Desconectado" };

function DevicePanel({ d, onDisconnect, onReconnect, onRemove, onWrite, onRead, onCommand }) {
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
          {d.status === "connected" && d.protocol && (
            <>
              <button
                className={`btn sm ${d.measuring ? "" : "primary"}`}
                onClick={() => onCommand(d.id, d.measuring ? "hr-stop" : "hr-start")}
              >
                {d.measuring ? "■ Detener medición" : "❤ Medir"}
              </button>
              <button className="btn sm" onClick={() => onCommand(d.id, "sync")}>⟳ Sincronizar</button>
              <button className="btn sm" onClick={() => onCommand(d.id, "find")}>📳 Vibrar</button>
            </>
          )}
          {d.status === "connected" && <button className="btn sm" onClick={() => onDisconnect(d.id)}>Desconectar</button>}
          {d.status === "disconnected" && !d.demo && <button className="btn sm primary" onClick={() => onReconnect(d.id)}>Reconectar</button>}
          <button className="btn sm ghost" onClick={() => onRemove(d.id)}>Quitar</button>
        </div>
      </div>

      {d.status === "connected" && d.protocol && (
        <p className="muted pad">
          Protocolo {d.info.protocol} detectado
          {d.protocol === "sma" && (d.session ? " · sesión abierta ✓" : " · abriendo sesión…")}. Pulsa <b>❤ Medir</b> y mantén
          la pulsera bien ajustada: la medición tarda entre 30 y 90 s. <b>⟳ Sincronizar</b> descarga lo que la pulsera midió por su
          cuenta.
        </p>
      )}

      {d.status === "connected" && d.features.length === 0 && (
        <p className="muted pad">
          {d.explore?.length
            ? "Este dispositivo no usa los servicios estándar de salud: usa un protocolo propietario. Revisa el Explorador BLE abajo para ver sus datos en crudo."
            : "Conectado, pero no expone ningún servicio accesible. Cierra la app oficial de la pulsera (o desvincúlala en Ajustes → Bluetooth) y vuelve a intentar."}
        </p>
      )}

      <div className="grid">
        {f.has("hr") && <HeartCard m={m} />}
        {f.has("hr") && !d.protocol && <HrvCard m={m} />}
        {f.has("steps") && (
          <Card title="Pasos del día" icon="👣" accent="#4cc9f0">
            <Big value={m.steps ?? "--"} unit="pasos" />
            <Stats
              items={[
                ["Distancia", m.stepDistance != null ? fmt(m.stepDistance / 1000, 2) : "--", "km"],
                ["Calorías", m.calories ?? "--", "kcal"],
              ]}
            />
          </Card>
        )}
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

      {!d.demo && d.explore?.length > 0 && <Explorer d={d} onWrite={onWrite} onRead={onRead} />}
    </section>
  );
}

const hexOf = (u) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join(" ");
const FITPRO_PRESETS = [
  ["📳 Vibrar pulsera", "cd 00 06 12 01 0b 00 01 01"],
  ["❤ Medir pulso", "cd 00 06 12 01 18 00 01 01"],
  ["■ Detener", "cd 00 06 12 01 18 00 01 00"],
  ["👣 Pasos", "cd 00 06 15 01 06 00 01 01"],
  ["ℹ Info", "cd 00 05 20 01 02 00 00"],
];
const SMA_PRESETS = [
  ["🔑 Sesión", hexOf(sma.session())],
  ["📳 Vibrar", hexOf(sma.findWatch(true))],
  ["❤ Medir", hexOf(sma.measure(true))],
  ["■ Detener", hexOf(sma.measure(false))],
  ["❤ Leer pulsos", hexOf(sma.read(0x03))],
  ["🔋 Batería", hexOf(sma.readPower())],
  ["📡 Pulso en vivo (0x0224)", hexOf(sma.frame(0x02, 0x24, 0x00, [1]))],
];

function Explorer({ d, onWrite, onRead }) {
  const writable = d.explore.flatMap((s) => s.chars.filter((c) => c.props.includes("write") || c.props.includes("writeNR")));
  const [target, setTarget] = useState(writable[0]?.key || "");
  const [hex, setHex] = useState("");
  const log = d.log || [];

  return (
    <details className="explorer" open={d.features.length === 0}>
      <summary>🔬 Explorador BLE · {d.explore.length} servicio(s) propietario(s) · {log.length} paquetes</summary>

      {d.explore.map((s) => (
        <div key={s.service} className="svc">
          <b>{uuidLabel(s.service)}</b> <span className="muted">{s.name}</span>
          <ul>
            {s.chars.map((c) => (
              <li key={c.key}>
                <code>{uuidLabel(c.uuid)}</code> <span className="muted">[{c.props.join(", ")}]</span>
                {c.props.includes("read") && (
                  <button className="btn sm ghost" onClick={() => onRead(d.id, c.key)}>Leer</button>
                )}
              </li>
            ))}
            {s.chars.length === 0 && <li className="muted">Sin características accesibles</li>}
          </ul>
        </div>
      ))}

      {writable.length > 0 && (
        <form
          className="tx"
          onSubmit={(e) => {
            e.preventDefault();
            onWrite(d.id, target, hex);
          }}
        >
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {writable.map((c) => (
              <option key={c.key} value={c.key}>{uuidLabel(c.uuid)}</option>
            ))}
          </select>
          <input value={hex} onChange={(e) => setHex(e.target.value)} placeholder="Bytes en hex, ej. ab 00 04 ff 31 0a 01" />
          <button className="btn sm primary" type="submit">Enviar</button>
          <div className="presets">
            <span className="muted">Comandos {d.protocol === "sma" ? "SMA" : "FitPro"}:</span>
            {(d.protocol === "sma" ? SMA_PRESETS : FITPRO_PRESETS).map(([label, cmd]) => (
              <button key={label} type="button" className="btn sm ghost" onClick={() => setHex(cmd)}>
                {label}
              </button>
            ))}
          </div>
        </form>
      )}

      <div className="log">
        {log.length === 0 ? (
          <p className="muted">
            Esperando notificaciones… Mueve la pulsera o inicia una medición de pulso desde la propia pulsera para ver los paquetes.
          </p>
        ) : (
          log.map((l, i) => (
            <div key={i} className={`pkt ${l.dir}`}>
              <span className="muted">{new Date(l.t).toLocaleTimeString()}</span> <b>{l.dir}</b> <code>{l.chr}</code> {l.hex}
            </div>
          ))
        )}
      </div>
    </details>
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
.dbbar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;background:#121a2e;border:1px solid #1f2a47;border-radius:10px;padding:8px 12px;margin-bottom:16px;font-size:.9rem}
.dbbar.err{border-color:#ef476f}
.dbbar label{display:flex;gap:6px;align-items:center;cursor:pointer;font-weight:600}
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
.explorer{margin-top:14px;background:#121a2e;border:1px solid #1f2a47;border-radius:14px;padding:12px 14px}
.explorer summary{cursor:pointer;font-weight:700}
.svc{margin-top:10px;font-size:.9rem}
.svc ul{margin:6px 0 0;padding-left:18px}
.svc li{margin:4px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
code{font-family:ui-monospace,Consolas,monospace;font-size:.85em;color:#a5b4fc;word-break:break-all}
.tx{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.tx select,.tx input{background:#0b1020;color:#e2e8f0;border:1px solid #2a3758;border-radius:8px;padding:6px 8px;font-family:ui-monospace,Consolas,monospace}
.tx input{flex:1;min-width:180px}
.presets{display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%}
.log{margin-top:12px;max-height:260px;overflow:auto;background:#0b1020;border-radius:8px;padding:8px;font-family:ui-monospace,Consolas,monospace;font-size:.8rem}
.pkt{padding:2px 0;word-break:break-all}
.pkt.tx b{color:#ffb703}.pkt.rx b{color:#06d6a0}.pkt.read b{color:#4cc9f0}
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
  window.addEventListener("load", () => navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js"));
}
