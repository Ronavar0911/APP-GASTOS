const firebaseConfig = {
  apiKey: "AIzaSyAEHRutB81Q_z_NwJNuqXjsV_ELSE9LqVI",
  authDomain: "controldegastos-b716d.firebaseapp.com",
  projectId: "controldegastos-b716d",
  storageBucket: "controldegastos-b716d.firebasestorage.app",
  messagingSenderId: "195902348248",
  appId: "1:195902348248:web:61a14f4c11b46cfb0db0ad",
  measurementId: "G-XYMFY4Z47T"
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, collection, addDoc, query, where, onSnapshot, serverTimestamp, doc, deleteDoc, updateDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const fb = initializeApp(firebaseConfig), auth = getAuth(fb), db = getFirestore(fb);

/* ---------- Utilidades ---------- */
const $ = id => document.getElementById(id);
const fmt = v => new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(v);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => new Date(s + 'T00:00:00');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dShort = s => new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short' }).format(parse(s));
const DAY = 864e5;
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 3500); }
function ask(msg, ok = 'Aceptar', cancel = 'Ahora no') {
  return new Promise(res => {
    $('dialog-msg').textContent = msg; $('dialog-ok').textContent = ok; $('dialog-cancel').textContent = cancel;
    $('dialog').classList.add('active');
    const done = v => { $('dialog').classList.remove('active'); res(v); };
    $('dialog-ok').onclick = () => done(true); $('dialog-cancel').onclick = () => done(false);
  });
}

/* Cada categoría tiene su color; "need"/"want" alimenta la regla 50/30/20 */
const CATS = {
  expense: {
    "Alimentación": ["#2563eb", "need"], "Transporte": ["#7c3aed", "need"], "Vivienda": ["#0d9488", "need"],
    "Salud": ["#4f46e5", "need"], "Educación": ["#0284c7", "need"], "Entretenimiento": ["#f59e0b", "want"],
    "Streaming / Suscripciones": ["#e11d48", "want"], "Compras": ["#db2777", "want"], "Otros": ["#64748b", "want"]
  },
  income: {
    "Salario": ["#059669"], "Negocios / Ventas": ["#10b981"], "Inversiones": ["#14b8a6"],
    "Regalos / Premios": ["#84cc16"], "Otros": ["#64748b"]
  }
};
const FUND_COLOR = '#06b6d4';
const FUND_TYPES = ['deposit', 'withdraw', 'adjust'];
const colorOf = t => FUND_TYPES.includes(t.type) ? FUND_COLOR : (CATS[t.type]?.[t.category]?.[0] || '#94a3b8');
const HELP = {
  expense: 'Sale de tu saldo disponible, o de tu fondo si eliges pagar con él.',
  income: 'Suma a tu saldo disponible.',
  deposit: 'Mueve dinero del saldo al fondo. No cuenta como gasto.',
  withdraw: 'Mueve dinero del fondo al saldo. No cuenta como ingreso.'
};
const TITLES = { deposit: 'Guardado en el fondo', withdraw: 'Retiro del fondo', adjust: 'Ajuste del fondo' };

// freq: cómo recibes tu ingreso ('m' mensual por defecto, 'q' quincenal, 'w' semanal). mode: 'p' = tu periodo de pago, 'm' mes, 'r' rango, 'all' todo.
const state = { user: null, txs: [], allIds: new Set(), freq: 'm', mode: 'p', anchor: new Date(), range: null, filter: 'all', limit: 10, editing: null, chart: null, unsubs: [] };

/* Compatibilidad con datos antiguos: "Ahorro / Inversión" era un gasto, ahora es un traspaso al fondo */
function normalize(t) {
  if (t.type === 'expense' && t.category === 'Ahorro / Inversión') return { ...t, type: 'deposit', category: 'Fondo de ahorro' };
  return { source: 'wallet', ...t };
}

