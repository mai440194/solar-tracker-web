// ============================================================================
//  Solar Tracker — Web dashboard (port từ app Android solardone_app)
//  Dữ liệu: Firebase RTDB (realtime mọi node + REST cho history)
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue, update } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig, DB_ROOT } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const REST = firebaseConfig.databaseURL.replace(/\/+$/, "") + "/" + DB_ROOT;

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const MINU = 60000, DAYMS = 86400000;
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => (v === undefined || v === null || isNaN(v)) ? "--" : Number(v).toFixed(d);
const p2 = (n) => String(n).padStart(2, "0");
const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
function hhmmss(ms) { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; }
function hhmm(ms) { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }
function dmy(ms) { const d = new Date(ms); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`; }
function dur(ms) {
  if (!ms || ms < 0) return "0 phút";
  const m = Math.round(ms / MINU);
  if (m < 60) return m + " phút";
  const h = Math.floor(m / 60), mm = m % 60;
  return h + "h" + (mm ? " " + mm + "m" : "");
}
function upDur(s) {
  if (!s) return "--";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + "h " : "") + (m ? m + "m " : "") + ss + "s";
}
function fit(cv, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600;
  if (cssH) cv.style.height = cssH + "px";
  const h = cssH || cv.clientHeight || 160;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// ---------------------------------------------------------------- state
const D = { device: {}, sensors: {}, solar: {}, battery: {}, position: {}, control: {} };
let started = false, lastSig = -1, sigAt = 0, t0 = Date.now();
let curLight = null;

// ---------------------------------------------------------------- % PIN (tính ở web)
// % trên Firebase KHÔNG phải số đo trực tiếp: firmware suy nó từ điện áp pin qua bảng OCV.
// Bảng OCV chỉ đúng khi pin KHÔNG TẢI, nhưng thực tế:
//   • servo quay  -> sụt áp trên nội trở cell -> áp đọc thấp hơn OCV -> % thấp giả
//   • đang sạc     -> áp bị kéo lên trên OCV     -> % cao giả
// Nên web tự tính lại: chỉ lấy mẫu khi pin THẬT SỰ NGHỈ, lấy trung vị 60 s rồi chốt 1 số %,
// giữa 2 lần nghỉ thì giữ nguyên -> không nhảy. Dữ liệu gốc (Lịch sử / CSV) không bị sửa.
//
// Bảng OCV giữ ĐÚNG như firmware solar_tracker.ino:251 để web và thiết bị ra cùng một số.
const OCV_VT = [3.20, 3.40, 3.55, 3.62, 3.66, 3.70, 3.75, 3.80, 3.85, 3.92, 4.00, 4.10, 4.20];
const OCV_PC = [0, 7, 15, 24, 32, 42, 52, 62, 70, 78, 85, 92, 100];

function ocvPercent(blockV) {
  const cell = clamp(blockV / 2, 3.20, 4.20); // pin 2S -> đổi về thang 1 cell của bảng
  for (let i = 0; i < OCV_VT.length - 1; i++) {
    if (cell <= OCV_VT[i + 1])
      return OCV_PC[i] + (OCV_PC[i + 1] - OCV_PC[i]) * (cell - OCV_VT[i]) / (OCV_VT[i + 1] - OCV_VT[i]);
  }
  return 100;
}

// Trạng thái servo ĐỨNG YÊN (không rút dòng) — chỉ những lúc này áp mới gần OCV
const REST_STATUS = { Aligned: 1, Night: 1, Zenith: 1, Held: 1 };

const BAT = {
  needMs: 60000,      // phải nghỉ liên tục >= 60 s mới đủ tin để chốt
  acc: [],            // mẫu điện áp trong cửa sổ nghỉ hiện tại
  since: 0,           // mốc bắt đầu nghỉ
  hold: null,         // % đã chốt từ lần nghỉ gần nhất
  holdAt: 0,
  hyst: 2,            // chốt lại chỉ khi lệch >= 2 % (tránh sửa qua sửa lại)
  // dự phòng khi chưa từng có lần nghỉ nào (vd. mới mở web lúc đang sạc)
  win: [], winMax: 9, ema: null, lastT: 0, tauMs: 180000,
  shown: null, shownAt: 0, deadband: 1.5, minGapMs: 20000
};

function batIsResting() {
  const b = D.battery, s = D.solar, st = D.device.status;
  const v = Number(b.voltage) || 0;
  return b.charging !== true                     // không sạc
      && (Number(s.power) || 0) < 0.05           // panel gần như không phát
      && REST_STATUS[st] === 1                   // servo đứng yên
      && v > 5 && v < 9;                         // áp khối 2S hợp lệ
}

// Gom mẫu khi pin nghỉ -> chốt % OCV. Gọi mỗi giây (kể cả khi không có gói tin mới).
function batRestTick(t = Date.now()) {
  if (!batIsResting()) { BAT.since = 0; BAT.acc.length = 0; return; }
  if (!BAT.since) BAT.since = t;
  BAT.acc.push(Number(D.battery.voltage));
  if (BAT.acc.length > 120) BAT.acc.shift();     // giữ tối đa 2 phút mẫu
  if (t - BAT.since < BAT.needMs || BAT.acc.length < 20) return;

  const a = BAT.acc.slice().sort((x, y) => x - y);
  const med = a[(a.length - 1) >> 1];            // trung vị: bỏ mẫu dị thường
  const cand = Math.round(ocvPercent(med));
  if (BAT.hold === null || Math.abs(cand - BAT.hold) >= BAT.hyst) {
    BAT.hold = cand;
    BAT.holdAt = t;
  }
}

function smoothPct(raw, t = Date.now()) {
  const p = Number(raw);
  if (!isFinite(p)) return null;
  BAT.win.push(p);
  if (BAT.win.length > BAT.winMax) BAT.win.shift();
  const s = BAT.win.slice().sort((a, b) => a - b);
  const med = s[(s.length - 1) >> 1];
  if (BAT.ema === null) { BAT.ema = med; BAT.lastT = t; }
  else {
    const k = 1 - Math.exp(-Math.max(0, t - BAT.lastT) / BAT.tauMs);
    BAT.ema += k * (med - BAT.ema);
    BAT.lastT = t;
  }
  if (BAT.shown === null) BAT.shown = Math.round(BAT.ema);
  else {
    const diff = BAT.ema - BAT.shown;
    if (Math.abs(diff) >= BAT.deadband && t - BAT.shownAt >= BAT.minGapMs) {
      BAT.shown += Math.sign(diff);
      BAT.shownAt = t;
    }
  }
  return BAT.shown;
}

// Số % cuối cùng để hiển thị
function batteryPct(raw, t = Date.now()) {
  batRestTick(t);
  let v = BAT.hold !== null ? BAT.hold : smoothPct(raw, t);
  if (v === null) return null;
  // Ràng buộc vật lý: đang sạc thì dung lượng không thể giảm.
  // Chặn luôn kiểu 69 -> 63 -> 67 do servo rút dòng làm sụt áp.
  if (D.battery.charging === true && BAT.shown !== null && v < BAT.shown) v = BAT.shown;
  BAT.shown = v;
  BAT.shownAt = BAT.shownAt || t;
  return v;
}

// ============================================================================
//  LOGIN
// ============================================================================
const AUTH_KEY = "st_auth";
const USER = "solar", PASS = "admin";
const gate = $("loginGate"), appEl = $("app");

function showApp() {
  gate.hidden = true;
  appEl.hidden = false;
  if (!started) { started = true; startListeners(); }
  requestAnimationFrame(() => { drawRadar(); drawChart(); });
}
function logout() {
  sessionStorage.removeItem(AUTH_KEY);
  appEl.hidden = true;
  gate.hidden = false;
  $("lgPass").value = "";
}
$("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const u = $("lgUser").value.trim(), p = $("lgPass").value;
  if (u === USER && p === PASS) {
    sessionStorage.setItem(AUTH_KEY, "1");
    $("lgErr").hidden = true;
    showApp();
  } else {
    $("lgErr").hidden = false;
    gate.classList.add("shake");
    setTimeout(() => gate.classList.remove("shake"), 320);
  }
});
$("btnLogout").addEventListener("click", logout);

// ============================================================================
//  THEME
// ============================================================================
const THEME_KEY = "st_theme";
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
  $("btnTheme").textContent = t === "dark" ? "🌙" : "☀️";
  drawRadar(); drawChart(); drawBars();
}
$("btnTheme").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
applyTheme(localStorage.getItem(THEME_KEY) || "dark");

// ============================================================================
//  TABS
// ============================================================================
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === b));
  const id = b.dataset.tab;
  document.querySelectorAll(".tabpage").forEach((s) => (s.hidden = s.id !== "tab-" + id));
  if (id === "an") loadAnalysis();
  if (id === "hi") loadHistory();
  if (id === "ov") { drawChart(); drawRadar(); }
});

// ============================================================================
//  FIREBASE LISTENERS — đọc toàn bộ node (không bỏ sót field nào)
// ============================================================================
function startListeners() {
  ["device", "sensors", "solar", "battery", "position"].forEach((k) => {
    onValue(ref(db, DB_ROOT + "/" + k), (s) => {
      D[k] = s.val() || {};
      if (k === "device") {
        const sig = Math.max(Number(D.device.lastUpdate) || 0, Number(D.device.uptimeSec) || 0);
        if (sig && sig !== lastSig) { lastSig = sig; sigAt = Date.now(); }
      }
      render();
    }, (err) => console.warn("listen", k, err && err.message));
  });

  // control: đọc về để đồng bộ công tắc / thanh trượt sau khi tải lại trang
  onValue(ref(db, DB_ROOT + "/control"), (s) => {
    D.control = s.val() || {};
    syncControlUI();
  }, (err) => console.warn("listen control", err && err.message));

  // watchdog online/offline (giống MainActivity: timeout 6s)
  setInterval(() => {
    const on = sigAt && Date.now() - sigAt < 6000;
    const grace = Date.now() - t0 < 8000;
    const pill = $("hdrPill");
    if (on) { pill.className = "pill on"; pill.textContent = "● ONLINE"; }
    else if (grace) { pill.className = "pill off"; pill.textContent = "○ ĐANG KẾT NỐI"; }
    else { pill.className = "pill off"; pill.textContent = "○ MẤT KẾT NỐI"; }
    $("hdrClock").textContent = hhmmss(Date.now());
    // lấy mẫu % pin mỗi giây, không phụ thuộc nhịp gói tin Firebase
    const pctNow = batteryPct(D.battery.percentage);
    if (pctNow !== null) {
      $("bPct").textContent = pctNow + " %";
      $("bBar").style.width = clamp(pctNow, 0, 100) + "%";
    }
  }, 1000);

  pushChartLoop();
  seedChart();
}

// ============================================================================
//  RENDER LIVE
// ============================================================================
function render() {
  const s = D.solar, b = D.battery, dv = D.device, sn = D.sensors, p = D.position;

  $("sV").textContent = num(s.voltage, 2) + " V";
  $("sI").textContent = num(s.current, 3) + " A";
  $("sP").textContent = num(s.power, 2) + " W";
  $("sE").textContent = num(s.energyWh, 1) + " Wh";
  badge("sOk", dv.solarOk, "OK", "Lỗi INA219");

  $("bV").textContent = num(b.voltage, 2) + " V";
  const pctShow = batteryPct(b.percentage);
  $("bPct").textContent = pctShow === null ? "-- %" : pctShow + " %";
  $("bBar").style.width = clamp(pctShow === null ? 0 : pctShow, 0, 100) + "%";
  $("bI").textContent = num(b.current, 2) + " A";
  const chg = b.charging === true;
  const bs = $("bStatus");
  bs.textContent = chg ? "Đang sạc" : "Không sạc";
  bs.className = "badge " + (chg ? "ok" : "warn");

  $("dStatus").textContent = STATUS_VI[dv.status] || dv.status || "--";
  $("dUp").textContent = upDur(dv.uptimeSec);
  $("pAz").textContent = num(p.azimuth, 1) + "°";
  $("pEl").textContent = num(p.elevation, 1) + "°";
  $("dUpd").textContent = dv.lastUpdate ? hhmmss(Number(dv.lastUpdate)) : "--";
  $("hdrRssi").textContent = (dv.wifiRSSI !== undefined ? dv.wifiRSSI + " dBm" : "--");

  $("ctlReal").textContent = (num(p.azimuth, 1) + "° / " + num(p.elevation, 1) + "°");

  // LDR
  const v = [sn.ldr1, sn.ldr2, sn.ldr3, sn.ldr4].map((x) => Number(x) || 0);
  for (let i = 0; i < 4; i++) {
    $("b" + (i + 1)).style.width = clamp(v[i] / 4095 * 100, 0, 100) + "%";
    $("v" + (i + 1)).textContent = v[i];
  }
  if (sn.ldr1 !== undefined) {
    const mx = Math.max(...v), mn = Math.min(...v);
    $("ldrDelta").textContent = mx - mn;
    curLight = classifyLight(v[0], v[1], v[2], v[3]);
    setRadarTarget(curLight);
    $("dirLabel").textContent = curLight.label;
    $("dirLabel2").textContent = curLight.label;
  }
}

function badge(id, ok, okTxt, badTxt) {
  const el = $(id);
  if (!el) return;
  if (ok === undefined) { el.textContent = "--"; el.className = "badge"; return; }
  el.textContent = ok ? okTxt : badTxt;
  el.className = "badge " + (ok ? "ok" : "bad");
}

// Trạng thái firmware ESP32 (solar_tracker.ino) -> tiếng Việt
const STATUS_VI = {
  Boot: "Khởi động",
  Tracking: "Đang xoay bám sáng",
  Aligned: "Đã đúng hướng",
  Night: "Trời tối",
  Zenith: "Sáng giữa",
  Manual: "Thủ công",
  Held: "Giữ nguyên",
};

// ============================================================================
//  LIGHT DIRECTION — port nguyên LightDirection.java
// ============================================================================
const GX = [-1, -1, 1, 1], GY = [-1, 1, 1, -1];
const NIGHT_MIN_SUM = 600, FLAT_EPS = 60, ZENITH_SPREAD = 500, MID_EPS = 400;
const PAIRS = [[0, 1], [1, 2], [2, 3], [0, 3]];

function classifyLight(l1, l2, l3, l4) {
  const v = [l1, l2, l3, l4];
  const total = l1 + l2 + l3 + l4;
  let mx = -1, i1 = 0, mn = 1e9;
  for (let i = 0; i < 4; i++) { if (v[i] > mx) { mx = v[i]; i1 = i; } if (v[i] < mn) mn = v[i]; }

  if (total < NIGHT_MIN_SUM)
    return { type: "NIGHT", corner: -1, pair: -1, x: 0, y: 0, peak: mx, label: "Trời tối" };

  if (mx > FLAT_EPS && mx - mn <= ZENITH_SPREAD)
    return { type: "ZENITH", corner: -1, pair: -1, x: 0, y: 0, peak: mx, label: "Sáng giữa" };

  let i2 = -1, sec = -1;
  for (let i = 0; i < 4; i++) { if (i === i1) continue; if (v[i] > sec) { sec = v[i]; i2 = i; } }

  let pair = -1;
  for (let p = 0; p < 4; p++) {
    const [a, b] = PAIRS[p];
    if ((a === i1 && b === i2) || (a === i2 && b === i1)) { pair = p; break; }
  }

  if (pair >= 0 && (v[i1] - v[i2]) <= MID_EPS) {
    const [a, b] = PAIRS[pair];
    return {
      type: "MID", corner: -1, pair, peak: mx,
      x: (GX[a] + GX[b]) / 2, y: (GY[a] + GY[b]) / 2,
      label: `Giữa LDR ${a + 1} & ${b + 1}`
    };
  }

  return { type: "CORNER", corner: i1, pair: -1, x: GX[i1], y: GY[i1], peak: mx, label: `Lệch về LDR ${i1 + 1}` };
}

function isHot(L, i) {
  if (!L) return false;
  if (L.type === "CORNER") return i === L.corner;
  if (L.type === "MID") return i === L.pair || i === (L.pair + 1) % 4;
  return false;
}

// ============================================================================
//  RADAR — port RadarView.java (3 vòng, khung nét đứt, marker 1-4, chấm phát sáng)
// ============================================================================
const R = { cx: 0, cy: 0, ca: 0, ci: 0, fx: 0, fy: 0, fa: 0, fi: 0, tx: 0, ty: 0, ta: 0, ti: 0, t0: 0, anim: false };
let loopOn = false;

function setRadarTarget(c) {
  const tA = c.type === "NIGHT" ? 0 : 1;
  const ti = clamp((c.peak || 0) / 4095, 0, 1);
  if (tA === R.ta && c.x === R.tx && c.y === R.ty && Math.abs(ti - R.ti) < 0.004) return;
  R.fx = R.cx; R.fy = R.cy; R.fa = R.ca; R.fi = R.ci;
  R.tx = c.x; R.ty = c.y; R.ta = tA; R.ti = ti;
  R.t0 = performance.now(); R.anim = true;
  if (!loopOn) { loopOn = true; requestAnimationFrame(radarTick); }
}

function radarTick(now) {
  if (R.anim) {
    const p = clamp((now - R.t0) / 650, 0, 1);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // AccelerateDecelerate
    R.cx = R.fx + (R.tx - R.fx) * e;
    R.cy = R.fy + (R.ty - R.fy) * e;
    R.ca = R.fa + (R.ta - R.fa) * e;
    R.ci = R.fi + (R.ti - R.fi) * e;
    if (p >= 1) R.anim = false;
  }
  drawRadar();
  if (R.anim) requestAnimationFrame(radarTick); else loopOn = false;
}

function drawRadar() {
  const cv = $("radar");
  if (!cv || !cv.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const side = cv.clientWidth || 280;
  const W = Math.round(side * dpr);
  if (cv.width !== W || cv.height !== W) { cv.width = W; cv.height = W; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, side, side);

  const cx = side / 2, cy = side / 2;
  const ringR = side * 0.40, anchor = ringR * 0.70;
  const cLine = cssv("--line"), cMut = cssv("--mut"), cCard = cssv("--card");

  // nền
  const g = ctx.createLinearGradient(0, 0, 0, side);
  g.addColorStop(0, cCard);
  g.addColorStop(1, cssv("--bg2"));
  ctx.fillStyle = g;
  ctx.beginPath();
  const rr = side * 0.07;
  roundRect(ctx, 0, 0, side, side, rr);
  ctx.fill();

  // 3 vòng
  [1, 0.70, 0.35].forEach((k, i) => {
    ctx.beginPath();
    ctx.arc(cx, cy, ringR * k, 0, Math.PI * 2);
    ctx.strokeStyle = i === 0 ? cMut : cLine;
    ctx.lineWidth = 1;
    ctx.globalAlpha = i === 0 ? 0.9 : 0.75;
    ctx.stroke();
    ctx.globalAlpha = 1;
  });

  // chữ thập
  ctx.strokeStyle = cLine; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - ringR, cy); ctx.lineTo(cx + ringR, cy);
  ctx.moveTo(cx, cy - ringR); ctx.lineTo(cx, cy + ringR);
  ctx.stroke();

  // khung tấm pin (nét đứt) đi qua 4 LDR
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = cLine;
  ctx.beginPath();
  roundRect(ctx, cx - anchor, cy - anchor, anchor * 2, anchor * 2, anchor * 0.12);
  ctx.stroke();
  ctx.restore();

  // nhãn hướng
  const fs = Math.max(9, side * 0.05);
  ctx.fillStyle = cMut;
  ctx.font = `600 ${fs}px "Segoe UI",system-ui,sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("BẮC", cx, cy - ringR + fs * 0.9);
  ctx.fillText("NAM", cx, cy + ringR - fs * 0.9);
  ctx.fillText("T", cx - ringR + fs * 0.9, cy);
  ctx.fillText("Đ", cx + ringR - fs * 0.9, cy);

  // 4 marker LDR
  const mr = side * 0.042;
  for (let i = 0; i < 4; i++) {
    const mx = cx + GX[i] * anchor;
    const my = cy - GY[i] * anchor;
    const hot = isHot(curLight, i);
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, Math.PI * 2);
    ctx.fillStyle = hot ? "rgba(245,158,11,0.55)" : cssv("--field");
    ctx.fill();
    ctx.lineWidth = hot ? 2 : 1.2;
    ctx.strokeStyle = hot ? "#F59E0B" : cMut;
    ctx.stroke();
    ctx.fillStyle = hot ? "#ffffff" : cMut;
    ctx.font = `700 ${Math.round(mr * 1.15)}px "Segoe UI",system-ui,sans-serif`;
    ctx.fillText(String(i + 1), mx, my + 0.5);
  }

  // chấm hướng sáng + quầng
  if (R.ca > 0.02) {
    const dx = cx + R.cx * anchor;
    const dy = cy - R.cy * anchor;
    const dotR = side * 0.048;
    const glowR = dotR * (1.7 + 1.8 * R.ci);
    const ga = (R.ca * (40 + 110 * R.ci)) / 255;
    const grd = ctx.createRadialGradient(dx, dy, 0, dx, dy, glowR);
    grd.addColorStop(0, `rgba(245,158,11,${ga})`);
    grd.addColorStop(1, "rgba(245,158,11,0)");
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(dx, dy, glowR, 0, Math.PI * 2); ctx.fill();

    ctx.beginPath(); ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(251,191,36,${R.ca})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(245,158,11,${R.ca})`;
    ctx.lineWidth = 1.5; ctx.stroke();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============================================================================
//  CHART (nạp sẵn từ history, rồi nối tiếp realtime)
// ============================================================================
const buf = [];
const MAXP = 900;
let chartMetric = "sv";
const METRICS = {
  sv: { unit: "V", dec: 2, color: "--g" },
  sp: { unit: "W", dec: 2, color: "--a" },
  si: { unit: "A", dec: 3, color: "--c" },
  bv: { unit: "V", dec: 2, color: "--g" },
  bp: { unit: "%", dec: 0, color: "--c" }
};

$("metricChips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  chartMetric = b.dataset.m;
  document.querySelectorAll("#metricChips .chip").forEach((x) => x.classList.toggle("on", x === b));
  drawChart();
});

function pushChartLoop() {
  setInterval(() => {
    const d = D; if (!d.solar.voltage && !D.device.lastUpdate) return;
    const t = Number(D.device.lastUpdate) || Date.now();
    const p = { t, sv: Number(d.solar.voltage) || 0, si: Number(d.solar.current) || 0, sp: Number(d.solar.power) || 0, bv: Number(d.battery.voltage) || 0, bp: Number(d.battery.percentage) || 0 };
    const last = buf[buf.length - 1];
    if (last && Math.abs(t - last.t) < 1200) Object.assign(last, p);
    else { buf.push(p); if (buf.length > MAXP) buf.shift(); }
    drawChart();
  }, 2000);
}

async function seedChart() {
  try {
    const now = Date.now();
    const rows = await fetchRows(now - 8 * 3600e3, now, 400);
    buf.length = 0;
    for (const r of rows) buf.push({ t: r.ts, sv: r.solarV, si: r.solarI, sp: r.power, bv: r.batV, bp: r.batPct });
    drawChart();
  } catch (e) { console.warn("seed chart", e); }
}

function drawChart() {
  const cv = $("chart"); if (!cv || !cv.clientWidth) return;
  const { ctx, w, h } = fit(cv, 160);
  ctx.clearRect(0, 0, w, h);
  const m = METRICS[chartMetric], col = cssv(m.color);
  const pad = { l: 46, r: 10, t: 10, b: 18 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;

  if (buf.length < 2) {
    ctx.fillStyle = cssv("--mut"); ctx.font = '12px "Segoe UI",system-ui,sans-serif';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Chưa đủ dữ liệu", w / 2, h / 2);
    return;
  }

  let max = 0;
  for (const p of buf) max = Math.max(max, p[chartMetric] || 0);
  if (max <= 0) max = 1;
  max *= 1.15;

  // lưới ngang
  ctx.strokeStyle = cssv("--line"); ctx.lineWidth = 1;
  ctx.font = '10px "Segoe UI",system-ui,sans-serif';
  ctx.fillStyle = cssv("--mut"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ph - (ph * i) / 4;
    ctx.globalAlpha = i === 0 ? 1 : 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText((max * i / 4).toFixed(max >= 10 ? 0 : 1), pad.l - 6, y);
  }

  const t1 = buf[buf.length - 1].t, tA = buf[0].t, span = Math.max(1, t1 - tA);
  const X = (t) => pad.l + ((t - tA) / span) * pw;
  const Y = (v) => pad.t + ph - (v / max) * ph;

  // vùng tô
  ctx.beginPath();
  ctx.moveTo(X(tA), Y(0));
  for (const p of buf) ctx.lineTo(X(p.t), Y(p[chartMetric] || 0));
  ctx.lineTo(X(t1), Y(0));
  ctx.closePath();
  const gd = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
  gd.addColorStop(0, col + "55"); gd.addColorStop(1, col + "00");
  ctx.fillStyle = gd; ctx.fill();

  // đường
  ctx.beginPath();
  buf.forEach((p, i) => { const x = X(p.t), y = Y(p[chartMetric] || 0); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.stroke();

  // nhãn thời gian
  ctx.fillStyle = cssv("--mut"); ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let i = 0; i <= 4; i++) {
    const t = tA + (span * i) / 4;
    ctx.fillText(span > DAYMS ? dmy(t) + " " + hhmm(t) : hhmm(t), X(t), pad.t + ph + 4);
  }

  // giá trị mới nhất
  const last = buf[buf.length - 1][chartMetric] || 0;
  ctx.fillStyle = col; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.font = '700 12px "Segoe UI",system-ui,sans-serif';
  ctx.fillText(last.toFixed(m.dec) + " " + m.unit, pad.l + 4, pad.t + 2);
}

// ============================================================================
//  HISTORY — REST, có fallback giống app Android (rules không có .indexOn ts)
// ============================================================================
// rules-prod.json KHÔNG có .indexOn "ts" -> orderBy ts trả 400. Đổi thành null để thử lại
// (khi nào thêm ".indexOn": ["ts"] vào rules thì đặt = null để dùng truy vấn theo khoảng).
let tsIndexOk = false;
async function fetchRows(start, end, fallbackLimit = 15000) {
  const base = REST + "/history.json";
  const j = async (u) => {
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return null;
    const v = await r.json();
    if (!v) return [];
    return Array.isArray(v) ? v : Object.values(v);
  };
  let rows = null;
  // rules không có .indexOn "ts" -> chỉ thử 1 lần, sau đó nhớ luôn là không hỗ trợ
  if (tsIndexOk !== false) {
    try { rows = await j(`${base}?orderBy=%22ts%22&startAt=${start}&endAt=${end}`); } catch (e) { rows = null; }
    tsIndexOk = rows !== null;
  }
  if (!rows) {
    try { rows = await j(`${base}?orderBy=%22%24key%22&limitToLast=${fallbackLimit}`); } catch (e) { rows = null; }
  }
  if (!rows) { try { rows = await j(base); } catch (e) { rows = []; } }
  return (rows || [])
    .filter((r) => r && Number(r.ts) >= start && Number(r.ts) <= end)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

// ------------------------------------------------------------------ ranges
let hiRange = "today", anRange = "today";
function rangeOf(kind, dateStr) {
  const now = Date.now();
  if (kind === "d7") return { start: now - 7 * DAYMS, end: now, label: "7 ngày gần nhất" };
  if (kind === "d30") return { start: now - 30 * DAYMS, end: now, label: "30 ngày gần nhất" };
  if (kind === "pick" && dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const s = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    return { start: s, end: s + DAYMS - 1, label: dmy(s) };
  }
  const s = new Date(); s.setHours(0, 0, 0, 0);
  return { start: s.getTime(), end: now, label: "Hôm nay" };
}

function wireChips(containerId, pickId, setter) {
  $(containerId).addEventListener("click", (e) => {
    const b = e.target.closest("[data-range]"); if (!b) return;
    document.querySelectorAll("#" + containerId + " [data-range]").forEach((x) => x.classList.toggle("on", x === b));
    $(pickId).value = "";
    setter(b.dataset.range, "");
  });
  $(pickId).addEventListener("change", () => {
    if (!$(pickId).value) return;
    document.querySelectorAll("#" + containerId + " [data-range]").forEach((x) => x.classList.remove("on"));
    setter("pick", $(pickId).value);
  });
}

// ============================================================================
//  HISTORY TAB
// ============================================================================
wireChips("hiChips", "hiPick", (k, d) => { hiRange = { k, d }; loadHistory(); });

let hiRows = [];
async function loadHistory() {
  const kind = hiRange.k || hiRange, dateStr = hiRange.d || "";
  const rg = rangeOf(kind, dateStr);
  $("hiCount").textContent = "Đang tải…";
  $("hiNote").textContent = rg.label;
  try {
    const rows = await fetchRows(rg.start, rg.end);
    hiRows = rows;
    renderHistory(rows);
  } catch (e) {
    $("hiCount").textContent = "Lỗi tải dữ liệu";
    $("hiNote").textContent = String(e.message || e);
  }
}

function renderHistory(rows) {
  const tb = $("histBody");
  $("hiCount").textContent = rows.length + " mốc";
  $("hiNote").textContent = rows.length
    ? `${hhmm(rows[0].ts)} ${dmy(rows[0].ts)} → ${hhmm(rows[rows.length - 1].ts)} ${dmy(rows[rows.length - 1].ts)}`
    : "Không có dữ liệu trong khoảng này";
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="11" class="mut">Chưa có dữ liệu</td></tr>';
    return;
  }
  const list = rows.slice(-2000).reverse();
  const html = list.map((r) => {
    const ldr = [r.ldr1, r.ldr2, r.ldr3, r.ldr4].map((x) => Number(x) || 0);
    const chg = r.charge === true;
    return `<tr>
      <td>${dmy(r.ts)} ${hhmmss(r.ts)}</td>
      <td>${num(r.solarV, 2)}</td><td>${num(r.solarI, 3)}</td>
      <td>${num(r.power, 2)}</td><td>${num(r.energyWh, 1)}</td>
      <td>${num(r.batV, 2)}</td><td>${num(r.batPct, 0)}</td>
      <td>${chg ? '<span class="badge ok">Sạc</span>' : '<span class="badge">—</span>'}</td>
      <td>${ldr.join(" / ")}</td>
      <td>${num(r.az, 0)}°</td><td>${num(r.el, 0)}°</td>
    </tr>`;
  }).join("");
  tb.innerHTML = html;
}

$("btnCsv").addEventListener("click", () => {
  if (!hiRows.length) return;
  const head = ["ts", "date", "time", "solarV", "solarI", "power", "energyWh", "batV", "batPct", "charge", "ldr1", "ldr2", "ldr3", "ldr4", "az", "el"];
  const lines = [head.join(",")];
  for (const r of hiRows) {
    lines.push([r.ts, r.date, r.time, r.solarV, r.solarI, r.power, r.energyWh, r.batV, r.batPct, r.charge, r.ldr1, r.ldr2, r.ldr3, r.ldr4, r.az, r.el].join(","));
  }
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `solar_history_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ============================================================================
//  ANALYSIS — port AnalysisEngine.java (bỏ toàn bộ phần cảnh báo/thông báo)
// ============================================================================
const DAY_START = 420, DAY_END = 1020;       // 07:00 – 17:00 (AlertConfig mặc định)
const FULL_PCT = 98, LDR_LOW = 600;
const MIN_EVENT = 3 * MINU, MIN_ELIGIBLE = 10 * MINU;

function isDaytime(ts) {
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= DAY_START && m < DAY_END;
}

function analyze(rows, rStart, rEnd, now) {
  const span = Math.max(rEnd - rStart, 60 * MINU);
  const bucketMs = span <= 2 * DAYMS ? 3600000 : DAYMS;
  const nb = Math.max(1, Math.ceil(span / bucketMs));
  const buckets = new Array(nb).fill(0);
  const labels = [];
  for (let i = 0; i < nb; i++) {
    const t = rStart + i * bucketMs;
    labels.push(bucketMs === 3600000 ? p2(new Date(t).getHours()) + ":00" : dmy(t));
  }

  let dayMs = 0, sunMs = 0, fullMs = 0, eligMs = 0, chgMs = 0;
  let energyWh = 0, peak = 0, ldrMs = 0, offMs = 0, offDayMs = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], next = rows[i + 1], ts = Number(r.ts);
    let dt = next ? Number(next.ts) - ts : 0;
    if (dt > MIN_EVENT) {
      const gap = dt - MINU;
      offMs += gap;
      if (isDaytime(ts)) offDayMs += gap;
      dt = MINU;                             // mốc bị thiếu coi như 1 phút
    }
    if (dt < 0) dt = 0;

    const day = isDaytime(ts);
    const v = [Number(r.ldr1) || 0, Number(r.ldr2) || 0, Number(r.ldr3) || 0, Number(r.ldr4) || 0];
    const sum = v[0] + v[1] + v[2] + v[3];
    const sunny = day && sum >= NIGHT_MIN_SUM;
    const pct = Number(r.batPct) || 0;
    const p = Math.max(0, (Number(r.solarV) || 0) * (Number(r.solarI) || 0));
    const wh = p * dt / 3600000;

    energyWh += wh; peak = Math.max(peak, p);
    const bi = clamp(Math.floor((ts - rStart) / bucketMs), 0, nb - 1);
    buckets[bi] += wh;

    if (day) {
      dayMs += dt;
      if (v.some((x) => x < LDR_LOW)) ldrMs += dt;   // LDR bị che trong giờ nắng
    }
    if (sunny) sunMs += dt;
    if (pct >= FULL_PCT) fullMs += dt;
    if (sunny && pct < FULL_PCT) {
      eligMs += dt;
      if (r.charge === true) chgMs += dt;
    }
  }

  // đuôi mất kết nối (lần cuối > 6s so với hiện tại)
  const last = rows[rows.length - 1];
  if (last && rEnd >= now - 2 * MINU && now - Number(last.ts) > 6000) {
    const gap = now - Number(last.ts);
    offMs += gap;
    if (isDaytime(Number(last.ts))) offDayMs += gap;
  }

  const pctFirst = avg(rows.slice(0, 5).map((r) => Number(r.batPct) || 0));
  const pctLast = avg(rows.slice(-5).map((r) => Number(r.batPct) || 0));
  const gain = pctLast - pctFirst;

  const ratio = eligMs > 0 ? (chgMs / eligMs) * 100 : 0;
  let gainScore = sunMs > 0 && fullMs >= 0.3 * sunMs ? 100 : 100 * clamp(gain / 10, 0, 1);
  const incident = 100 * (1 - Math.min(1, (2 * (ldrMs + offDayMs)) / Math.max(1, dayMs + offDayMs)));

  let score;
  if (eligMs < MIN_ELIGIBLE) score = fullMs >= MIN_ELIGIBLE ? 100 : -1;
  else score = 0.6 * ratio + 0.25 * gainScore + 0.15 * incident;

  return {
    score, ratio, gain, gainScore, incident,
    sunMs, chgMs, eligMs, dayMs, fullMs, energyWh, peak,
    ldrMs, offMs, offDayMs, buckets, labels, bucketMs,
    pctFirst, pctLast, samples: rows.length, span,
    avgMw: chgMs > 0 ? energyWh * 1000 / (chgMs / 3600000) : 0
  };
}

