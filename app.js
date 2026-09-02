'use strict';

const DEFAULT_CATEGORIES = ['Lebensmittel','Tanken','Restaurant','Haushalt','Büro','Fahrtkosten','Hotel','Material','Sonstiges'];
const DB_NAME = 'kostenEinfachDB';
const STORE = 'expenses';
let db;
let currentReceiptBlob = null;
let removeExistingReceipt = false;
let deferredPrompt = null;
let currentExpenses = [];

const money = v => new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(v || 0);
const fmtDate = iso => iso ? new Intl.DateTimeFormat('de-DE').format(new Date(iso+'T12:00:00')) : '';
const todayISO = () => new Date().toISOString().slice(0,10);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const el = id => document.getElementById(id);

function toast(msg) {
  const t = el('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(()=>t.classList.remove('show'),2200);
}

function parseAmount(value) {
  const cleaned = String(value).trim().replace(/\s/g,'').replace(/\./g,'').replace(',','.').replace(/[^0-9.-]/g,'');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n*100)/100 : NaN;
}

function openDB() {
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE,{keyPath:'id'});
    };
    req.onsuccess = ()=>{ db=req.result; resolve(db); };
    req.onerror = ()=>reject(req.error);
  });
}

function tx(mode='readonly') { return db.transaction(STORE,mode).objectStore(STORE); }
function dbAll() { return new Promise((res,rej)=>{ const r=tx().getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }
function dbGet(id) { return new Promise((res,rej)=>{ const r=tx().get(id); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
function dbPut(item) { return new Promise((res,rej)=>{ const r=tx('readwrite').put(item); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function dbDelete(id) { return new Promise((res,rej)=>{ const r=tx('readwrite').delete(id); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function dbClear() { return new Promise((res,rej)=>{ const r=tx('readwrite').clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }

function loadList(key, fallback=[]) {
  try { const x=JSON.parse(localStorage.getItem(key)); return Array.isArray(x) ? x : fallback; } catch { return fallback; }
}
function saveList(key, arr) { localStorage.setItem(key,JSON.stringify([...new Set(arr.map(x=>x.trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'de')))); }
function categories() { return [...new Set([...DEFAULT_CATEGORIES,...loadList('customCategories'),...currentExpenses.map(x=>x.category).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'de')); }
function payers() { return [...new Set([...loadList('payers'),...currentExpenses.map(x=>x.paidBy).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'de')); }

function refreshDataLists() {
  el('categoryList').innerHTML = categories().map(x=>`<option value="${escapeHtml(x)}"></option>`).join('');
  el('payerList').innerHTML = payers().map(x=>`<option value="${escapeHtml(x)}"></option>`).join('');
  const catFilter = el('listCategoryFilter'), payerFilter=el('listPayerFilter');
  const oldCat=catFilter.value, oldPayer=payerFilter.value;
  catFilter.innerHTML='<option value="">Alle Kategorien</option>'+categories().map(x=>`<option>${escapeHtml(x)}</option>`).join('');
  payerFilter.innerHTML='<option value="">Alle Personen</option>'+payers().map(x=>`<option>${escapeHtml(x)}</option>`).join('');
  catFilter.value=oldCat; payerFilter.value=oldPayer;
  renderChips();
}

function renderChips() {
  const custom=loadList('customCategories');
  el('categoryChips').innerHTML = custom.length ? custom.map(x=>`<span class="chip">${escapeHtml(x)} <button data-remove-cat="${encodeURIComponent(x)}" aria-label="Entfernen">×</button></span>`).join('') : '<span class="muted">Keine zusätzlichen Kategorien.</span>';
  const ps=loadList('payers');
  el('payerChips').innerHTML = ps.length ? ps.map(x=>`<span class="chip">${escapeHtml(x)} <button data-remove-payer="${encodeURIComponent(x)}" aria-label="Entfernen">×</button></span>`).join('') : '<span class="muted">Noch keine Namen gespeichert.</span>';
}

function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function setView(name) {
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===name));
  if (name==='list') renderList();
  if (name==='report') renderReport();
}

function resetForm() {
  el('expenseForm').reset(); el('date').value=todayISO(); el('expenseId').value='';
  currentReceiptBlob=null; removeExistingReceipt=false;
  el('receiptPreviewWrap').classList.add('hidden'); el('receiptPreview').src='';
  el('formTitle').textContent='Neue Ausgabe'; el('saveBtn').textContent='Ausgabe speichern'; el('cancelEditBtn').classList.add('hidden');
}

async function handleSubmit(e) {
  e.preventDefault();
  const amount=parseAmount(el('amount').value); if (!(amount>0)) return toast('Bitte einen gültigen Betrag eingeben.');
  const id=el('expenseId').value || uid();
  const existing=el('expenseId').value ? await dbGet(id) : null;
  const category=el('category').value.trim(), paidBy=el('paidBy').value.trim();
  if (!category || !paidBy) return toast('Kategorie und „Bezahlt von“ ausfüllen.');
  let receipt = existing?.receipt || null;
  if (removeExistingReceipt) receipt=null;
  if (currentReceiptBlob) receipt=currentReceiptBlob;
  const item={
    id,
    date:el('date').value,
    amount,
    category,
    paidBy,
    description:el('description').value.trim(),
    receipt,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };
  await dbPut(item);
  const ps=loadList('payers'); if (!ps.includes(paidBy)) { ps.push(paidBy); saveList('payers',ps); }
  const cs=loadList('customCategories'); if (!DEFAULT_CATEGORIES.includes(category) && !cs.includes(category)) { cs.push(category); saveList('customCategories',cs); }
  await reload(); resetForm(); toast(existing?'Ausgabe aktualisiert.':'Ausgabe gespeichert.'); setView('list');
}

async function editExpense(id) {
  const x=await dbGet(id); if (!x) return;
  setView('entry');
  el('expenseId').value=x.id; el('amount').value=x.amount.toFixed(2).replace('.',','); el('date').value=x.date; el('category').value=x.category; el('paidBy').value=x.paidBy; el('description').value=x.description||'';
  currentReceiptBlob=null; removeExistingReceipt=false;
  if (x.receipt) { el('receiptPreview').src=URL.createObjectURL(x.receipt); el('receiptPreviewWrap').classList.remove('hidden'); } else el('receiptPreviewWrap').classList.add('hidden');
  el('formTitle').textContent='Ausgabe bearbeiten'; el('saveBtn').textContent='Änderungen speichern'; el('cancelEditBtn').classList.remove('hidden');
  window.scrollTo({top:0,behavior:'smooth'});
}

async function removeExpense(id) {
  const x=await dbGet(id); if (!x) return;
  if (confirm(`${money(x.amount)} vom ${fmtDate(x.date)} wirklich löschen?`)) { await dbDelete(id); await reload(); toast('Eintrag gelöscht.'); }
}

function filteredList() {
  const q=el('searchText').value.trim().toLowerCase(), c=el('listCategoryFilter').value, p=el('listPayerFilter').value;
  return currentExpenses.filter(x=>(!c||x.category===c)&&(!p||x.paidBy===p)&&(!q||[x.category,x.paidBy,x.description].join(' ').toLowerCase().includes(q))).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt));
}

function renderList() {
  const list=filteredList(), total=list.reduce((s,x)=>s+x.amount,0);
  el('listSummary').textContent=`${list.length} ${list.length===1?'Eintrag':'Einträge'} · ${money(total)}`;
  if (!list.length) { el('expenseList').innerHTML='<div class="empty">Noch keine passenden Ausgaben.</div>'; return; }
  el('expenseList').innerHTML=list.map(x=>{
    const thumb=x.receipt?`<img class="thumb" data-receipt-id="${x.id}" alt="Beleg">`:'';
    return `<article class="expense-item"><div class="expense-main"><div class="expense-title">${escapeHtml(x.category)} <span class="pill">${escapeHtml(x.paidBy)}</span></div><div class="expense-meta">${fmtDate(x.date)}</div>${x.description?`<div class="expense-desc">${escapeHtml(x.description)}</div>`:''}${thumb}</div><div><div class="expense-amount">${money(x.amount)}</div><div class="expense-actions"><button class="ghost" data-edit="${x.id}">Bearbeiten</button><button class="danger" data-delete="${x.id}">Löschen</button></div></div></article>`;
  }).join('');
  list.filter(x=>x.receipt).forEach(x=>{ const img=document.querySelector(`[data-receipt-id="${CSS.escape(x.id)}"]`); if(img) img.src=URL.createObjectURL(x.receipt); });
}

function reportItems() {
  const from=el('reportFrom').value, to=el('reportTo').value;
  return currentExpenses.filter(x=>(!from||x.date>=from)&&(!to||x.date<=to)).sort((a,b)=>a.date.localeCompare(b.date));
}
function groupSum(items,key) { const m={}; items.forEach(x=>m[x[key]||'Ohne Angabe']=(m[x[key]||'Ohne Angabe']||0)+x.amount); return Object.entries(m).sort((a,b)=>b[1]-a[1]); }
function renderBreakdown(id, rows) { el(id).innerHTML=rows.length?rows.map(([n,v])=>`<div class="breakdown-row"><span>${escapeHtml(n)}</span><strong>${money(v)}</strong></div>`).join(''):'<div class="muted">Keine Daten</div>'; }
function renderReport() {
  const items=reportItems(), total=items.reduce((s,x)=>s+x.amount,0);
  el('reportTotal').textContent=money(total); el('reportCount').textContent=`${items.length} ${items.length===1?'Eintrag':'Einträge'}`;
  renderBreakdown('categoryBreakdown',groupSum(items,'category')); renderBreakdown('payerBreakdown',groupSum(items,'paidBy'));
}

function csvFor(items) {
  const q=s=>`"${String(s??'').replace(/"/g,'""')}"`;
  return '\uFEFF'+['Datum;Betrag EUR;Kategorie;Bezahlt von;Beschreibung',...items.map(x=>[x.date,x.amount.toFixed(2).replace('.',','),x.category,x.paidBy,x.description].map(q).join(';'))].join('\r\n');
}

function win1252Bytes(str) {
  const map={'€':128,'‚':130,'ƒ':131,'„':132,'…':133,'†':134,'‡':135,'ˆ':136,'‰':137,'Š':138,'‹':139,'Œ':140,'Ž':142,'‘':145,'’':146,'“':147,'”':148,'•':149,'–':150,'—':151,'˜':152,'™':153,'š':154,'›':155,'œ':156,'ž':158,'Ÿ':159};
  const out=[]; for (const ch of str) { const cp=ch.codePointAt(0); out.push(map[ch] ?? (cp<=255?cp:63)); } return new Uint8Array(out);
}
function pdfEscape(s) { return String(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }
function truncate(s,n=72) { s=String(s||'').replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1)+'…':s; }
function buildPdf(items,from,to) {
  const lines=[]; lines.push('Kostenauswertung'); lines.push(`Zeitraum: ${from?fmtDate(from):'Beginn'} bis ${to?fmtDate(to):'Heute'}`); lines.push(`Gesamt: ${money(items.reduce((s,x)=>s+x.amount,0))} | Einträge: ${items.length}`); lines.push('');
  items.forEach(x=>{ lines.push(`${fmtDate(x.date)}   ${money(x.amount)}   ${truncate(x.category,24)}   Bezahlt: ${truncate(x.paidBy,22)}`); if(x.description) lines.push(`  ${truncate(x.description,85)}`); });
  lines.push(''); lines.push('Nach Kategorie:'); groupSum(items,'category').forEach(([n,v])=>lines.push(`  ${truncate(n,45)}: ${money(v)}`)); lines.push(''); lines.push('Bezahlt von:'); groupSum(items,'paidBy').forEach(([n,v])=>lines.push(`  ${truncate(n,45)}: ${money(v)}`));
  const perPage=46, pages=[]; for(let i=0;i<lines.length;i+=perPage) pages.push(lines.slice(i,i+perPage)); if(!pages.length) pages.push(['Kostenauswertung','Keine Einträge.']);
  const objects=[]; objects[1]='<< /Type /Catalog /Pages 2 0 R >>';
  const pageIds=[], contentIds=[]; let next=4;
  pages.forEach(()=>{pageIds.push(next++); contentIds.push(next++);}); const fontId=3;
  objects[2]=`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] >>`; objects[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((page,idx)=>{
    const content=['BT','/F1 11 Tf','48 790 Td']; page.forEach((line,j)=>{ if(j===0) content.push('/F1 16 Tf'); else if(j===1) content.push('/F1 11 Tf'); content.push(`(${pdfEscape(line)}) Tj`); content.push(j===0?'0 -26 Td':'0 -16 Td'); }); content.push('ET'); const stream=content.join('\n');
    objects[pageIds[idx]]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[idx]} 0 R >>`;
    const len=win1252Bytes(stream).length; objects[contentIds[idx]]=`<< /Length ${len} >>\nstream\n${stream}\nendstream`;
  });
  let out='%PDF-1.4\n%âãÏÓ\n', offsets=[0]; for(let i=1;i<objects.length;i++){ if(!objects[i]) continue; offsets[i]=win1252Bytes(out).length; out+=`${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref=win1252Bytes(out).length; out+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`; for(let i=1;i<objects.length;i++){ out+=`${String(offsets[i]||0).padStart(10,'0')} 00000 n \n`; } out+=`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([win1252Bytes(out)],{type:'application/pdf'});
}

async function shareFile(file,title,text) {
  try {
    if (navigator.share && (!navigator.canShare || navigator.canShare({files:[file]}))) { await navigator.share({files:[file],title,text}); return; }
  } catch (e) { if (e.name==='AbortError') return; }
  const a=document.createElement('a'); a.href=URL.createObjectURL(file); a.download=file.name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),4000); toast('Datei wurde heruntergeladen.');
}

async function blobToDataURL(blob) { return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(blob); }); }
function dataURLToBlob(dataURL) { const [meta,data]=dataURL.split(','); const mime=(meta.match(/data:([^;]+)/)||[])[1]||'application/octet-stream'; const bin=atob(data), arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i); return new Blob([arr],{type:mime}); }

async function createBackup() {
  const items=[]; for(const x of currentExpenses){ items.push({...x,receipt:x.receipt?await blobToDataURL(x.receipt):null}); }
  const payload={format:'KostenEinfachBackup',version:1,createdAt:new Date().toISOString(),customCategories:loadList('customCategories'),payers:loadList('payers'),expenses:items};
  const file=new File([JSON.stringify(payload,null,2)],`Kosten_Backup_${todayISO()}.json`,{type:'application/json'}); await shareFile(file,'Kosten Backup','Vollständiges Backup der Kosten-App');
}

async function restoreBackup(file) {
  const payload=JSON.parse(await file.text()); if(payload.format!=='KostenEinfachBackup'||!Array.isArray(payload.expenses)) throw new Error('Ungültiges Backup');
  if(!confirm(`Backup mit ${payload.expenses.length} Einträgen wiederherstellen? Vorhandene Daten werden ersetzt.`)) return;
  await dbClear();
  for(const raw of payload.expenses){ const x={...raw,receipt:raw.receipt?dataURLToBlob(raw.receipt):null}; await dbPut(x); }
  saveList('customCategories',payload.customCategories||[]); saveList('payers',payload.payers||[]); await reload(); toast('Backup wiederhergestellt.');
}

async function reload() { currentExpenses=await dbAll(); refreshDataLists(); renderList(); renderReport(); }

function initDates() {
  el('date').value=todayISO(); const now=new Date(); const first=new Date(now.getFullYear(),now.getMonth(),1); el('reportFrom').value=first.toISOString().slice(0,10); el('reportTo').value=todayISO();
}

function wire() {
  document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
  el('expenseForm').addEventListener('submit',handleSubmit); el('cancelEditBtn').addEventListener('click',resetForm);
  el('receipt').addEventListener('change',()=>{ const f=el('receipt').files[0]; if(!f)return; currentReceiptBlob=f; removeExistingReceipt=false; el('receiptPreview').src=URL.createObjectURL(f); el('receiptPreviewWrap').classList.remove('hidden'); });
  el('removeReceiptBtn').addEventListener('click',()=>{currentReceiptBlob=null; removeExistingReceipt=true; el('receipt').value=''; el('receiptPreviewWrap').classList.add('hidden');});
  ['searchText','listCategoryFilter','listPayerFilter'].forEach(id=>el(id).addEventListener(id==='searchText'?'input':'change',renderList));
  ['reportFrom','reportTo'].forEach(id=>el(id).addEventListener('change',renderReport));
  el('thisMonthBtn').addEventListener('click',()=>{ const n=new Date(),f=new Date(n.getFullYear(),n.getMonth(),1); el('reportFrom').value=f.toISOString().slice(0,10); el('reportTo').value=todayISO(); renderReport(); });
  el('expenseList').addEventListener('click',e=>{ const edit=e.target.dataset.edit, del=e.target.dataset.delete; if(edit) editExpense(edit); if(del) removeExpense(del); });
  el('exportCsvBtn').addEventListener('click',async()=>{ const items=reportItems(); const file=new File([csvFor(items)],`Kostenauswertung_${el('reportFrom').value||'Start'}_${el('reportTo').value||'Heute'}.csv`,{type:'text/csv;charset=utf-8'}); await shareFile(file,'Kostenauswertung','CSV-Auswertung'); });
  el('exportPdfBtn').addEventListener('click',async()=>{ const items=reportItems(); const blob=buildPdf(items,el('reportFrom').value,el('reportTo').value); const file=new File([blob],`Kostenauswertung_${el('reportFrom').value||'Start'}_${el('reportTo').value||'Heute'}.pdf`,{type:'application/pdf'}); await shareFile(file,'Kostenauswertung','PDF-Auswertung'); });
  el('backupBtn').addEventListener('click',createBackup);
  el('restoreInput').addEventListener('change',async()=>{ const f=el('restoreInput').files[0]; if(!f)return; try{await restoreBackup(f);}catch{alert('Das Backup konnte nicht gelesen werden.');} el('restoreInput').value=''; });
  el('addCategoryBtn').addEventListener('click',()=>{ const v=el('newCategory').value.trim(); if(!v)return; const a=loadList('customCategories'); a.push(v); saveList('customCategories',a); el('newCategory').value=''; refreshDataLists(); });
  el('addPayerBtn').addEventListener('click',()=>{ const v=el('newPayer').value.trim(); if(!v)return; const a=loadList('payers'); a.push(v); saveList('payers',a); el('newPayer').value=''; refreshDataLists(); });
  el('categoryChips').addEventListener('click',e=>{ const v=e.target.dataset.removeCat; if(!v)return; saveList('customCategories',loadList('customCategories').filter(x=>x!==decodeURIComponent(v))); refreshDataLists(); });
  el('payerChips').addEventListener('click',e=>{ const v=e.target.dataset.removePayer; if(!v)return; saveList('payers',loadList('payers').filter(x=>x!==decodeURIComponent(v))); refreshDataLists(); });
  el('deleteAllBtn').addEventListener('click',async()=>{ if(confirm('Wirklich ALLE Ausgaben und Belege dauerhaft löschen?')){ await dbClear(); localStorage.removeItem('customCategories'); localStorage.removeItem('payers'); await reload(); toast('Alle Daten gelöscht.'); } });
  window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferredPrompt=e; el('installBtn').classList.remove('hidden'); });
  el('installBtn').addEventListener('click',async()=>{ if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; el('installBtn').classList.add('hidden'); } else alert('Auf dem iPhone: Safari → Teilen → „Zum Home-Bildschirm“.'); });
}

(async()=>{
  initDates(); wire(); await openDB(); await reload();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
})();
