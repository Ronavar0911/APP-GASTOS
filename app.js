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
  items.push(['r', 'Rango'], ['all', 'Todo']);
  $('mode-seg').innerHTML = items.map(([m, t]) => `<button data-mode="${m}" class="${state.mode === m ? 'on' : ''}">${t}</button>`).join('');
}

const picker = flatpickr('#range-input', {
  mode: 'range', locale: 'es', dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y', disableMobile: true,
  onChange: sel => { if (sel.length === 2) { state.range = [iso(sel[0]), iso(sel[1])]; state.limit = 10; render(); } }
});
const datePicker = flatpickr('#date', { locale: 'es', defaultDate: 'today', dateFormat: 'Y-m-d', altInput: true, altFormat: 'd/m/Y', disableMobile: true });

$('mode-seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.mode = b.dataset.mode; state.limit = 10;
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
  state.unsubs.forEach(u => u()); state.unsubs = [];
  if (!user) return;
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
  }, err => { console.error(err); alert('No se pudieron cargar los datos. Revisa las reglas de Firestore.'); }));
});
$('btn-login').onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => alert('Error al iniciar sesión: ' + e.message));
$('btn-logout').onclick = () => signOut(auth);

/* Gastos fijos: genera todas las repeticiones pendientes hasta hoy, con ID determinista (sin duplicados) */
function genFixed() {
  const today = iso(new Date()), seen = new Set();
  state.txs.forEach(t => { if (t.parentId) seen.add(`${t.parentId}|${t.date}`).add(`${t.parentId}|${t.date.slice(0, 7)}`); });
  for (const t of state.txs) {
    if (t.type !== 'expense' || !t.esFijo || t.parentId) continue;
    const b = parse(t.date);
    for (let i = 1; i <= 240; i++) {
      const d = t.repeticion === 'mensual'
        ? new Date(b.getFullYear(), b.getMonth() + i, Math.min(b.getDate(), new Date(b.getFullYear(), b.getMonth() + i + 1, 0).getDate()))
        : new Date(b.getFullYear(), b.getMonth(), b.getDate() + i * (t.repeticion === 'semanal' ? 7 : 15));
      const ds = iso(d); if (ds > today) break;
      const id = `${t.id}_${ds}`;
      if (state.allIds.has(id) || seen.has(`${t.id}|${t.repeticion === 'mensual' ? ds.slice(0, 7) : ds}`)) continue;
      state.allIds.add(id);
      const { id: _i, createdAt, ...rest } = t;
      setDoc(doc(db, 'transactions', id), { ...rest, date: ds, parentId: t.id, createdAt: serverTimestamp() }).catch(console.error);
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
    if (!clean[k].length) return alert('Necesitas al menos una categoría de ' + (k === 'expense' ? 'gasto' : 'ingreso') + '.');
  }
  state.freq = document.querySelector('input[name=freq]:checked').value;
  state.mode = 'p'; state.anchor = new Date(); state.limit = 10;
  applyCats(clean);
  $('settings').classList.remove('active'); render();
  try { await setDoc(doc(db, 'users', state.user.uid), { payFreq: state.freq, cats: clean }, { merge: true }); }
  catch (err) { console.error(err); alert('No se pudo guardar tu configuración.'); }
});