/* ---------- Periodos ---------- */
const FREQ = { m: 'Mes', q: 'Quincena', w: 'Semana' };
const kind = () => state.mode === 'p' ? state.freq : state.mode;
const addDays = (s, n) => { const d = parse(s); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); };
function periodOf(k, a) {
  const y = a.getFullYear(), m = a.getMonth();
  if (k === 'q') return a.getDate() <= 15 ? [iso(new Date(y, m, 1)), iso(new Date(y, m, 15))] : [iso(new Date(y, m, 16)), iso(new Date(y, m + 1, 0))];
  if (k === 'd') return [iso(a), iso(a)];
  if (k === 'w') { const s = new Date(y, m, a.getDate() - (a.getDay() + 6) % 7); return [iso(s), iso(addDays(iso(s), 6))]; } // lunes a domingo
  return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
}
function getRange() {
  const k = kind();
  if (k === 'r') return state.range || periodOf(state.freq, new Date());
  if (k === 'all') return ['0000-01-01', '9999-12-31'];
  return periodOf(k, state.anchor);
}
function periodTitle([s, e]) {
  const k = kind();
  if (k === 'all') return 'Todo el historial';
  if (k === 'd') return new Intl.DateTimeFormat('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(state.anchor);
  if (k === 'm') return new Intl.DateTimeFormat('es-PE', { month: 'long', year: 'numeric' }).format(state.anchor);
  return `${dShort(s)} – ${dShort(e)} ${parse(e).getFullYear()}`;
}
function shift(dir) {
  const k = kind(), [s, e] = getRange();
  if (k === 'm') state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + dir, 1);
  else state.anchor = dir > 0 ? addDays(e, 1) : addDays(s, -1);
  state.limit = 10; render();
}
function renderSeg() {
  const items = [['p', FREQ[state.freq]]];
  if (state.freq !== 'm') items.push(['m', 'Mes']);
  items.push(['d', 'Día'], ['r', 'Rango'], ['all', 'Todo']);
  $('mode-seg').innerHTML = items.map(([m, t]) => `<button data-mode="${m}" class="${state.mode === m ? 'on' : ''}">${t}</button>`).join('');
}

const picker = flatpickr('#range-input', {
  mode: 'range', locale: 'es', dateFormat: 'Y-m-d', altInput: true, altInputClass: 'range-alt', altFormat: 'd/m/Y', disableMobile: true,
  onClose: sel => { if (sel.length === 1) { state.range = [iso(sel[0]), iso(sel[0])]; state.limit = 10; render(); } }, // un solo día
  onChange: sel => { if (sel.length === 2) { state.range = [iso(sel[0]), iso(sel[1])]; state.limit = 10; render(); } }
});
const datePicker = flatpickr('#date', { locale: 'es', defaultDate: 'today', dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y', disableMobile: true });

// Saltar directo a cualquier fecha tocando el título del periodo
const jump = flatpickr('#jump-input', {
  locale: 'es', clickOpens: false, disableMobile: true,
  onChange: sel => { if (sel[0]) { state.anchor = sel[0]; state.limit = 10; render(); } }
});
$('period-title').onclick = () => { jump.setDate(state.anchor, false); jump.open(); };

$('mode-seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.mode = b.dataset.mode; state.limit = 10;
  if (state.mode === 'd') state.anchor = new Date();
  if (state.mode === 'r' && !state.range) state.range = periodOf(state.freq, new Date());
  render();
  if (state.mode === 'r') picker.open();
});
$('btn-prev').onclick = () => shift(-1);
$('btn-next').onclick = () => shift(1);

/* ---------- Auth y datos ---------- */
let askedFreq = false;
onAuthStateChanged(auth, user => {
  state.user = user;
  $('login-screen').classList.toggle('active', !user);
  $('app-screen').classList.toggle('active', !!user);
  $('boot').classList.add('off');
  state.unsubs.forEach(u => u()); state.unsubs = [];
  if (!user) { state.txs = []; window.scrollTo(0, 0); return; }
  $('user-name').textContent = user.displayName || 'Usuario';
  $('user-avatar').src = user.photoURL || '';
  // Configuración del usuario (frecuencia de ingreso). Sin configurar = mensual.
  state.unsubs.push(onSnapshot(doc(db, 'users', user.uid), snap => {
    const f = snap.data()?.payFreq; applyCats(snap.data()?.cats);
    if (f && f !== state.freq) { state.freq = f; state.mode = 'p'; }
    if (!snap.exists() && !askedFreq) { askedFreq = true; openSettings(); }
    render();
  }, console.error));
  state.unsubs.push(onSnapshot(query(collection(db, 'transactions'), where('userId', '==', user.uid)), snap => {
    state.allIds = new Set(snap.docs.map(d => d.id));
    state.txs = snap.docs.map(d => normalize({ id: d.id, ...d.data() })).filter(t => !t.hidden)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    genFixed(); render();
  }, err => { console.error(err); toast('No se pudieron cargar los datos. Revisa las reglas de Firestore.'); }));
});
$('btn-login').onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => toast('Error al iniciar sesión: ' + e.message));
$('btn-logout').onclick = () => signOut(auth);

