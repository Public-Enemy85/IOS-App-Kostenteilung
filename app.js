'use strict';

const DEFAULT_CATEGORIES = ['Taschengeld','Schule','Kleidung'];
const FIXED_PAYERS = ['Sebastian','Sandra'];
const DB_NAME = 'kostenEinfachDB';
const EXPENSE_STORE = 'expenses';
const STAY_STORE = 'stays';
let db;
let currentReceiptBlob = null;
let removeExistingReceipt = false;
let deferredPrompt = null;
let currentExpenses = [];
let currentStays = [];
let stayMode = 'Sebastian';

const money = v => new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(v || 0);
const fmtDays = v => `${new Intl.NumberFormat('de-DE',{maximumFractionDigits:1}).format(v || 0)} ${Math.abs((v || 0)-1)<0.0001?'Tag':'Tage'}`;
const fmtDate = iso => iso ? new Intl.DateTimeFormat('de-DE').format(new Date(iso+'T12:00:00')) : '';
const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};
const currentMonthISO = () => todayISO().slice(0,7);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const el = id => document.getElementById(id);

function toast(msg) {
  const t = el('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(()=>t.classList.remove('show'),2200);
}
function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function parseAmount(value) {
  const cleaned = String(value).trim().replace(/\s/g,'').replace(/\./g,'').replace(',','.').replace(/[^0-9.-]/g,'');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n*100)/100 : NaN;
}
function daysInMonth(year, monthIndex) { return new Date(year, monthIndex+1, 0).getDate(); }
function isoForMonthDay(year, monthIndex, day) {
  const safeDay=Math.min(day,daysInMonth(year,monthIndex));
  return `${year}-${String(monthIndex+1).padStart(2,'0')}-${String(safeDay).padStart(2,'0')}`;
}