wireChips("anChips", "anPick", (k, d) => { anRange = { k, d }; loadAnalysis(); });

let anBars = null, anSel = -1;

async function loadAnalysis() {
  const kind = anRange.k || anRange, dateStr = anRange.d || "";
  const rg = rangeOf(kind, dateStr);
  const now = Date.now();
  $("anMsg").hidden = false;
  $("anMsg").textContent = "Đang tải lịch sử…";
  $("anBody").hidden = true;
  try {
    const rows = await fetchRows(rg.start, rg.end);
    if (!rows.length) {
      $("anMsg").textContent = "Chưa có dữ liệu trong khoảng này.";
      return;
    }
    const A = analyze(rows, rg.start, rg.end, now);
    renderAnalysis(A, rg);
    $("anMsg").hidden = true;
    $("anBody").hidden = false;
  } catch (e) {
    $("anMsg").textContent = "Lỗi tải dữ liệu: " + (e.message || e);
  }
}

function renderAnalysis(A, rg) {
  $("anSun").textContent = dur(A.sunMs);

  $("anCharge").textContent = dur(A.chgMs);

  const g = A.gain;
  $("anGain").textContent = (g >= 0 ? "+" : "") + g.toFixed(0) + " %";

  $("anEnergy").textContent = A.energyWh.toFixed(1) + " Wh";

  $("anLdr").textContent = dur(A.ldrMs);
  $("anOff").textContent = dur(A.offMs) + (A.offDayMs > 0 ? ` (${dur(A.offDayMs)} ban ngày)` : "");
  $("anSamples").textContent = A.samples;
  $("anPeak").textContent = A.peak.toFixed(1) + " W";
  $("anRange").textContent = `${rg.label} · ${dmy(rg.start)} ${hhmm(rg.start)} → ${dmy(rg.end)} ${hhmm(rg.end)}`;

  $("anBucketUnit").textContent = A.bucketMs === 3600000 ? "giờ" : "ngày";
  anBars = { values: A.buckets, labels: A.labels, unit: "Wh", color: cssv("--g") };
  anSel = -1;
  drawBars();
}