/* ---------- Gastos fijos ----------
   modoFijo 'vez'  : el monto se registra completo en cada repetición.
   modoFijo 'total': el monto es el total del MES y se reparte en partes iguales entre los días del patrón (laboral, diario, semanal). */
const SPLITTABLE = ['laboral', 'diario', 'semanal'];
const isSplit = t => t.modoFijo === 'total' && SPLITTABLE.includes(t.repeticion);
const matchDay = (t, d) => t.repeticion === 'laboral' ? d.getDay() % 6 !== 0 : t.repeticion === 'semanal' ? d.getDay() === parse(t.date).getDay() : true;
function monthDates(t, y, m) {
  const out = [];
  for (let d = 1, n = new Date(y, m + 1, 0).getDate(); d <= n; d++) { const dt = new Date(y, m, d); if (matchDay(t, dt)) out.push(iso(dt)); }
  return out;
}
// Si la fecha cae en un día que no corresponde al patrón (p. ej. sábado en "laborables"), se mueve al siguiente día que sí corresponde.
function snapDate(t) {
  for (let i = 0; i <= 7; i++) { const ds = iso(addDays(t.date, i)); if (matchDay(t, parse(ds))) return ds; }
  return t.date;
}
function shareOf(t, ds) {
  if (!isSplit(t)) return t.amount;
  return Math.round(t.total / monthDates(t, +ds.slice(0, 4), +ds.slice(5, 7) - 1).length * 100) / 100;
}
// Fechas (después de from, hasta to) donde se registra la repetición. No incluye la fecha de la propia plantilla.
function occurrences(t, from, to) {
  const out = [], b = parse(t.date), r = t.repeticion;
  if (isSplit(t)) { // todo el mes de la plantilla, incluidos los días anteriores a su fecha
    for (let k = 0; k < 120; k++) {
      const y = b.getFullYear(), m = b.getMonth() + k;
      if (iso(new Date(y, m, 1)) > to) break;
      for (const ds of monthDates(t, y, m)) if (ds > from && ds <= to && ds !== t.date) out.push(ds);
    }
    return out;
  }
  for (let i = 1; i <= 800; i++) {
    const d = r === 'mensual'
      ? new Date(b.getFullYear(), b.getMonth() + i, Math.min(b.getDate(), new Date(b.getFullYear(), b.getMonth() + i + 1, 0).getDate()))
      : new Date(b.getFullYear(), b.getMonth(), b.getDate() + i * (r === 'semanal' ? 7 : r === 'quincenal' ? 15 : 1));
    const ds = iso(d); if (ds > to) break;
    if (ds <= from || (r === 'laboral' && (d.getDay() === 0 || d.getDay() === 6))) continue;
    out.push(ds);
  }
  return out;
}
/* Crea las repeticiones pendientes hasta hoy, con ID determinista (sin duplicados) */
function genFixed() {
  const today = iso(new Date()), seen = new Set();
  state.txs.forEach(t => { if (t.parentId) seen.add(`${t.parentId}|${t.date}`).add(`${t.parentId}|${t.date.slice(0, 7)}`); });
  for (const t of state.txs) {
    if (t.type !== 'expense' || !t.esFijo || t.parentId) continue;
    for (const ds of occurrences(t, isSplit(t) ? '0000-00-00' : t.date, today)) {
      const id = `${t.id}_${ds}`;
      if (state.allIds.has(id) || seen.has(`${t.id}|${t.repeticion === 'mensual' ? ds.slice(0, 7) : ds}`)) continue;
      state.allIds.add(id);
      const { id: _i, createdAt, ...rest } = t;
      setDoc(doc(db, 'transactions', id), { ...rest, date: ds, amount: shareOf(t, ds), parentId: t.id, createdAt: serverTimestamp() }).catch(console.error);
    }
  }
}

/* ---------- Ajustes: frecuencia, categorías y fondo ---------- */
const PALETTE = ['#2563eb', '#7c3aed', '#0d9488', '#f59e0b', '#e11d48', '#db2777', '#0284c7', '#84cc16', '#ea580c', '#64748b'];
let draft = { expense: [], income: [] };