/* Ajustar un saldo al valor real (crea un movimiento de corrección: no es ingreso ni gasto) */
async function adjustBalance(target) {
  const b = balances(state.txs), cur = target === 'wallet' ? b.w : b.f;
  const msg = target === 'wallet' ? '¿Cuánto dinero tienes realmente disponible hoy (efectivo y cuentas, sin contar tu fondo)? (S/)' : '¿Cuánto hay realmente en tu fondo de ahorro hoy? (S/)';
  const raw = prompt(msg, cur.toFixed(2));
  if (raw === null) return;
  const real = parseFloat(raw.replace(',', '.'));
  if (isNaN(real)) return alert('Ingresa un monto válido.');
  if (target === 'fund' && real < 0) return alert('El fondo no puede ser negativo.');
  const diff = Math.round((real - cur) * 100) / 100;
  if (!diff) return;
  try {
    await addDoc(collection(db, 'transactions'), { userId: state.user.uid, type: 'adjust', target, amount: diff, date: iso(new Date()), category: target === 'wallet' ? 'Ajuste del saldo' : 'Ajuste del fondo', subcategory: 'Corrección de saldo', paymentMethod: '', source: target, createdAt: serverTimestamp() });
  } catch (err) { console.error(err); alert('No se pudo ajustar el saldo.'); }
}
$('btn-adjust').onclick = () => adjustBalance('fund');
$('btn-adjust-wallet').onclick = () => adjustBalance('wallet');

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
function render() {
  const { w, f } = balances(state.txs);
  $('wallet-balance').textContent = fmt(w);
  $('fund-balance').textContent = fmt(f);
  $('wallet-hint').textContent = w < 0 ? 'Saldo negativo: si cubriste con tu fondo, regístralo con "Retirar".' : `Patrimonio total: ${fmt(w + f)}`;

  renderSeg();
  const [s, e] = getRange();
  $('period-title').textContent = periodTitle([s, e]);
  $('range-input').style.display = state.mode === 'r' ? 'block' : 'none';
  if (state.mode === 'r') picker.setDate(state.range, false);
  const nav = ['m', 'q', 'w'].includes(kind());
  $('btn-prev').style.visibility = $('btn-next').style.visibility = nav ? 'visible' : 'hidden';

  const inRange = state.txs.filter(t => t.date >= s && t.date <= e);
  let income = 0, expense = 0, saved = 0, needs = 0, wants = 0, walletExp = 0;
  const byCat = {};
  for (const t of inRange) {
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'deposit') saved += t.amount;
    else if (t.type === 'withdraw') saved -= t.amount;
    else if (t.type === 'adjust') continue;
    else {
      expense += t.amount;
      if (t.source !== 'fund') walletExp += t.amount;
      byCat[t.category] = (byCat[t.category] || 0) + t.amount;
      CATS.expense[t.category]?.[1] === 'need' ? needs += t.amount : wants += t.amount;
    }
  }
  $('s-income').textContent = fmt(income);
  $('s-expense').textContent = fmt(expense);
  $('s-saved').textContent = fmt(saved);
  const net = income - walletExp - saved; // lo que ingresó menos lo que salió del saldo en el periodo
  $('period-label').textContent = 'Saldo del periodo · ' + periodTitle([s, e]);
  $('period-balance').textContent = fmt(net);
  $('period-balance').classList.toggle('neg', net < 0);

  $('rule').innerHTML = [
    barRow('Necesidades 50%', needs, income * .5, '#2563eb', true),
    barRow('Estilo de vida 30%', wants, income * .3, '#7c3aed', true),
    barRow('Ahorro 20%', Math.max(saved, 0), income * .2, '#06b6d4', false)
  ].join('');

  const today = iso(new Date());
  if (nav && today >= s && today <= e && walletExp > 0) {
    const passed = Math.round((parse(today) - parse(s)) / DAY) + 1, total = Math.round((parse(e) - parse(s)) / DAY) + 1;
    const avg = walletExp / passed;
    $('projection').innerHTML = `Gastas <b>${fmt(avg)}</b> al día. Al ritmo actual, cerrarás el periodo con <b>${fmt(income - avg * total)}</b> de lo que ingresó.`;
  } else $('projection').textContent = income > 0 ? 'Meta de ahorro: ' + fmt(income * .2) + ' en este periodo.' : 'Registra un ingreso para calcular tus metas.';

  renderChart(byCat);
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
  if (del && confirm('¿Eliminar este registro?')) {
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
$('fixed').onchange = e => $('repeat').hidden = !e.target.checked;

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
  }
  $('repeat').hidden = !$('fixed').checked;
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
  try {
    if (state.editing) await updateDoc(doc(db, 'transactions', state.editing), data);
    else {
      await addDoc(collection(db, 'transactions'), { ...data, createdAt: serverTimestamp() });
      // Buena práctica: págate primero. Sugerir el 20% al registrar un ingreso.
      if (type === 'income') {
        const part = Math.round(amount * 20) / 100;
        if (confirm(`Regla del 20%: ¿pasar ${fmt(part)} a tu fondo de ahorro ahora?`))
          await addDoc(collection(db, 'transactions'), { ...data, type: 'deposit', amount: part, category: 'Fondo de ahorro', subcategory: 'Ahorro 20%', paymentMethod: '', source: 'wallet', createdAt: serverTimestamp() });
      }
    }
    closeModal();
  } catch (err) { console.error(err); alert('No se pudo guardar. Intenta de nuevo.'); }
});