function drawBars() {
  const cv = $("anBars");
  if (!cv || !cv.clientWidth || !anBars) return;
  const { ctx, w, h } = fit(cv, 170);
  ctx.clearRect(0, 0, w, h);
  const left = 44, right = w - 8, top = 18, bottom = h - 18;
  const n = anBars.values.length;
  const grid = cssv("--line"), mut = cssv("--mut");

  let max = 0;
  for (const v of anBars.values) max = Math.max(max, v);
  if (max <= 0) max = 1;

  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, bottom); ctx.lineTo(right, bottom);
  ctx.moveTo(left, top); ctx.lineTo(right, top);
  ctx.stroke();

  ctx.fillStyle = mut;
  ctx.font = '10px "Segoe UI",system-ui,sans-serif';
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ctx.fillText(max >= 100 ? max.toFixed(0) : max.toFixed(1), left - 6, top);
  ctx.fillText("0", left - 6, bottom);

  if (!n) return;
  const slot = (right - left) / n;
  const barW = Math.max(2, slot * 0.7);

  for (let i = 0; i < n; i++) {
    const cx = left + (i + 0.5) * slot;
    let barTop = bottom - (bottom - top) * (anBars.values[i] / max);
    if (anBars.values[i] > 0 && bottom - barTop < 2) barTop = bottom - 2;
    ctx.globalAlpha = i === anSel ? 1 : 0.8;
    ctx.fillStyle = anBars.color;
    roundRect(ctx, cx - barW / 2, barTop, barW, bottom - barTop, 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = mut; ctx.textAlign = "center"; ctx.textBaseline = "top";
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    ctx.fillText(anBars.labels[i], left + (i + 0.5) * slot, h - 14);
  }

  if (anSel >= 0 && anSel < n) {
    ctx.fillStyle = cssv("--txt"); ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.font = '700 11px "Segoe UI",system-ui,sans-serif';
    ctx.fillText(`${anBars.labels[anSel]}: ${anBars.values[anSel].toFixed(2)} ${anBars.unit}`, right, 2);
  }
}