function applyCats(c) {
  if (!c) return;
  for (const k of ['expense', 'income']) if (c[k]?.length) CATS[k] = Object.fromEntries(c[k].map(x => [x.n, [x.c, x.b]]));
  $('filter').removeAttribute('data-ready');
}
function renderCatEditor() {
  for (const k of ['expense', 'income'])
    $('cats-' + k).innerHTML = draft[k].map((c, i) => `<div class="cat-row" data-k="${k}" data-i="${i}">
      <input type="color" value="${c.c}" data-f="c" aria-label="Color"><input type="text" value="${esc(c.n)}" maxlength="24" data-f="n" placeholder="Nombre">
      ${k === 'expense' ? `<select data-f="b"><option value="need"${c.b === 'need' ? ' selected' : ''}>Necesidad</option><option value="want"${c.b !== 'need' ? ' selected' : ''}>Gusto</option></select>` : ''}
      <button type="button" data-rm aria-label="Quitar">🗑️</button></div>`).join('');
}
function openSettings() {
  document.querySelector(`input[name=freq][value=${state.freq}]`).checked = true;
  for (const k of ['expense', 'income']) draft[k] = Object.entries(CATS[k]).map(([n, v]) => k === 'expense' ? { n, c: v[0], b: v[1] } : { n, c: v[0] });
  renderCatEditor();
  $('settings').classList.add('active');
}
$('btn-settings').onclick = openSettings;
$('btn-close-settings').onclick = () => $('settings').classList.remove('active');
$('settings-form').addEventListener('input', e => {
  const row = e.target.closest('.cat-row'); if (!row || !e.target.dataset.f) return;
  draft[row.dataset.k][row.dataset.i][e.target.dataset.f] = e.target.value;
});
$('settings-form').addEventListener('click', e => {
  const add = e.target.closest('[data-add]'), rm = e.target.closest('[data-rm]');
  if (add) { const k = add.dataset.add; draft[k].push(k === 'expense' ? { n: '', c: PALETTE[draft[k].length % 10], b: 'want' } : { n: '', c: PALETTE[draft[k].length % 10] }); renderCatEditor(); }
  if (rm) { const r = rm.closest('.cat-row'); draft[r.dataset.k].splice(r.dataset.i, 1); renderCatEditor(); }
});
$('settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const clean = {};
  for (const k of ['expense', 'income']) {
    const seen = new Set();
    clean[k] = draft[k].map(c => ({ ...c, n: c.n.trim() })).filter(c => c.n && !seen.has(c.n.toLowerCase()) && seen.add(c.n.toLowerCase()));
    if (!clean[k].length) return toast('Necesitas al menos una categoría de ' + (k === 'expense' ? 'gasto' : 'ingreso') + '.');
  }
  state.freq = document.querySelector('input[name=freq]:checked').value;
  state.mode = 'p'; state.anchor = new Date(); state.limit = 10;
  applyCats(clean);
  $('settings').classList.remove('active'); render();
  try { await setDoc(doc(db, 'users', state.user.uid), { payFreq: state.freq, cats: clean }, { merge: true }); }
  catch (err) { console.error(err); toast('No se pudo guardar tu configuración.'); }
});

/* Ajustar un saldo al valor real (movimiento de corrección: no es ingreso ni gasto) */
let adjTarget = 'wallet';
const adjCur = () => { const b = balances(state.txs); return adjTarget === 'wallet' ? b.w : b.f; };
function updateDiff() {
  const v = parseFloat($('adjust-amount').value), d = Math.round((v - adjCur()) * 100) / 100;
  $('adjust-diff').textContent = isNaN(v) ? '' : d === 0 ? 'Sin cambios.' : `Se registrará un ajuste de ${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}.`;
}
function openAdjust(target) {
  adjTarget = target;
  $('adjust-title').textContent = target === 'wallet' ? 'Ajustar saldo disponible' : 'Ajustar fondo de ahorro';
  $('adjust-help').textContent = `Según la app tienes ${fmt(adjCur())}. Escribe cuánto tienes realmente ${target === 'wallet' ? '(efectivo y cuentas, sin contar tu fondo)' : 'guardado'} y registraremos la diferencia como corrección. No cuenta como ingreso ni gasto.`;
  $('adjust-amount').value = adjCur().toFixed(2);
  updateDiff(); $('adjust').classList.add('active');
}
$('adjust-amount').oninput = updateDiff;
$('btn-close-adjust').onclick = () => $('adjust').classList.remove('active');
$('btn-adjust').onclick = () => openAdjust('fund');
$('btn-adjust-wallet').onclick = () => openAdjust('wallet');
$('adjust-form').addEventListener('submit', async e => {
  e.preventDefault();
  const real = parseFloat($('adjust-amount').value);
  if (isNaN(real) || (adjTarget === 'fund' && real < 0)) return toast('Ingresa un monto válido.');
  const diff = Math.round((real - adjCur()) * 100) / 100;
  $('adjust').classList.remove('active');
  if (!diff) return;
  try {
    await addDoc(collection(db, 'transactions'), { userId: state.user.uid, type: 'adjust', target: adjTarget, amount: diff, date: iso(new Date()), category: adjTarget === 'wallet' ? 'Ajuste del saldo' : 'Ajuste del fondo', subcategory: 'Corrección de saldo', paymentMethod: '', source: adjTarget, createdAt: serverTimestamp() });
    toast('Saldo ajustado.');
  } catch (err) { console.error(err); toast('No se pudo ajustar el saldo.'); }
});