function openDB() {
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME,2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(EXPENSE_STORE)) d.createObjectStore(EXPENSE_STORE,{keyPath:'id'});
      if (!d.objectStoreNames.contains(STAY_STORE)) d.createObjectStore(STAY_STORE,{keyPath:'date'});
    };
    req.onsuccess = ()=>{ db=req.result; resolve(db); };
    req.onerror = ()=>reject(req.error);
  });
}
function storeTx(store,mode='readonly') { return db.transaction(store,mode).objectStore(store); }
function storeAll(store) { return new Promise((res,rej)=>{ const r=storeTx(store).getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }
function storeGet(store,key) { return new Promise((res,rej)=>{ const r=storeTx(store).get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
function storePut(store,item) { return new Promise((res,rej)=>{ const r=storeTx(store,'readwrite').put(item); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function storeDelete(store,key) { return new Promise((res,rej)=>{ const r=storeTx(store,'readwrite').delete(key); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function storeClear(store) { return new Promise((res,rej)=>{ const r=storeTx(store,'readwrite').clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
const dbAll = () => storeAll(EXPENSE_STORE);
const dbGet = id => storeGet(EXPENSE_STORE,id);
const dbPut = item => storePut(EXPENSE_STORE,item);
const dbDelete = id => storeDelete(EXPENSE_STORE,id);
const dbClear = () => storeClear(EXPENSE_STORE);
const stayAll = () => storeAll(STAY_STORE);
const stayPut = item => storePut(STAY_STORE,item);
const stayDelete = date => storeDelete(STAY_STORE,date);
const stayClear = () => storeClear(STAY_STORE);

function loadList(key, fallback=[]) {
  try { const x=JSON.parse(localStorage.getItem(key)); return Array.isArray(x) ? x : fallback; } catch { return fallback; }
}
function saveList(key, arr) {
  localStorage.setItem(key,JSON.stringify([...new Set(arr.map(x=>String(x).trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'de'))));
}
function categories() {
  return [...new Set([...DEFAULT_CATEGORIES,...loadList('customCategories'),...currentExpenses.map(x=>x.category).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'de'));
}
function filterPayers() { return [...new Set([...FIXED_PAYERS,...currentExpenses.map(x=>x.paidBy).filter(Boolean)])]; }

function refreshSelectors() {
  const categorySelect = el('category');
  const selectedCategory = categorySelect.value;
  categorySelect.innerHTML = '<option value="">Bitte auswählen</option>' + categories().map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('') + '<option value="__new__">+ Neue Kategorie anlegen …</option>';
  if (categories().includes(selectedCategory)) categorySelect.value = selectedCategory;

  const catFilter = el('listCategoryFilter'), payerFilter = el('listPayerFilter');
  const oldCat = catFilter.value, oldPayer = payerFilter.value;
  catFilter.innerHTML = '<option value="">Alle Kategorien</option>' + categories().map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');
  payerFilter.innerHTML = '<option value="">Alle Personen</option>' + filterPayers().map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');
  if ([...catFilter.options].some(o=>o.value===oldCat)) catFilter.value=oldCat;
  if ([...payerFilter.options].some(o=>o.value===oldPayer)) payerFilter.value=oldPayer;
  renderChips();
}
function renderChips() {
  const custom=loadList('customCategories');
  el('categoryChips').innerHTML = custom.length
    ? custom.map(x=>`<span class="chip">${escapeHtml(x)} <button data-remove-cat="${encodeURIComponent(x)}" aria-label="Entfernen">×</button></span>`).join('')
    : '<span class="muted">Keine zusätzlichen Kategorien.</span>';
}

function getRecurringFrequency(x) {
  if (!x) return null;
  if (x.generatedFromRecurring) return x.generatedFrequency || x.recurringFrequency || 'monthly';
  if (x.recurringFrequency === 'monthly' || x.recurringFrequency === 'yearly') return x.recurringFrequency;
  if (x.recurring === true) return 'monthly';
  return null;
}
function recurringBadge(x) {
  const f=getRecurringFrequency(x);
  if(f==='yearly') return '<span class="pill recurring-pill">↻ jährlich</span>';
  if(f==='monthly') return '<span class="pill recurring-pill">↻ monatlich</span>';
  return '';
}

function setView(name) {
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===name));
  if (name==='list') renderList();
  if (name==='stay') renderStayCalendar();
  if (name==='report') { renderMonthOverview(); renderReport(); }
}

function resetForm() {
  el('expenseForm').reset();
  el('recurringMonthly').disabled=false;
  el('recurringYearly').disabled=false;
  el('date').value=todayISO();
  el('expenseId').value='';
  el('newCategoryEntry').classList.add('hidden');
  currentReceiptBlob=null;
  removeExistingReceipt=false;
  el('receiptPreviewWrap').classList.add('hidden');
  el('receiptPreview').src='';
  el('formTitle').textContent='Neue Ausgabe';
  el('saveBtn').textContent='Ausgabe speichern';
  el('cancelEditBtn').classList.add('hidden');
}
async function saveInlineCategory() {
  const v=el('newCategoryInline').value.trim();
  if(!v) return toast('Bitte einen Namen für die Kategorie eingeben.');
  const a=loadList('customCategories');
  if(!DEFAULT_CATEGORIES.includes(v) && !a.includes(v)) a.push(v);
  saveList('customCategories',a);
  el('newCategoryInline').value='';
  refreshSelectors();
  el('category').value=v;
  el('newCategoryEntry').classList.add('hidden');
  toast('Kategorie gespeichert.');
}
async function handleSubmit(e) {
  e.preventDefault();
  const amount=parseAmount(el('amount').value);
  if (!(amount>0)) return toast('Bitte einen gültigen Betrag eingeben.');
  const id=el('expenseId').value || uid();
  const existing=el('expenseId').value ? await dbGet(id) : null;
  const category=el('category').value.trim(), paidBy=el('paidBy').value.trim();
  if (!category || category==='__new__' || !paidBy) return toast('Kategorie und „Bezahlt von“ auswählen.');
  if (!FIXED_PAYERS.includes(paidBy)) return toast('Bitte Sebastian oder Sandra auswählen.');

  let receipt = existing?.receipt || null;
  if (removeExistingReceipt) receipt=null;
  if (currentReceiptBlob) receipt=currentReceiptBlob;

  const generated=!!existing?.generatedFromRecurring;
  const frequency = generated ? null : (el('recurringMonthly').checked ? 'monthly' : (el('recurringYearly').checked ? 'yearly' : null));
  const item={
    id,
    date:el('date').value,
    amount,
    category,
    paidBy,
    description:el('description').value.trim(),
    receipt,
    recurring:!!frequency,
    recurringFrequency:frequency,
    recurringSeriesId: frequency ? (existing?.recurringSeriesId || uid()) : (existing?.recurringSeriesId || null),
    generatedFromRecurring:generated,
    generatedFrequency:existing?.generatedFrequency || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };
  await dbPut(item);
  const cs=loadList('customCategories');
  if (!DEFAULT_CATEGORIES.includes(category) && !cs.includes(category)) { cs.push(category); saveList('customCategories',cs); }
  await reload();
  resetForm();
  toast(existing?'Ausgabe aktualisiert.':'Ausgabe gespeichert.');
  setView('list');
}
async function editExpense(id) {
  const x=await dbGet(id); if (!x) return;
  setView('entry');
  el('expenseId').value=x.id;
  el('amount').value=x.amount.toFixed(2).replace('.',',');
  el('date').value=x.date;
  refreshSelectors();
  el('category').value=x.category;
  el('paidBy').value=FIXED_PAYERS.includes(x.paidBy)?x.paidBy:'';
  el('description').value=x.description||'';
  const f=getRecurringFrequency(x);
  el('recurringMonthly').checked=!x.generatedFromRecurring && f==='monthly';
  el('recurringYearly').checked=!x.generatedFromRecurring && f==='yearly';
  el('recurringMonthly').disabled=!!x.generatedFromRecurring;
  el('recurringYearly').disabled=!!x.generatedFromRecurring;
  currentReceiptBlob=null; removeExistingReceipt=false;
  if (x.receipt) { el('receiptPreview').src=URL.createObjectURL(x.receipt); el('receiptPreviewWrap').classList.remove('hidden'); }
  else el('receiptPreviewWrap').classList.add('hidden');
  el('formTitle').textContent=x.generatedFromRecurring?'Wiederkehrenden Eintrag bearbeiten':'Ausgabe bearbeiten';
  el('saveBtn').textContent='Änderungen speichern';
  el('cancelEditBtn').classList.remove('hidden');
  window.scrollTo({top:0,behavior:'smooth'});
}
async function removeExpense(id) {
  const x=await dbGet(id); if (!x) return;
  let msg=`${money(x.amount)} vom ${fmtDate(x.date)} wirklich löschen?`;
  const f=getRecurringFrequency(x);
  if (f && !x.generatedFromRecurring) msg+=`\n\nDie bereits automatisch erzeugten ${f==='yearly'?'Jahres':'Monats'}-Einträge bleiben bestehen. Zukünftige Einträge werden nicht mehr erzeugt.`;
  if (confirm(msg)) { await dbDelete(id); await reload(); toast('Eintrag gelöscht.'); }
}

function filteredList() {
  const q=el('searchText').value.trim().toLowerCase(), c=el('listCategoryFilter').value, p=el('listPayerFilter').value;
  return currentExpenses
    .filter(x=>(!c||x.category===c)&&(!p||x.paidBy===p)&&(!q||[x.category,x.paidBy,x.description].join(' ').toLowerCase().includes(q)))
    .sort((a,b)=>b.date.localeCompare(a.date)||(b.createdAt||'').localeCompare(a.createdAt||''));
}
function renderList() {
  const list=filteredList(), total=list.reduce((s,x)=>s+x.amount,0);
  el('listSummary').textContent=`${list.length} ${list.length===1?'Eintrag':'Einträge'} · ${money(total)}`;
  if (!list.length) { el('expenseList').innerHTML='<div class="empty">Noch keine passenden Ausgaben.</div>'; return; }
  el('expenseList').innerHTML=list.map(x=>{
    const thumb=x.receipt?`<img class="thumb" data-receipt-id="${x.id}" alt="Beleg">`:'';
    return `<article class="expense-item"><div class="expense-main"><div class="expense-title">${escapeHtml(x.category)} <span class="pill">${escapeHtml(x.paidBy)}</span>${recurringBadge(x)}</div><div class="expense-meta">${fmtDate(x.date)}</div>${x.description?`<div class="expense-desc">${escapeHtml(x.description)}</div>`:''}${thumb}</div><div><div class="expense-amount">${money(x.amount)}</div><div class="expense-actions"><button class="ghost" data-edit="${x.id}">Bearbeiten</button><button class="danger" data-delete="${x.id}">Löschen</button></div></div></article>`;
  }).join('');
  list.filter(x=>x.receipt).forEach(x=>{
    const img=document.querySelector(`[data-receipt-id="${CSS.escape(x.id)}"]`);
    if(img) img.src=URL.createObjectURL(x.receipt);
  });
}

function stayForDate(date) { return currentStays.find(x=>x.date===date) || null; }
function monthStayStats(month) {
  if(!month) return {seb:0,san:0,assigned:0,unassigned:0,totalDays:0,both:0};
  const [y,m]=month.split('-').map(Number), totalDays=daysInMonth(y,m-1);
  const rows=currentStays.filter(x=>x.date?.slice(0,7)===month);
  const sebOnly=rows.filter(x=>x.parent==='Sebastian').length;
  const sanOnly=rows.filter(x=>x.parent==='Sandra').length;
  const both=rows.filter(x=>x.parent==='Beide').length;
  const seb=sebOnly+(both*0.5);
  const san=sanOnly+(both*0.5);
  const assigned=rows.filter(x=>['Sebastian','Sandra','Beide'].includes(x.parent)).length;
  return {seb,san,assigned,unassigned:Math.max(0,totalDays-assigned),totalDays,both};
}
function renderStayCalendar() {
  const month=el('stayMonthPicker').value || currentMonthISO();
  if(!el('stayMonthPicker').value) el('stayMonthPicker').value=month;
  const [y,m]=month.split('-').map(Number);
  const total=daysInMonth(y,m-1);
  const firstOffset=(new Date(y,m-1,1).getDay()+6)%7;
  const parts=[];
  for(let i=0;i<firstOffset;i++) parts.push('<button class="calendar-day empty-day" type="button" tabindex="-1"></button>');
  for(let d=1;d<=total;d++){
    const date=`${month}-${String(d).padStart(2,'0')}`;
    const stay=stayForDate(date);
    const cls=stay?.parent==='Sebastian'?' assigned-seb':(stay?.parent==='Sandra'?' assigned-san':(stay?.parent==='Beide'?' assigned-both':''));
    const today=date===todayISO()?' today':'';
    const displayParent=stay?.parent==='Beide'?'½ Sebastian · ½ Sandra':stay?.parent;
    const label=displayParent?`<span class="day-parent">${escapeHtml(displayParent)}</span>`:'';
    parts.push(`<button class="calendar-day${cls}${today}" type="button" data-stay-date="${date}" aria-label="${fmtDate(date)}${displayParent?' '+escapeHtml(displayParent):''}"><span class="day-number">${d}</span>${label}</button>`);
  }
  while(parts.length%7!==0) parts.push('<button class="calendar-day empty-day" type="button" tabindex="-1"></button>');
  el('stayCalendar').innerHTML=parts.join('');
  const s=monthStayStats(month);
  el('staySebastianDays').textContent=fmtDays(s.seb);
  el('staySandraDays').textContent=fmtDays(s.san);
  el('stayUnassignedDays').textContent=fmtDays(s.unassigned);
}
async function markStay(date) {
  if(stayMode==='clear') await stayDelete(date);
  else await stayPut({date,parent:stayMode,updatedAt:new Date().toISOString()});
  currentStays=await stayAll();
  renderStayCalendar();
  renderMonthOverview();
}
function setStayRangeToMonth(month) {
  if(!month) return;
  const [y,m]=month.split('-').map(Number);
  el('stayRangeFrom').value=`${month}-01`;
  el('stayRangeTo').value=`${month}-${String(daysInMonth(y,m-1)).padStart(2,'0')}`;
}
function isoDatesBetween(from,to) {
  const dates=[];
  if(!from || !to || from>to) return dates;
  let d=new Date(from+'T12:00:00');
  const end=new Date(to+'T12:00:00');
  let guard=0;
  while(d<=end && guard++<3700){
    const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
    dates.push(`${y}-${m}-${day}`);
    d.setDate(d.getDate()+1);
  }
  return dates;
}
async function markStayRange() {
  const from=el('stayRangeFrom').value, to=el('stayRangeTo').value;
  if(!from || !to){ alert('Bitte Start- und Enddatum für den Zeitraum auswählen.'); return; }
  if(from>to){ alert('Das Enddatum darf nicht vor dem Startdatum liegen.'); return; }
  const dates=isoDatesBetween(from,to);
  if(!dates.length) return;
  for(const date of dates){
    if(stayMode==='clear') await stayDelete(date);
    else await stayPut({date,parent:stayMode,updatedAt:new Date().toISOString()});
  }
  currentStays=await stayAll();
  if(from.slice(0,7)===to.slice(0,7)) el('stayMonthPicker').value=from.slice(0,7);
  renderStayCalendar();
  renderMonthOverview();
  const action=stayMode==='clear'?'gelöscht':(stayMode==='Beide'?'mit je ½ Tag für Sebastian und Sandra markiert':`als ${stayMode} markiert`);
  toast(`${dates.length} ${dates.length===1?'Tag':'Tage'} ${action}.`);
}
function shiftStayMonth(delta) {
  const base=el('stayMonthPicker').value || currentMonthISO();
  const [y,m]=base.split('-').map(Number);
  const d=new Date(y,m-1+delta,1);
  el('stayMonthPicker').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  setStayRangeToMonth(el('stayMonthPicker').value);
  renderStayCalendar();
}

function reportItems() {
  const from=el('reportFrom').value, to=el('reportTo').value;
  return currentExpenses.filter(x=>(!from||x.date>=from)&&(!to||x.date<=to)).sort((a,b)=>a.date.localeCompare(b.date));
}
function groupSum(items,key) {
  const m={};
  items.forEach(x=>m[x[key]||'Ohne Angabe']=(m[x[key]||'Ohne Angabe']||0)+x.amount);
  return Object.entries(m).sort((a,b)=>b[1]-a[1]);
}
function renderBreakdown(id, rows) {
  el(id).innerHTML=rows.length ? rows.map(([n,v])=>`<div class="breakdown-row"><span>${escapeHtml(n)}</span><strong>${money(v)}</strong></div>`).join('') : '<div class="muted">Keine Daten</div>';
}
function renderReport() {
  const items=reportItems(), total=items.reduce((s,x)=>s+x.amount,0);
  el('reportTotal').textContent=money(total);
  el('reportCount').textContent=`${items.length} ${items.length===1?'Eintrag':'Einträge'}`;
  renderBreakdown('categoryBreakdown',groupSum(items,'category'));
  renderBreakdown('payerBreakdown',groupSum(items,'paidBy'));
}
function monthItems(monthValue) {
  if(!monthValue) return [];
  return currentExpenses.filter(x=>x.date && x.date.slice(0,7)===monthValue).sort((a,b)=>b.date.localeCompare(a.date));
}
function renderMonthOverview() {
  const month=el('monthPicker').value || currentMonthISO();
  const items=monthItems(month);
  const total=items.reduce((s,x)=>s+x.amount,0);
  const seb=items.filter(x=>x.paidBy==='Sebastian').reduce((s,x)=>s+x.amount,0);
  const san=items.filter(x=>x.paidBy==='Sandra').reduce((s,x)=>s+x.amount,0);
  el('monthTotal').textContent=money(total);
  el('monthSebastian').textContent=money(seb);
  el('monthSandra').textContent=money(san);
  el('monthCount').textContent=String(items.length);
  renderBreakdown('monthCategoryBreakdown',groupSum(items,'category'));
  el('monthExpenseList').innerHTML = items.length
    ? items.map(x=>`<div class="month-expense-row"><div><strong>${escapeHtml(x.category)}</strong><small>${fmtDate(x.date)} · ${escapeHtml(x.paidBy)}${getRecurringFrequency(x)?' · ↻':''}</small></div><strong>${money(x.amount)}</strong></div>`).join('')
    : '<div class="muted">Keine Ausgaben in diesem Monat.</div>';

  const s=monthStayStats(month);
  el('reportStaySebastian').textContent=fmtDays(s.seb);
  el('reportStaySandra').textContent=fmtDays(s.san);
  el('reportStayUnassigned').textContent=fmtDays(s.unassigned);
  const sebPct=s.assigned?Math.round(s.seb/s.assigned*100):0, sanPct=s.assigned?100-sebPct:0;
  el('reportStaySebastianPct').textContent=`${sebPct} % der zugeordneten Tage`;
  el('reportStaySandraPct').textContent=`${sanPct} % der zugeordneten Tage`;
  el('stayRatioSeb').style.width=`${sebPct}%`;
  el('stayRatioSan').style.width=`${sanPct}%`;
}

function csvFor(items) {
  const q=s=>`"${String(s??'').replace(/"/g,'""')}"`;
  return '\uFEFF'+['Datum;Betrag EUR;Kategorie;Bezahlt von;Beschreibung;Wiederkehrend',...items.map(x=>{
    const f=getRecurringFrequency(x);
    const recurring=f==='yearly'?'Jährlich':(f==='monthly'?'Monatlich':'Nein');
    return [x.date,x.amount.toFixed(2).replace('.',','),x.category,x.paidBy,x.description,recurring].map(q).join(';');
  })].join('\r\n');
}
function win1252Bytes(str) {
  const map={'€':128,'‚':130,'ƒ':131,'„':132,'…':133,'†':134,'‡':135,'ˆ':136,'‰':137,'Š':138,'‹':139,'Œ':140,'Ž':142,'‘':145,'’':146,'“':147,'”':148,'•':149,'–':150,'—':151,'˜':152,'™':153,'š':154,'›':155,'œ':156,'ž':158,'Ÿ':159};
  const out=[]; for (const ch of str) { const cp=ch.codePointAt(0); out.push(map[ch] ?? (cp<=255?cp:63)); } return new Uint8Array(out);
}
function pdfEscape(s) { return String(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }
function truncate(s,n=72) { s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1)+'…':s; }
function stayRangeStats(from,to) {
  const rows=currentStays.filter(x=>(!from||x.date>=from)&&(!to||x.date<=to));
  const both=rows.filter(x=>x.parent==='Beide').length;
  return {
    seb:rows.filter(x=>x.parent==='Sebastian').length+(both*0.5),
    san:rows.filter(x=>x.parent==='Sandra').length+(both*0.5),
    both
  };
}
function simplePdf(lines) {
  const perPage=46, pages=[];
  for(let i=0;i<lines.length;i+=perPage) pages.push(lines.slice(i,i+perPage));
  if(!pages.length) pages.push(['Aufteilung Ausgaben Stella','Keine Daten.']);
  const objects=[]; objects[1]='<< /Type /Catalog /Pages 2 0 R >>';
  const pageIds=[], contentIds=[]; let next=4;
  pages.forEach(()=>{pageIds.push(next++); contentIds.push(next++);}); const fontId=3;
  objects[2]=`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] >>`;
  objects[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((page,idx)=>{
    const content=['BT','/F1 11 Tf','48 790 Td'];
    page.forEach((line,j)=>{
      if(j===0) content.push('/F1 16 Tf'); else if(j===1) content.push('/F1 11 Tf');
      content.push(`(${pdfEscape(line)}) Tj`); content.push(j===0?'0 -26 Td':'0 -16 Td');
    });
    content.push('ET'); const stream=content.join('\n');
    objects[pageIds[idx]]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[idx]} 0 R >>`;
    const len=win1252Bytes(stream).length;
    objects[contentIds[idx]]=`<< /Length ${len} >>\nstream\n${stream}\nendstream`;
  });
  let out='%PDF-1.4\n%âãÏÓ\n', offsets=[0];
  for(let i=1;i<objects.length;i++){
    if(!objects[i]) continue;
    offsets[i]=win1252Bytes(out).length;
    out+=`${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref=win1252Bytes(out).length;
  out+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for(let i=1;i<objects.length;i++) out+=`${String(offsets[i]||0).padStart(10,'0')} 00000 n \n`;
  out+=`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([win1252Bytes(out)],{type:'application/pdf'});
}
function buildPdf(items,from,to) {
  const lines=[];
  lines.push('Aufteilung Ausgaben Stella');
  lines.push(`Zeitraum: ${from?fmtDate(from):'Beginn'} bis ${to?fmtDate(to):'Heute'}`);
  lines.push(`Gesamt: ${money(items.reduce((s,x)=>s+x.amount,0))} | Einträge: ${items.length}`);
  const stay=stayRangeStats(from,to);
  if(stay.seb||stay.san) lines.push(`Aufenthalt: Sebastian ${fmtDays(stay.seb)} | Sandra ${fmtDays(stay.san)}`);
  lines.push('');
  items.forEach(x=>{
    const f=getRecurringFrequency(x), tag=f==='yearly'?' [jährlich]':(f==='monthly'?' [monatlich]':'');
    lines.push(`${fmtDate(x.date)}   ${money(x.amount)}   ${truncate(x.category,24)}   Bezahlt: ${truncate(x.paidBy,22)}${tag}`);
    if(x.description) lines.push(`  ${truncate(x.description,85)}`);
  });
  lines.push(''); lines.push('Nach Kategorie:');
  groupSum(items,'category').forEach(([n,v])=>lines.push(`  ${truncate(n,45)}: ${money(v)}`));
  lines.push(''); lines.push('Bezahlt von:');
  groupSum(items,'paidBy').forEach(([n,v])=>lines.push(`  ${truncate(n,45)}: ${money(v)}`));
  return simplePdf(lines);
}
function monthLabel(month) {
  if(!month) return '';
  const [y,m]=month.split('-').map(Number);
  return new Intl.DateTimeFormat('de-DE',{month:'long',year:'numeric'}).format(new Date(y,m-1,1));
}
function buildMonthPdf(month) {
  const items=monthItems(month);
  const total=items.reduce((s,x)=>s+x.amount,0);
  const sebTotal=items.filter(x=>x.paidBy==='Sebastian').reduce((s,x)=>s+x.amount,0);
  const sanTotal=items.filter(x=>x.paidBy==='Sandra').reduce((s,x)=>s+x.amount,0);
  const stay=monthStayStats(month);
  const sebPct=stay.assigned?Math.round(stay.seb/stay.assigned*100):0;
  const sanPct=stay.assigned?100-sebPct:0;
  const lines=[];
  lines.push(`Monatsbericht Stella - ${monthLabel(month)}`);
  lines.push(`Erstellt am ${fmtDate(todayISO())}`);
  lines.push('');
  lines.push('AUSGABEN');
  lines.push(`Gesamt: ${money(total)} | Einträge: ${items.length}`);
  lines.push(`Sebastian: ${money(sebTotal)} | Sandra: ${money(sanTotal)}`);
  const diff=Math.abs(sebTotal-sanTotal);
  if(diff>0) lines.push(`${sebTotal>sanTotal?'Sebastian':'Sandra'} hat ${money(diff)} mehr bezahlt.`);
  lines.push('');
  lines.push('Nach Kategorie:');
  const catRows=groupSum(items,'category');
  if(catRows.length) catRows.forEach(([n,v])=>lines.push(`  ${truncate(n,45)}: ${money(v)}`)); else lines.push('  Keine Ausgaben.');
  lines.push('');
  lines.push('AUFENTHALT');
  lines.push(`Sebastian: ${fmtDays(stay.seb)} (${sebPct} % der zugeordneten Tage)`);
  lines.push(`Sandra: ${fmtDays(stay.san)} (${sanPct} % der zugeordneten Tage)`);
  if(stay.both) lines.push(`Davon gemeinsam aufgeteilt: ${fmtDays(stay.both)} (jeweils ½ Tag)`);
  lines.push(`Nicht zugeordnet: ${fmtDays(stay.unassigned)} | Monat gesamt: ${fmtDays(stay.totalDays)}`);
  lines.push('');
  lines.push('AUSGABEN IM MONAT');
  if(items.length){
    items.slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(x=>{
      const f=getRecurringFrequency(x), tag=f==='yearly'?' [jährlich]':(f==='monthly'?' [monatlich]':'');
      lines.push(`${fmtDate(x.date)}   ${money(x.amount)}   ${truncate(x.category,25)}   ${truncate(x.paidBy,18)}${tag}`);
      if(x.description) lines.push(`  ${truncate(x.description,85)}`);
    });
  } else lines.push('Keine Ausgaben in diesem Monat.');
  return simplePdf(lines);
}
async function shareFile(file,title,text) {
  try { if (navigator.share && (!navigator.canShare || navigator.canShare({files:[file]}))) { await navigator.share({files:[file],title,text}); return; } }
  catch (e) { if (e.name==='AbortError') return; }
  const a=document.createElement('a'); a.href=URL.createObjectURL(file); a.download=file.name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000); toast('Datei wurde heruntergeladen.');
}
async function blobToDataURL(blob) { return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(blob); }); }
function dataURLToBlob(dataURL) {
  const [meta,data]=dataURL.split(',');
  const mime=(meta.match(/data:([^;]+)/)||[])[1]||'application/octet-stream';
  const bin=atob(data), arr=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return new Blob([arr],{type:mime});
}

function getAppearance() {
  return {
    theme:localStorage.getItem('appearanceTheme')||'indigo',
    mode:localStorage.getItem('appearanceMode')||'system',
    text:localStorage.getItem('appearanceText')||'normal'
  };
}
function applyAppearance() {
  const a=getAppearance();
  document.documentElement.dataset.theme=a.theme;
  document.documentElement.dataset.mode=a.mode;
  document.documentElement.dataset.text=a.text;
  el('appearanceMode').value=a.mode;
  el('textSize').value=a.text;
  document.querySelectorAll('.color-preset').forEach(b=>b.classList.toggle('selected',b.dataset.theme===a.theme));
  const colors={indigo:'#4f46e5',rose:'#be5674',teal:'#0f766e',blue:'#2563eb',graphite:'#374151'};
  document.querySelector('meta[name="theme-color"]').setAttribute('content',colors[a.theme]||colors.indigo);
}
function saveAppearancePart(key,value) { localStorage.setItem(key,value); applyAppearance(); }

async function createBackup() {
  const items=[];
  for(const x of currentExpenses) items.push({...x,receipt:x.receipt?await blobToDataURL(x.receipt):null});
  const payload={
    format:'KostenEinfachBackup',version:4,createdAt:new Date().toISOString(),
    customCategories:loadList('customCategories'),expenses:items,stays:currentStays,appearance:getAppearance()
  };
  const file=new File([JSON.stringify(payload,null,2)],`Stella_Backup_${todayISO()}.json`,{type:'application/json'});
  await shareFile(file,'Stella Backup','Vollständiges Backup der Ausgaben- und Aufenthalts-App');
}
async function restoreBackup(file) {
  const payload=JSON.parse(await file.text());
  if(payload.format!=='KostenEinfachBackup'||!Array.isArray(payload.expenses)) throw new Error('Ungültiges Backup');
  const stayCount=Array.isArray(payload.stays)?payload.stays.length:0;
  if(!confirm(`Backup mit ${payload.expenses.length} Ausgaben${stayCount?` und ${stayCount} Aufenthaltstagen`:''} wiederherstellen? Vorhandene Daten werden ersetzt.`)) return;
  await dbClear(); await stayClear();
  for(const raw of payload.expenses) await dbPut({...raw,receipt:raw.receipt?dataURLToBlob(raw.receipt):null});
  for(const s of (payload.stays||[])) if(s.date && [...FIXED_PAYERS,'Beide'].includes(s.parent)) await stayPut(s);
  saveList('customCategories',payload.customCategories||[]);
  if(payload.appearance){
    if(payload.appearance.theme) localStorage.setItem('appearanceTheme',payload.appearance.theme);
    if(payload.appearance.mode) localStorage.setItem('appearanceMode',payload.appearance.mode);
    if(payload.appearance.text) localStorage.setItem('appearanceText',payload.appearance.text);
    applyAppearance();
  }
  await reload(); toast('Backup wiederhergestellt.');
}

async function ensureRecurringOccurrences(items) {
  const today=todayISO();
  const roots=items.filter(x=>!x.generatedFromRecurring && x.date && getRecurringFrequency(x));
  if(!roots.length) return false;
  const existingKeys=new Set(items.filter(x=>x.recurringSeriesId).map(x=>`${x.recurringSeriesId}|${x.date}`));
  let added=false;
  for(const root of roots){
    const frequency=getRecurringFrequency(root);
    const seriesId=root.recurringSeriesId || root.id;
    let rootChanged=false;
    if(!root.recurringSeriesId){ root.recurringSeriesId=seriesId; rootChanged=true; }
    if(!root.recurringFrequency){ root.recurringFrequency=frequency; root.recurring=true; rootChanged=true; }
    if(rootChanged) await dbPut(root);
    const [sy,sm,sd]=root.date.split('-').map(Number);
    if(frequency==='monthly'){
      let y=sy, m=sm, guard=0;
      while(guard++<600){
        m+=1; if(m===13){m=1;y+=1;}
        const due=isoForMonthDay(y,m-1,sd);
        if(due>today) break;
        const key=`${seriesId}|${due}`;
        if(!existingKeys.has(key)){
          await dbPut({id:uid(),date:due,amount:root.amount,category:root.category,paidBy:root.paidBy,description:root.description||'',receipt:null,recurring:false,recurringFrequency:null,recurringSeriesId:seriesId,generatedFromRecurring:true,generatedFrequency:'monthly',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
          existingKeys.add(key); added=true;
        }
      }
    } else if(frequency==='yearly'){
      let y=sy+1, guard=0;
      while(guard++<100){
        const due=isoForMonthDay(y,sm-1,sd);
        if(due>today) break;
        const key=`${seriesId}|${due}`;
        if(!existingKeys.has(key)){
          await dbPut({id:uid(),date:due,amount:root.amount,category:root.category,paidBy:root.paidBy,description:root.description||'',receipt:null,recurring:false,recurringFrequency:null,recurringSeriesId:seriesId,generatedFromRecurring:true,generatedFrequency:'yearly',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
          existingKeys.add(key); added=true;
        }
        y+=1;
      }
    }
  }
  return added;
}

async function reload() {
  currentExpenses=await dbAll();
  const added=await ensureRecurringOccurrences(currentExpenses);
  if(added) currentExpenses=await dbAll();
  currentStays=await stayAll();
  refreshSelectors(); renderList(); renderStayCalendar(); renderMonthOverview(); renderReport();
}
function initDates() {
  el('date').value=todayISO();
  el('monthPicker').value=currentMonthISO();
  el('stayMonthPicker').value=currentMonthISO();
  setStayRangeToMonth(currentMonthISO());
  const now=new Date();
  const first=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  el('reportFrom').value=first;
  el('reportTo').value=todayISO();
}

function wire() {
  document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
  el('expenseForm').addEventListener('submit',handleSubmit);
  el('cancelEditBtn').addEventListener('click',()=>{ el('recurringMonthly').disabled=false; el('recurringYearly').disabled=false; resetForm(); });

  el('category').addEventListener('change',()=>{
    el('newCategoryEntry').classList.toggle('hidden',el('category').value!=='__new__');
    if(el('category').value==='__new__') setTimeout(()=>el('newCategoryInline').focus(),50);
  });
  el('saveCategoryInlineBtn').addEventListener('click',saveInlineCategory);
  el('newCategoryInline').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); saveInlineCategory(); } });

  el('recurringMonthly').addEventListener('change',()=>{ if(el('recurringMonthly').checked) el('recurringYearly').checked=false; });
  el('recurringYearly').addEventListener('change',()=>{ if(el('recurringYearly').checked) el('recurringMonthly').checked=false; });

  el('receipt').addEventListener('change',()=>{
    const f=el('receipt').files[0]; if(!f)return;
    currentReceiptBlob=f; removeExistingReceipt=false;
    el('receiptPreview').src=URL.createObjectURL(f); el('receiptPreviewWrap').classList.remove('hidden');
  });
  el('removeReceiptBtn').addEventListener('click',()=>{
    currentReceiptBlob=null; removeExistingReceipt=true; el('receipt').value=''; el('receiptPreviewWrap').classList.add('hidden');
  });

  ['searchText','listCategoryFilter','listPayerFilter'].forEach(id=>el(id).addEventListener(id==='searchText'?'input':'change',renderList));
  ['reportFrom','reportTo'].forEach(id=>el(id).addEventListener('change',renderReport));
  el('monthPicker').addEventListener('change',renderMonthOverview);
  el('currentMonthBtn').addEventListener('click',()=>{ el('monthPicker').value=currentMonthISO(); renderMonthOverview(); });
  el('thisMonthBtn').addEventListener('click',()=>{
    const month=el('monthPicker').value||currentMonthISO();
    const [y,m]=month.split('-').map(Number);
    el('reportFrom').value=`${month}-01`;
    el('reportTo').value=`${month}-${String(daysInMonth(y,m-1)).padStart(2,'0')}`;
    renderReport();
  });

  el('stayMonthPicker').addEventListener('change',()=>{ setStayRangeToMonth(el('stayMonthPicker').value); renderStayCalendar(); });
  el('stayPrevMonth').addEventListener('click',()=>shiftStayMonth(-1));
  el('stayNextMonth').addEventListener('click',()=>shiftStayMonth(1));
  el('stayTodayBtn').addEventListener('click',()=>{ el('stayMonthPicker').value=currentMonthISO(); setStayRangeToMonth(currentMonthISO()); renderStayCalendar(); });
  el('markStayRangeBtn').addEventListener('click',markStayRange);
  el('stayModeSelector').addEventListener('click',e=>{
    const b=e.target.closest('[data-stay-mode]'); if(!b)return;
    stayMode=b.dataset.stayMode;
    document.querySelectorAll('[data-stay-mode]').forEach(x=>x.classList.toggle('active',x.dataset.stayMode===stayMode));
  });
  el('stayCalendar').addEventListener('click',e=>{
    const b=e.target.closest('[data-stay-date]'); if(b) markStay(b.dataset.stayDate);
  });

  el('exportMonthPdfBtn').addEventListener('click',async()=>{
    const month=el('monthPicker').value || currentMonthISO();
    const blob=buildMonthPdf(month);
    const file=new File([blob],`Monatsbericht_Stella_${month}.pdf`,{type:'application/pdf'});
    await shareFile(file,`Monatsbericht Stella ${monthLabel(month)}`,'Gemeinsamer Monatsbericht mit Ausgaben und Aufenthalt');
  });

  el('expenseList').addEventListener('click',e=>{
    const edit=e.target.dataset.edit, del=e.target.dataset.delete;
    if(edit) editExpense(edit); if(del) removeExpense(del);
  });
  el('exportCsvBtn').addEventListener('click',async()=>{
    const items=reportItems();
    const file=new File([csvFor(items)],`Kostenauswertung_${el('reportFrom').value||'Start'}_${el('reportTo').value||'Heute'}.csv`,{type:'text/csv;charset=utf-8'});
    await shareFile(file,'Kostenauswertung','CSV-Auswertung');
  });
  el('exportPdfBtn').addEventListener('click',async()=>{
    const items=reportItems(); const blob=buildPdf(items,el('reportFrom').value,el('reportTo').value);
    const file=new File([blob],`Kostenauswertung_${el('reportFrom').value||'Start'}_${el('reportTo').value||'Heute'}.pdf`,{type:'application/pdf'});
    await shareFile(file,'Kostenauswertung','PDF-Auswertung');
  });

  el('backupBtn').addEventListener('click',createBackup);
  el('restoreInput').addEventListener('change',async()=>{
    const f=el('restoreInput').files[0]; if(!f)return;
    try{await restoreBackup(f);}catch{alert('Das Backup konnte nicht gelesen werden.');}
    el('restoreInput').value='';
  });
  el('addCategoryBtn').addEventListener('click',()=>{
    const v=el('newCategory').value.trim(); if(!v)return;
    const a=loadList('customCategories'); if(!DEFAULT_CATEGORIES.includes(v) && !a.includes(v)) a.push(v);
    saveList('customCategories',a); el('newCategory').value=''; refreshSelectors(); toast('Kategorie gespeichert.');
  });
  el('newCategory').addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();el('addCategoryBtn').click();} });
  el('categoryChips').addEventListener('click',e=>{
    const v=e.target.dataset.removeCat; if(!v)return;
    saveList('customCategories',loadList('customCategories').filter(x=>x!==decodeURIComponent(v))); refreshSelectors();
  });
  el('deleteAllBtn').addEventListener('click',async()=>{
    if(confirm('Wirklich ALLE Ausgaben, Belege, Aufenthaltsdaten und eigenen Kategorien dauerhaft löschen?')){
      await dbClear(); await stayClear(); localStorage.removeItem('customCategories'); await reload(); toast('Alle Daten gelöscht.');
    }
  });

  el('appearanceBtn').addEventListener('click',()=>el('appearancePanel').classList.remove('hidden'));
  el('appearanceCloseBtn').addEventListener('click',()=>el('appearancePanel').classList.add('hidden'));
  el('appearanceDoneBtn').addEventListener('click',()=>el('appearancePanel').classList.add('hidden'));
  el('appearancePanel').addEventListener('click',e=>{ if(e.target===el('appearancePanel')) el('appearancePanel').classList.add('hidden'); });
  el('colorPresets').addEventListener('click',e=>{
    const b=e.target.closest('[data-theme]'); if(!b)return;
    saveAppearancePart('appearanceTheme',b.dataset.theme);
  });
  el('appearanceMode').addEventListener('change',()=>saveAppearancePart('appearanceMode',el('appearanceMode').value));
  el('textSize').addEventListener('change',()=>saveAppearancePart('appearanceText',el('textSize').value));

  window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferredPrompt=e; el('installBtn').classList.remove('hidden'); });
  el('installBtn').addEventListener('click',async()=>{
    if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; el('installBtn').classList.add('hidden'); }
    else alert('Auf dem iPhone: Safari → Teilen → „Zum Home-Bildschirm“.');
  });
}

(async()=>{
  initDates(); wire(); applyAppearance(); await openDB(); await reload();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
})();