$("anBars").addEventListener("pointermove", (e) => {
  if (!anBars) return;
  const cv = $("anBars"), rect = cv.getBoundingClientRect();
  const left = 44, right = rect.width - 8, n = anBars.values.length;
  const i = clamp(Math.floor(((e.clientX - rect.left) - left) / ((right - left) / n)), 0, n - 1);
  if (i !== anSel) { anSel = i; drawBars(); }
});

// ============================================================================
//  MANUAL CONTROL — ghi control + đọc lại để đồng bộ sau reload
// ============================================================================
let manual = false, dragging = false, pending = {}, flushTimer = null;

function sendControl(patch) {
  Object.assign(pending, patch);
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    const p = pending; pending = {}; flushTimer = null;
    try { await update(ref(db, DB_ROOT + "/control"), p); }
    catch (e) { console.warn("control write", e && e.message); }
  }, 150);
}

// Bật/tắt khả năng chỉnh tay: giống app Android — luôn hiện 2 thanh Az/El,
// nhưng ở chế độ tự động thì mờ + khoá.
function setManualEnabled(on) {
  const box = $("manualBox");
  if (box) box.classList.toggle("dim", !on);
  ["sldAz", "sldEl", "btnReset"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !on;
  });
}

function syncControlUI() {
  const c = D.control || {};
  const m = c.manual === true;
  manual = m;
  $("btnManual").classList.toggle("on", m);
  $("btnManual").textContent = m ? "Đang điều khiển thủ công — bấm để tắt" : "Bật chế độ điều khiển thủ công";
  setManualEnabled(m);
  $("ctlMode").textContent = m ? "Thủ công" : "Tự động";
  if (c.az !== undefined) $("ctlAz").textContent = c.az + "°";
  if (c.el !== undefined) $("ctlEl").textContent = c.el + "°";
  if (!dragging) {
    if (c.az !== undefined) { $("sldAz").value = c.az; $("azVal").textContent = c.az + "°"; }
    if (c.el !== undefined) { $("sldEl").value = c.el; $("elVal").textContent = c.el + "°"; }
  }
}