/* ---------- Cálculos ---------- */
function balances(txs) {
  let w = 0, f = 0;
  for (const t of txs) {
    if (t.type === 'income') w += t.amount;
    else if (t.type === 'expense') t.source === 'fund' ? f -= t.amount : w -= t.amount;
    else if (t.type === 'deposit') { w -= t.amount; f += t.amount; }
    else if (t.type === 'withdraw') { w += t.amount; f -= t.amount; }
    else if (t.type === 'adjust') t.target === 'wallet' ? w += t.amount : f += t.amount;
  }
  return { w, f };
}

/* ---------- Render ---------- */
function summarize(list) {
  const r = { income: 0, expense: 0, saved: 0, needs: 0, wants: 0, walletExp: 0, fixedW: 0, varW: 0, byCat: {} };
  for (const t of list) {
    if (t.type === 'income') r.income += t.amount;
    else if (t.type === 'deposit') r.saved += t.amount;
    else if (t.type === 'withdraw') r.saved -= t.amount;
    else if (t.type === 'adjust') continue;
    else {
      r.expense += t.amount;
      if (t.source !== 'fund') { r.walletExp += t.amount; t.esFijo ? r.fixedW += t.amount : r.varW += t.amount; }
      r.byCat[t.category] = (r.byCat[t.category] || 0) + t.amount;
      CATS.expense[t.category]?.[1] === 'need' ? r.needs += t.amount : r.wants += t.amount;
    }
  }
  return r;
}

function render() {
  const { w, f } = balances(state.txs);
  $('wallet-balance').textContent = fmt(w);
  $('fund-balance').textContent = fmt(f);
  $('wallet-hint').textContent = w < 0 ? 'Saldo negativo: si cubriste con tu fondo, regístralo con "Retirar".' : `Patrimonio total: ${fmt(w + f)}`;

  renderSeg();
  const [s, e] = getRange(), title = periodTitle([s, e]), today = iso(new Date());
  const jumpable = !['r', 'all'].includes(kind());
  $('period-title').textContent = title + (jumpable ? ' ▾' : '');
  $('period-title').disabled = !jumpable;
  $('period-center').classList.toggle('range-on', state.mode === 'r');
  if (state.mode === 'r') picker.setDate(state.range, false);
  const nav = ['m', 'q', 'w', 'd'].includes(kind());
  $('btn-prev').style.visibility = $('btn-next').style.visibility = nav ? 'visible' : 'hidden';

  const inRange = state.txs.filter(t => t.date >= s && t.date <= e);
  const R = summarize(inRange); // lo ocurrido en la vista elegida
  // Si la vista (un día, una semana, un rango…) cae dentro de un ciclo de pago, el saldo y la regla 50/30/20
  // se calculan con todo ese ciclo hasta la fecha final: el sueldo del día 1 sigue financiando el resto del mes.
  const cyc = periodOf(state.freq, parse(kind() === 'all' ? today : e));
  const sub = kind() !== 'all' && s >= cyc[0] && e <= cyc[1] && !(s === cyc[0] && e === cyc[1]);
  const C = sub ? summarize(state.txs.filter(t => t.date >= cyc[0] && t.date <= e)) : R;

  $('s-income').textContent = fmt(R.income);
  $('s-expense').textContent = fmt(R.expense);
  $('s-saved').textContent = fmt(R.saved);
  $('stats-note').textContent = sub ? `Estos tres números son solo de ${title}. El saldo del ciclo y la regla 50/30/20 usan todo el ciclo (${dShort(cyc[0])} – ${dShort(cyc[1])}) hasta el ${dShort(e)}.` : '';
  const net = C.income - C.walletExp - C.saved; // ingresos del ciclo menos lo que salió del saldo
  $('period-label').textContent = sub ? `Saldo del ciclo hasta el ${dShort(e)}` : 'Saldo del periodo · ' + title;
  $('period-balance').textContent = fmt(net);
  $('period-balance').classList.toggle('neg', net < 0);

  $('rule').innerHTML = [
    barRow('Necesidades 50%', C.needs, C.income * .5, '#2563eb', true),
    barRow('Estilo de vida 30%', C.wants, C.income * .3, '#7c3aed', true),
    barRow('Ahorro 20%', Math.max(C.saved, 0), C.income * .2, '#06b6d4', false)
  ].join('');

  if ((state.mode === 'p' || kind() === 'm') && ['m', 'q', 'w'].includes(kind()) && today >= s && today <= e && (C.walletExp > 0 || C.income > 0)) {
    const passed = Math.round((parse(today) - parse(s)) / DAY) + 1, total = Math.round((parse(e) - parse(s)) / DAY) + 1;
    const avg = C.varW / passed; // solo gastos variables: los fijos cuentan únicamente en sus fechas
    const upcoming = state.txs.filter(t => t.type === 'expense' && t.esFijo && !t.parentId && t.source !== 'fund')
      .reduce((a, t) => a + occurrences(t, today, e).reduce((x, ds) => x + shareOf(t, ds), 0), 0);
    $('projection').innerHTML = `Gastos variables: <b>${fmt(avg)}</b> al día. Fijos del periodo: <b>${fmt(C.fixedW + upcoming)}</b> (solo en sus fechas). Proyección de cierre: <b>${fmt(C.income - C.fixedW - upcoming - avg * total)}</b>.`;
  } else $('projection').textContent = kind() === 'all' ? 'Esta vista suma todo tu historial. Para evaluar tu 50/30/20 mira un mes o un rango concreto.'
    : sub ? `Regla calculada sobre los ingresos de tu ciclo de pago (${dShort(cyc[0])} – ${dShort(cyc[1])}).`
    : C.income > 0 ? 'Meta de ahorro: ' + fmt(C.income * .2) + ' en este periodo.' : 'Registra un ingreso para calcular tus metas.';

  renderChart(R.byCat);
  renderFilter();
  renderList(inRange);
}

function barRow(label, v, target, color, isLimit) {
  const pct = target > 0 ? Math.min(v / target * 100, 100) : 0;
  const c = isLimit ? (v > target ? '#e11d48' : v > target * .8 ? '#f59e0b' : color) : (target > 0 && v >= target ? '#059669' : color);
  return `<div class="bar-row"><div class="top"><span>${label}</span><b>${fmt(v)} / ${fmt(target)}</b></div><div class="bar"><i style="width:${pct}%;background:${c}"></i></div></div>`;
}