$("btnManual").addEventListener("click", () => {
  const on = !manual;
  manual = on;
  $("btnManual").classList.toggle("on", on);
  $("btnManual").textContent = on ? "Đang điều khiển thủ công — bấm để tắt" : "Bật chế độ điều khiển thủ công";
  setManualEnabled(on);
  sendControl({ manual: on, az: Number($("sldAz").value), el: Number($("sldEl").value) });
});

["sldAz", "sldEl"].forEach((id) => {
  const s = $(id);
  s.addEventListener("pointerdown", () => (dragging = true));
  s.addEventListener("pointerup", () => (dragging = false));
  s.addEventListener("blur", () => (dragging = false));
  s.addEventListener("input", () => {
    if (id === "sldAz") { $("azVal").textContent = s.value + "°"; sendControl({ az: Number(s.value) }); }
    else { $("elVal").textContent = s.value + "°"; sendControl({ el: Number(s.value) }); }
  });
});

$("btnReset").addEventListener("click", () => {
  $("sldAz").value = 90; $("sldEl").value = 90;
  $("azVal").textContent = "90°"; $("elVal").textContent = "90°";
  sendControl({ az: 90, el: 90 });
});

// ============================================================================
//  LIVE BADGE cho tab Phân tích
// ============================================================================
setInterval(() => {
  const L = curLight, b = D.battery, on = sigAt && Date.now() - sigAt < 6000;
  $("anLiveBadge").textContent = on ? "● ONLINE" : "○ OFFLINE";
  $("anLiveBadge").style.color = on ? "var(--g)" : "var(--r)";
  const sn = D.sensors;
  const ldrTxt = sn.ldr1 !== undefined ? `${sn.ldr1}/${sn.ldr2}/${sn.ldr3}/${sn.ldr4}` : "--";
  const pctLive = batteryPct(b.percentage);
  $("anLiveDetail").textContent =
    `${L ? L.label : "--"} · LDR ${ldrTxt} · pin ${pctLive === null ? "--" : pctLive}% · ${b.charging === true ? "đang sạc" : "không sạc"} · ${STATUS_VI[D.device.status] || D.device.status || "--"}`;
}, 1000);

// ============================================================================
//  RESIZE
// ============================================================================
let rt = null;
window.addEventListener("resize", () => {
  clearTimeout(rt);
  rt = setTimeout(() => { drawRadar(); drawChart(); drawBars(); }, 150);
});

// ============================================================================
//  BOOT
// ============================================================================
if (sessionStorage.getItem(AUTH_KEY) === "1") showApp();
else gate.hidden = false;