function renderChart(byCat) {
  const labels = Object.keys(byCat), data = Object.values(byCat);
  state.chart?.destroy();
  state.chart = new Chart($('chart'), {
    type: 'doughnut',
    data: {
      labels: labels.length ? labels : ['Sin gastos'],
      datasets: [{ data: data.length ? data : [1], backgroundColor: labels.length ? labels.map(l => CATS.expense[l]?.[0] || '#94a3b8') : ['#e2e8f3'], borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#0f1f3d', font: { family: 'Manrope' }, boxWidth: 12 } },
        tooltip: { callbacks: { label: c => labels.length ? ` ${c.label}: ${fmt(c.parsed)}` : ' Aún no hay gastos' } }
      }
    }
  });
}

function renderFilter() {
  const sel = $('filter');
  if (!sel.dataset.ready) {
    const opt = (v, t) => `<option value="${v}">${t}</option>`;
    sel.innerHTML = opt('all', 'Todo') + opt('t:income', 'Ingresos') + opt('t:expense', 'Gastos') + opt('t:fund', 'Movimientos del fondo') +
      '<optgroup label="Categorías de gasto">' + Object.keys(CATS.expense).map(c => opt('c:' + c, c)).join('') + '</optgroup>' +
      '<optgroup label="Categorías de ingreso">' + Object.keys(CATS.income).map(c => opt('c:' + c, c)).join('') + '</optgroup>';
    sel.dataset.ready = 1;
    sel.onchange = () => { state.filter = sel.value; state.limit = 10; render(); };
  }
}

function renderList(inRange) {
  const f = state.filter;
  const list = inRange.filter(t =>
    f === 'all' || (f === 't:fund' ? FUND_TYPES.includes(t.type) :
      f.startsWith('t:') ? t.type === f.slice(2) : t.category === f.slice(2)));
  const box = $('tx-list');
  if (!list.length) box.innerHTML = '<div class="empty">No hay movimientos en este periodo. Toca "+ Nuevo registro" para añadir el primero.</div>';
  else box.innerHTML = list.slice(0, state.limit).map(t => {
    const fund = FUND_TYPES.includes(t.type);
    const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : t.type === 'adjust' && t.amount > 0 ? '+' : '';
    const cls = t.type === 'income' ? 'pos' : t.type === 'expense' ? 'neg' : 'sav';
    const icon = t.type === 'income' ? '↓' : t.type === 'expense' ? '↑' : t.type === 'deposit' ? '⇥' : t.type === 'adjust' ? '≈' : '⇤';
    const tag = t.type === 'adjust' ? 'corrección manual' : t.type === 'deposit' ? 'saldo → fondo' : t.type === 'withdraw' ? 'fondo → saldo' : (t.source === 'fund' ? 'pagado con fondo' : '');
    const sub = [dShort(t.date), t.subcategory || t.note, !fund && t.paymentMethod].filter(Boolean).map(esc).join(' · ');
    return `<div class="tx"><div class="dot" style="background:${colorOf(t)}">${icon}</div>
      <div class="info"><b>${t.esFijo ? '🔒 ' : ''}${esc(t.type === 'adjust' && t.target === 'wallet' ? 'Ajuste del saldo' : TITLES[t.type] || t.category)}</b><small>${sub}</small></div>
      <div class="amt ${cls}">${sign}${fmt(t.amount)}${tag ? `<small>${tag}</small>` : ''}</div>
      <div class="acts">${t.type === 'adjust' ? '' : `<button data-edit="${t.id}" aria-label="Editar">✏️</button>`}<button data-del="${t.id}" aria-label="Eliminar">🗑️</button></div></div>`;
  }).join('');
  $('btn-more').hidden = list.length <= state.limit;
}
$('btn-more').onclick = () => { state.limit += 10; render(); };
$('tx-list').addEventListener('click', async e => {
  const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
  if (ed) openModal(null, state.txs.find(t => t.id === ed.dataset.edit));
  if (del && await ask('¿Eliminar este registro?', 'Eliminar', 'Cancelar')) {
    const t = state.txs.find(x => x.id === del.dataset.del), ref = doc(db, 'transactions', del.dataset.del);
    // Los gastos fijos autogenerados se ocultan (si se borraran, volverían a generarse)
    t?.parentId ? await updateDoc(ref, { hidden: true }) : await deleteDoc(ref);
  }
});

/* ---------- Formulario ---------- */
const typeVal = () => document.querySelector('input[name=type]:checked').value;
function applyType() {
  const t = typeVal();
  document.querySelectorAll('[data-for]').forEach(el => el.hidden = !el.dataset.for.split(' ').includes(t));
  $('type-help').textContent = HELP[t];
  if (CATS[t]) $('category').innerHTML = Object.keys(CATS[t]).map(c => `<option>${c}</option>`).join('');
}
document.querySelectorAll('input[name=type]').forEach(r => r.onchange = applyType);
const REP_TXT = { laboral: 'cada día laborable (lun–vie)', diario: 'todos los días', semanal: 'cada semana', quincenal: 'cada 15 días' };
function updateFixedUI() {
  const on = $('fixed').checked, rep = $('repeat').value, canSplit = SPLITTABLE.includes(rep);
  $('repeat-box').hidden = !on; $('mode-box').hidden = !canSplit;
  if (!on) return;
  const amt = parseFloat($('amount').value) || 0, date = $('date').value || iso(new Date()), money = fmt(amt);
  let txt;
  if (rep === 'mensual') txt = `Se registrará ${money} el día ${parse(date).getDate()} de cada mes.`;
  else if (canSplit && $('fixed-mode').value === 'total') {
    const t = { repeticion: rep, date, modoFijo: 'total', total: amt }, sd = snapDate(t);
    txt = `Los ${money} son el total de cada mes y se reparten en partes iguales entre ${rep === 'laboral' ? 'los días laborables' : rep === 'diario' ? 'todos los días' : 'las semanas'} del mes (≈ ${fmt(shareOf({ ...t, date: sd }, sd))} por día este mes).`;
  } else txt = `Se registrará ${money} ${REP_TXT[rep]} desde la fecha elegida.`;
  $('fixed-help').textContent = txt;
}
['fixed', 'repeat', 'fixed-mode', 'amount', 'date'].forEach(id => ['input', 'change'].forEach(ev => $(id).addEventListener(ev, updateFixedUI)));

function openModal(type, tx) {
  state.editing = tx?.id || null;
  $('tx-form').reset();
  document.querySelector(`input[name=type][value=${tx?.type || type || 'expense'}]`).checked = true;
  applyType();
  $('modal-title').textContent = tx ? 'Editar registro' : 'Nuevo registro';
  datePicker.setDate(tx?.date || new Date());
  if (tx) {
    $('amount').value = tx.amount; if (CATS[tx.type] && !CATS[tx.type][tx.category]) $('category').add(new Option(tx.category)); $('category').value = tx.category; $('note').value = tx.subcategory || tx.note || '';
    $('method').value = tx.paymentMethod || 'Efectivo'; $('source').value = tx.source || 'wallet';
    $('fixed').checked = !!tx.esFijo; $('repeat').value = tx.repeticion || 'mensual';
    $('fixed-mode').value = tx.modoFijo || 'vez';
    if (tx.modoFijo === 'total' && !tx.parentId) $('amount').value = tx.total; // se edita el total mensual, no la parte
  }
  updateFixedUI();
  $('modal').classList.add('active');
}
const closeModal = () => $('modal').classList.remove('active');
$('btn-add').onclick = () => openModal();
$('btn-close').onclick = closeModal;
$('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.querySelectorAll('[data-quick]').forEach(b => b.onclick = () => openModal(b.dataset.quick));

$('tx-form').addEventListener('submit', async e => {
  e.preventDefault();
  const type = typeVal(), amount = parseFloat($('amount').value), date = $('date').value;
  const isFund = type === 'deposit' || type === 'withdraw';
  const data = {
    userId: state.user.uid, type, amount, date, subcategory: $('note').value.trim(),
    category: isFund ? 'Fondo de ahorro' : $('category').value,
    paymentMethod: isFund ? '' : $('method').value,
    source: type === 'expense' ? $('source').value : 'wallet',
    esFijo: type === 'expense' && $('fixed').checked,
    repeticion: type === 'expense' && $('fixed').checked ? $('repeat').value : null
  };
  const isChild = state.editing && state.txs.find(x => x.id === state.editing)?.parentId; // repeticiones generadas: no redefinen la regla
  if (isChild) { delete data.esFijo; delete data.repeticion; }
  else if (data.esFijo) {
    const split = SPLITTABLE.includes(data.repeticion) && $('fixed-mode').value === 'total';
    Object.assign(data, { modoFijo: split ? 'total' : 'vez', total: split ? amount : null });
    if (split) {
      data.date = snapDate(data);
      data.amount = shareOf(data, data.date);
      if (data.date !== date) toast('La fecha se movió al siguiente día que corresponde (' + dShort(data.date) + ').');
    }
  } else Object.assign(data, { modoFijo: null, total: null });
  try {
    if (state.editing) await updateDoc(doc(db, 'transactions', state.editing), data);
    else {
      await addDoc(collection(db, 'transactions'), { ...data, createdAt: serverTimestamp() });
      // Buena práctica: págate primero. Sugerir el 20% al registrar un ingreso.
      if (type === 'income') {
        const part = Math.round(amount * 20) / 100;
        if (await ask(`Regla del 20%: ¿pasar ${fmt(part)} a tu fondo de ahorro ahora?`, 'Sí, guardar', 'Ahora no'))
          await addDoc(collection(db, 'transactions'), { ...data, type: 'deposit', amount: part, category: 'Fondo de ahorro', subcategory: 'Ahorro 20%', paymentMethod: '', source: 'wallet', createdAt: serverTimestamp() });
      }
    }
    closeModal();
  } catch (err) { console.error(err); toast('No se pudo guardar. Intenta de nuevo.'); }
});
