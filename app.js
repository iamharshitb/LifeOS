// ── PWA Service Worker Registration ──────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('SW registered:', reg.scope))
      .catch(err => console.warn('SW failed:', err));
  });
}

// ── Push Notification helpers ─────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  const perm = await Notification.requestPermission();
  return perm === 'granted';
}

function scheduleWashDayReminder(washDay) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  localStorage.setItem('lifeos-wash-notify', washDay);
}

function checkAndNotify() {
  const washDay = localStorage.getItem('lifeos-wash-notify');
  if (!washDay || Notification.permission !== 'granted') return;
  const days = { Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6 };
  const today = new Date().getDay();
  if (days[washDay] === today) {
    new Notification('LifeOS Laundry Reminder 🧺', {
      body: "Today is your wash day! Queue overdue items.",
      icon: './icons/icon-192.svg',
      badge: './icons/icon-192.svg'
    });
  }
}
setTimeout(checkAndNotify, 3000);

// ══════════════════════════════════════════
// FIREBASE SYNC
// All data saved to Firestore so every device
// (phone, laptop, Syamala's phone) stays in sync.
// ══════════════════════════════════════════

// ── Your Firebase config (workdesk-ba979 project) ──
// IMPORTANT: Replace these values with your actual Firebase config
// Go to: Firebase Console → lifeos project → Project Settings → Your apps → Config
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCTUQanbXAxaQd5TyiDLTyL_WAV8ixeNQw",
  authDomain:        "lifeos-pwa.firebaseapp.com",
  projectId:         "lifeos-pwa",
  storageBucket:     "lifeos-pwa.firebasestorage.app",
  messagingSenderId: "70872415259",
  appId:             "1:70872415259:web:2db666bc97c8204a544cbe"
};

// ── Firebase state ──
let db = null;
let fbReady = false;

// ── Initialise Firebase ──
async function initFirebase() {
  try {
    // Dynamically import Firebase (works without npm/build step)
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    const { getFirestore, doc, setDoc, getDoc, onSnapshot, enableNetwork, disableNetwork }
      = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    // Don't init if config not filled in yet
    if (FIREBASE_CONFIG.apiKey === 'PASTE_YOUR_API_KEY_HERE') {
      console.log('Firebase not configured — using localStorage only');
      return;
    }

    const app = initializeApp(FIREBASE_CONFIG);
    db = getFirestore(app);
    fbReady = true;
    window._fbSetDoc = setDoc;
    window._fbDoc    = doc;
    window._fbGetDoc = getDoc;
    window._fbOnSnapshot = onSnapshot;

    console.log('Firebase ready');

    // Pull latest data from Firestore on load
    await loadFromFirebase();

    // Listen for real-time changes (e.g. Syamala adds groceries on her phone)
    listenFirebase();

  } catch(e) {
    console.warn('Firebase init failed, offline mode:', e);
  }
}

// ── Save user data (wardrobe, laundry) to Firestore ──
async function saveToFirebase() {
  if (!fbReady) return;
  try {
    // Save per-user wardrobe data
    await window._fbSetDoc(
      window._fbDoc(db, 'lifeos', 'user-' + currentUser),
      sanitizeForFirebase(U)
    );
    // Save shared data (groceries, meals, calendar, routines)
    await window._fbSetDoc(
      window._fbDoc(db, 'lifeos', 'shared'),
      sanitizeForFirebase(SH)
    );
  } catch(e) {
    console.warn('Firebase save failed:', e);
  }
}

// ── Load data from Firestore ──
async function loadFromFirebase() {
  if (!fbReady) return;
  try {
    // Load current user's wardrobe
    const uSnap = await window._fbGetDoc(window._fbDoc(db, 'lifeos', 'user-' + currentUser));
    if (uSnap.exists()) {
      const data = uSnap.data();
      // Merge with defaults — don't overwrite if Firestore has more recent data
      Object.assign(U, data);
      localStorage.setItem(uKey(), JSON.stringify(U));
    }
    // Load shared data
    const sSnap = await window._fbGetDoc(window._fbDoc(db, 'lifeos', 'shared'));
    if (sSnap.exists()) {
      Object.assign(SH, sSnap.data());
      localStorage.setItem(shKey(), JSON.stringify(SH));
    }
    renderAll();
    showSyncStatus('synced');
  } catch(e) {
    console.warn('Firebase load failed:', e);
  }
}

// ── Real-time listener: update UI when other device makes changes ──
let unsubUser = null, unsubShared = null;
function listenFirebase() {
  if (!fbReady) return;

  // Listen to current user's data
  if (unsubUser) unsubUser();
  unsubUser = window._fbOnSnapshot(
    window._fbDoc(db, 'lifeos', 'user-' + currentUser),
    (snap) => {
      if (!snap.exists()) return;
      const remote = snap.data();
      // Only update if remote is newer (has more items or different data)
      const localStr = JSON.stringify(U);
      const remoteStr = JSON.stringify(remote);
      if (localStr !== remoteStr) {
        Object.assign(U, remote);
        localStorage.setItem(uKey(), JSON.stringify(U));
        renderAll();
        showSyncStatus('synced');
      }
    }
  );

  // Listen to shared data (groceries, meals, calendar)
  if (unsubShared) unsubShared();
  unsubShared = window._fbOnSnapshot(
    window._fbDoc(db, 'lifeos', 'shared'),
    (snap) => {
      if (!snap.exists()) return;
      const remote = snap.data();
      const localStr = JSON.stringify(SH);
      const remoteStr = JSON.stringify(remote);
      if (localStr !== remoteStr) {
        Object.assign(SH, remote);
        localStorage.setItem(shKey(), JSON.stringify(SH));
        // Re-render whichever life section is active
        if (document.getElementById('ls-groceries').classList.contains('active')) renderGroceries();
        if (document.getElementById('ls-tasks').classList.contains('active')) renderTasks();
        if (document.getElementById('ls-meals').classList.contains('active')) buildMealGrid();
        if (document.getElementById('ls-calendar').classList.contains('active')) buildCalendar();
        showSyncStatus('synced');
      }
    }
  );
}

// ── Strip base64 photos before sending to Firestore (too large) ──
// Photos stay in localStorage only — they don't need to sync since
// each person adds clothes from their own phone
function sanitizeForFirebase(obj) {
  const str = JSON.stringify(obj, (key, val) => {
    if (key === 'photo' && typeof val === 'string' && val.startsWith('data:')) return '';
    return val;
  });
  return JSON.parse(str);
}

// ── Sync status indicator ──
function showSyncStatus(status) {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.style.background = status === 'synced' ? 'var(--success)' : status === 'saving' ? 'var(--warning)' : 'var(--error)';
}

// Start Firebase on load
initFirebase();


// ══════════════════════════════════════════
// LIFEOS v5 — FULL JS ENGINE
// ══════════════════════════════════════════

// ── STATE ──────────────────────────────────
let currentUser = 'H'; // H = Harshit, S = Syamala

function uKey(){ return 'lifeos-v5-'+currentUser; }
function shKey(){ return 'lifeos-v5-shared'; }

function defaultUserState(){
  return { shirts:[], pants:[], outfits:[], combos:[], laundry:[], washDay:null, streak:1, fc:'all' };
}
function defaultSharedState(){
  return { groceries:[], events:[], meals:{}, routines:defaultRoutines(), mealWeekOffset:0, calMonthOffset:0 };
}
function defaultRoutines(){
  return [
    {id:'r1',name:'Check today\'s outfit',time:'06:45',period:'morning',cat:'wardrobe'},
    {id:'r2',name:'Morning stretch',time:'06:30',period:'morning',cat:'routine'},
    {id:'r3',name:'Pack bag & check calendar',time:'07:15',period:'morning',cat:'work'},
    {id:'r4',name:'Leave for office',time:'08:00',period:'morning',cat:'work'},
    {id:'r5',name:'Mark worn clothes',time:'20:00',period:'evening',cat:'wardrobe'},
    {id:'r6',name:'Iron tomorrow\'s outfit',time:'21:00',period:'evening',cat:'wardrobe'},
    {id:'r7',name:'Wind down',time:'22:00',period:'evening',cat:'routine'},
  ];
}

let U = JSON.parse(localStorage.getItem(uKey())||'{}');
let SH = JSON.parse(localStorage.getItem(shKey())||'{}');
['shirts','pants','outfits','combos','laundry'].forEach(k=>{ if(!U[k]) U[k]=[]; });
if(!U.washDay) U.washDay=null;
if(!U.streak) U.streak=1;
if(!U.fc) U.fc='all';
['groceries','events'].forEach(k=>{ if(!SH[k]) SH[k]=[]; });
if(!SH.tasks) SH.tasks=[];
if(!SH.meals) SH.meals={};
if(!SH.routines||!SH.routines.length) SH.routines=defaultRoutines();
if(SH.mealWeekOffset===undefined) SH.mealWeekOffset=0;
if(SH.calMonthOffset===undefined) SH.calMonthOffset=0;

function save(){
  localStorage.setItem(uKey(), JSON.stringify(U));
  saveToFirebase();
}
function saveShared(){
  localStorage.setItem(shKey(), JSON.stringify(SH));
  saveToFirebase();
}

function reloadUser(){
  U = JSON.parse(localStorage.getItem(uKey())||'{}');
  ['shirts','pants','outfits','combos','laundry'].forEach(k=>{ if(!U[k]) U[k]=[]; });
  if(!U.washDay) U.washDay=null;
  if(!U.streak) U.streak=1;
  if(!U.fc) U.fc='all';
}

// ── USER SWITCHING ──────────────────────────
function switchUser(uid){
  save(); // save current before switching
  currentUser = uid;
  reloadUser();
  const isS = uid==='S';
  document.body.classList.toggle('syamala-mode', isS);
  document.getElementById('hdrAvatar').textContent = isS?'S':'H';
  document.getElementById('hdrName').textContent = isS?'Syamala':'Harshit';
  // Update user option UI
  document.getElementById('uo-H').classList.toggle('active-user', uid==='H');
  document.getElementById('uo-S').classList.toggle('active-user', uid==='S');
  document.getElementById('uoc-H').style.display = uid==='H'?'':'none';
  document.getElementById('uoc-S').style.display = uid==='S'?'':'none';
  // Update wardrobe tab labels
  updateWardrobeTabs();
  setFC(U.fc||'all', document.getElementById('fc'+(U.fc==='formal'?'Formal':U.fc==='casual'?'Casual':'All')));
  closeAllSheets();
  renderAll();
  listenFirebase();
  toast(`Switched to ${isS?'Syamala':'Harshit'}'s profile`);
}

function updateWardrobeTabs(){
  const isS = currentUser==='S';
  const outfitsSection = document.getElementById('outfitsSection');
  if(outfitsSection) outfitsSection.style.display = isS?'block':'none';
  const topsLbl=document.getElementById('closet-tops-lbl');
  const botsLbl=document.getElementById('closet-bottoms-lbl');
  if(topsLbl) topsLbl.textContent = isS?'Tops':'Shirts';
  if(botsLbl) botsLbl.textContent = isS?'Bottoms':'Pants';
}

// ── NAVIGATION ──────────────────────────────
let currentPage = 'today';
function showPage(name, el){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.bn-item').forEach(b=>b.classList.remove('on'));
  const pg = document.getElementById('page-'+name);
  pg.classList.add('active');
  pg.classList.remove('page-enter');
  void pg.offsetWidth;
  pg.classList.add('page-enter');
  if(el) el.classList.add('on');
  else document.querySelectorAll('.bn-item')[['today','life','wardrobe','more'].indexOf(name)].classList.add('on');
  currentPage = name;
  document.getElementById('scrollArea').scrollTop = 0;
  if(name==='wardrobe') renderCloset();
  if(name==='life') { renderGroceries(); buildMealGrid(); buildCalendar(); }
  if(name==='more') renderRoutines();
}

function showLife(tab, btn){
  document.querySelectorAll('.life-section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.lt-btn').forEach(b=>b.classList.remove('on'));
  document.getElementById('ls-'+tab).classList.add('active');
  btn.classList.add('on');
  if(tab==='groceries') renderGroceries();
  if(tab==='tasks')     renderTasks();
  if(tab==='meals') buildMealGrid();
  if(tab==='calendar') buildCalendar();
}

function showWardrobeTab(tab, btn){
  ['tops','matrix','laundry'].forEach(t=>{
    const el=document.getElementById('wt-'+t);
    if(el) el.style.display=t===tab?'block':'none';
  });
  document.querySelectorAll('#wardrobeTabs .w-tab').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  if(tab==='matrix'){buildMatrix();buildComboHist();buildHarmonyGuide();}
  if(tab==='laundry'){renderLaundry();}
  if(tab==='tops'){renderCloset();}
}

// ── SHEETS ──────────────────────────────────
function openSheet(id){
  document.getElementById('overlay').classList.add('open');
  document.getElementById(id).classList.add('open');
}
function closeAllSheets(){
  document.getElementById('overlay').classList.remove('open');
  document.querySelectorAll('.sheet').forEach(s=>s.classList.remove('open'));
}

// ── TOAST ────────────────────────────────────
let toastTimer;
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),2500);
}

// ── COLOUR ENGINE ────────────────────────────
function hexToHSL(hex){
  let r=parseInt(hex.slice(1,3),16)/255,g=parseInt(hex.slice(3,5),16)/255,b=parseInt(hex.slice(5,7),16)/255;
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h,s,l=(mx+mn)/2;
  if(mx===mn){h=s=0;}else{
    const d=mx-mn;s=l>0.5?d/(2-mx-mn):d/(mx+mn);
    switch(mx){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;default:h=((r-g)/d+4)/6;}
  }
  return{h:h*360,s:s*100,l:l*100};
}
function harmonyScore(hexA,hexB){
  if(!hexA||!hexB)return 50;
  const a=hexToHSL(hexA),b=hexToHSL(hexB);
  let score=60;
  const lContrast=Math.abs(a.l-b.l);
  if(lContrast>25&&lContrast<70)score+=12;else if(lContrast<=10)score-=18;
  const aIsNeutral=a.s<15,bIsNeutral=b.s<15;
  if(aIsNeutral&&bIsNeutral)score+=10;
  else if(aIsNeutral||bIsNeutral)score+=8;
  const hueDiff=Math.abs(a.h-b.h);
  const hueMin=Math.min(hueDiff,360-hueDiff);
  if(hueMin>150&&hueMin<210)score+=18;
  else if(hueMin<30)score+=8;
  else if(hueMin>25&&hueMin<50)score+=6;
  else if(hueMin>50&&hueMin<70)score-=8;
  const aWarm=a.h<60||a.h>300,bWarm=b.h<60||b.h>300;
  if(aWarm===bWarm)score+=8;
  if(a.s>55&&b.s>55)score-=15;
  if((a.s>40&&bIsNeutral)||(b.s>40&&aIsNeutral))score+=12;
  if(hueMin<20&&a.s>25&&b.s>25&&lContrast<15)score-=25;
  return Math.max(5,Math.min(100,Math.round(score)));
}
function scoreLabel(s){
  if(s>=80)return{label:'Excellent',cls:'hb-excellent',mini:'★★★★★',dot:'gh-ex'};
  if(s>=65)return{label:'Good',cls:'hb-good',mini:'★★★★',dot:'gh-gd'};
  if(s>=45)return{label:'Works',cls:'hb-ok',mini:'★★★',dot:'gh-ok'};
  return{label:'Avoid',cls:'hb-avoid',mini:'★★',dot:''};
}

// ── SVG ICONS ────────────────────────────────
function shirtSVG(hex,sz=40){
  const h=hexToHSL(hex),dark=`hsl(${h.h},${Math.max(0,h.s-10)}%,${Math.max(0,h.l-18)}%)`,hi=`hsl(${h.h},${h.s}%,${Math.min(100,h.l+14)}%)`;
  return `<svg viewBox="0 0 56 56" width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg"><path d="M10 18 L4 28 L13 30 L13 52 L43 52 L43 30 L52 28 L46 18 L36 24 C34 15 22 15 20 24 Z" fill="${hex}" stroke="rgba(0,0,0,0.06)" stroke-width="1.5"/><path d="M20 24 L28 30 L28 20 C26 14 21 14 20 18 Z" fill="${dark}" opacity="0.35"/><path d="M36 24 L28 30 L28 20 C30 14 35 14 36 18 Z" fill="${dark}" opacity="0.35"/><path d="M4 28 L13 30 L13 34 L5 32 Z" fill="${dark}" opacity="0.2"/><path d="M52 28 L43 30 L43 34 L51 32 Z" fill="${dark}" opacity="0.2"/><circle cx="28" cy="34" r="1.5" fill="${dark}" opacity="0.5"/><circle cx="28" cy="40" r="1.5" fill="${dark}" opacity="0.5"/><path d="M13 18 L10 18 L4 28 L6 28 Z" fill="${hi}" opacity="0.3"/></svg>`;
}
function pantSVG(hex,sz=40){
  const h=hexToHSL(hex),dark=`hsl(${h.h},${Math.max(0,h.s-8)}%,${Math.max(0,h.l-15)}%)`,hi=`hsl(${h.h},${h.s}%,${Math.min(100,h.l+12)}%)`;
  return `<svg viewBox="0 0 56 56" width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="8" width="40" height="8" rx="3" fill="${hex}" opacity="0.85"/><path d="M8 16 L8 50 Q8 53 14 53 L24 53 L28 30 L12 16 Z" fill="${hex}" stroke="rgba(0,0,0,0.06)" stroke-width="1"/><path d="M48 16 L48 50 Q48 53 42 53 L32 53 L28 30 L44 16 Z" fill="${hex}" stroke="rgba(0,0,0,0.06)" stroke-width="1"/><path d="M9 18 L9 46 L14 46 L14 18 Z" fill="${hi}" opacity="0.25"/><rect x="18" y="7" width="4" height="4" rx="1" fill="${hi}" opacity="0.5"/><rect x="34" y="7" width="4" height="4" rx="1" fill="${hi}" opacity="0.5"/><circle cx="28" cy="12" r="2" fill="${hi}" opacity="0.7" stroke="${dark}" stroke-width="0.7"/></svg>`;
}
function dressSVG(hex,sz=40){
  const h=hexToHSL(hex),dark=`hsl(${h.h},${Math.max(0,h.s-8)}%,${Math.max(0,h.l-15)}%)`;
  return `<svg viewBox="0 0 56 56" width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg"><path d="M20 6 L28 10 L36 6 L40 16 L34 18 L38 52 L18 52 L22 18 L16 16 Z" fill="${hex}" stroke="rgba(0,0,0,0.06)" stroke-width="1.5"/><path d="M22 18 L28 22 L34 18 L36 6 L28 10 L20 6 Z" fill="${dark}" opacity="0.25"/><path d="M22 18 L18 52 L24 52 L28 28 Z" fill="${dark}" opacity="0.15"/></svg>`;
}
function garmentIcon(type,hex,sz=40){
  if(type==='outfit'||type==='dress') return dressSVG(hex,sz);
  if(type==='pant'||type==='bottom') return pantSVG(hex,sz);
  return shirtSVG(hex,sz);
}

// ── FILTERED WARDROBE HELPERS ─────────────────
function fcFilter(item){ const f=U.fc; return f==='all'||item.occ==='both'||item.occ===f; }
function filteredTops(){ return U.shirts.filter(fcFilter); }
function filteredBottoms(){ return U.pants.filter(fcFilter); }

function recentCombos(n){
  if(n===0){
    const today=new Date().toISOString().slice(0,10);
    return U.combos.filter(c=>c.date===today);
  }
  const cutoff=new Date(Date.now()-n*864e5).toISOString().slice(0,10);
  return U.combos.filter(c=>c.date>=cutoff);
}
function bestHarmonyForGarment(item,type){
  const others=type==='shirt'?U.pants:U.shirts;
  if(!others.length)return null;
  return Math.max(...others.map(o=>harmonyScore(item.color,o.color)));
}

// ── GARMENT FORM ─────────────────────────────
let addingType='shirt'; // shirt/pant/outfit
let selectedOcc='formal';
let selectedColor='#4A7B9D';
let gcalSync=true;
let evtType='personal';
let liType='shirt';

const COLORS=['#FFFFFF','#F5F5DC','#87CEEB','#4A90D9','#2C3E6B','#1A2744',
              '#228B22','#6B8E6B','#8B7355','#D4A76A','#C0392B','#8B2020',
              '#E8705A','#9B72CF','#F4A460','#708090','#2F4F4F','#1C1C1C'];

function openAddGarment(type){
  addingType=type;
  const isS=currentUser==='S';
  const labels={shirt:'Shirt / Top',pant:'Pant / Bottom',outfit:'Dress / Outfit'};
  document.getElementById('garmentSheetTitle').textContent='Add '+labels[type];
  // Type seg
  const typeSeg=document.getElementById('garmentTypeSeg');
  const typeLabel=document.getElementById('garmentTypeLabel');
  if(type==='shirt'){
    typeSeg.innerHTML=`
      <button class="seg-btn on" id="gtype-shirt" onclick="setGType('shirt',this)">${isS?'Top':'Shirt'}</button>
      <button class="seg-btn" id="gtype-tshirt" onclick="setGType('T-Shirt',this)">T-Shirt</button>
      <button class="seg-btn" id="gtype-formal" onclick="setGType('Formal Shirt',this)">Formal</button>`;
    typeLabel.textContent=isS?'Top Type':'Shirt Type';
  } else if(type==='pant'){
    typeSeg.innerHTML=`
      <button class="seg-btn on" id="gtype-pant" onclick="setGType('pant',this)">${isS?'Bottom':'Trousers'}</button>
      <button class="seg-btn" id="gtype-chino" onclick="setGType('Chinos',this)">Chinos</button>
      <button class="seg-btn" id="gtype-jeans" onclick="setGType('Jeans',this)">Jeans</button>`;
    typeLabel.textContent=isS?'Bottom Type':'Pant Type';
  } else {
    typeSeg.innerHTML=`
      <button class="seg-btn on" id="gtype-dress" onclick="setGType('dress',this)">Dress</button>
      <button class="seg-btn" id="gtype-kurta" onclick="setGType('Kurta Set',this)">Kurta Set</button>
      <button class="seg-btn" id="gtype-coord" onclick="setGType('Co-ord',this)">Co-ord</button>`;
    typeLabel.textContent='Outfit Type';
  }
  // Reset fields
  document.getElementById('gi-name').value='';
  const prev=document.getElementById('garmentPhotoPreview');
  if(prev){prev.src='';prev.style.display='none';}
  const ph=document.getElementById('photoPlaceholder');
  if(ph)ph.style.display='flex';
  setOcc('formal', document.getElementById('occ-formal'));
  buildColorSwatches();
  openSheet('garmentSheet');
}

function setOcc(o,btn){
  selectedOcc=o;
  document.querySelectorAll('#garmentSheet [id^="occ-"]').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}
let currentGType='shirt';
function setGType(t,btn){
  currentGType=t;
  document.querySelectorAll('#garmentTypeSeg .seg-btn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}
function setEvtType(t,btn){
  evtType=t;
  document.querySelectorAll('#eventSheet [id^="evt-"]').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}
function setGcalSync(v,btn){
  gcalSync=v;
  document.getElementById('gcs-yes').classList.toggle('on',v);
  document.getElementById('gcs-no').classList.toggle('on',!v);
}
function setLiType(t,btn){
  liType=t;
  document.querySelectorAll('#laundrySheet [id^="lit-"]').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}

function buildColorSwatches(){
  const row=document.getElementById('colorSwatches');
  row.innerHTML=COLORS.map(c=>`<div class="color-swatch${c===selectedColor?' selected':''}" style="background:${c};" onclick="selectColor('${c}',this)"></div>`).join('');
  document.getElementById('gi-customColor').value=selectedColor;
  updateHarmonyPreview();
}
function selectColor(hex,el){
  selectedColor=hex;
  document.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('gi-customColor').value=hex;
  updateHarmonyPreview();
}
document.addEventListener('change',e=>{
  if(e.target.id==='gi-customColor'){
    selectedColor=e.target.value;
    buildColorSwatches();
  }
});
function updateHarmonyPreview(){
  const others = addingType==='shirt'?U.pants:U.shirts;
  if(!others.length){document.getElementById('harmonyPreview').style.display='none';return;}
  const best=others.reduce((a,b)=>harmonyScore(selectedColor,b.color)>harmonyScore(selectedColor,a.color)?b:a);
  const sc=harmonyScore(selectedColor,best.color);
  const{mini}=scoreLabel(sc);
  document.getElementById('harmonyPreview').style.display='flex';
  document.getElementById('cpSwatch').style.background=best.color;
  document.getElementById('cpText').textContent='Best pair: '+best.name;
  document.getElementById('cpHarmony').textContent=mini+' '+sc+'/100';
}

function saveGarment(){
  const name=document.getElementById('gi-name').value.trim();
  if(!name){toast('Please enter a name');return;}
  const id='g'+Date.now();
  const photoData = document.getElementById('garmentPhotoPreview').src || '';
  const hasPhoto = photoData && photoData.startsWith('data:');
  const item={id,name,color:selectedColor,occ:selectedOcc,type:currentGType,cn:name.slice(0,8),emoji:'👔',status:'clean',photo:hasPhoto?photoData:''};
  if(addingType==='shirt') U.shirts.push(item);
  else if(addingType==='pant') U.pants.push(item);
  else U.outfits.push(item);
  // Add to laundry tracking
  U.laundry.push({id:'l'+id,name,type:currentGType,status:'clean',icon:'👔'});
  save();
  closeAllSheets();
  renderCloset();
  renderToday();
  toast(name+' added to your closet ✦');
}

function handleGarmentPhoto(e){
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=ev=>{
    const preview=document.getElementById('garmentPhotoPreview');
    preview.src=ev.target.result;preview.style.display='block';
    document.getElementById('photoPlaceholder').style.display='none';
  };
  reader.readAsDataURL(file);
}
function saveApiKey(){
  const k=document.getElementById('apiKeyInp').value.trim();
  if(!k)return;
  localStorage.setItem('lifeos-apikey',k);
  toast('API key saved');
}

// ── RENDER TODAY ──────────────────────────────
let suggestionIdx=0;
function renderToday(){
  const tops=filteredTops().filter(s=>s.status==='clean');
  const bots=filteredBottoms().filter(p=>p.status==='clean');
  const used=new Set(recentCombos(14).map(c=>c.shirtId+'|'+c.pantId));
  const todaySet=new Set(recentCombos(0).map(c=>c.shirtId+'|'+c.pantId));

  // Available combos
  const avail=[];
  tops.forEach(s=>bots.forEach(p=>{if(!used.has(s.id+'|'+p.id))avail.push({s,p,sc:harmonyScore(s.color,p.color)});}));
  avail.sort((a,b)=>b.sc-a.sc);

  // Also standalone outfits
  const solos=U.outfits.filter(o=>o.status==='clean');

  // ── Hero card elements (new HTML structure) ──
  const heroImgWrap = document.getElementById('heroImgWrap');
  const heroItems   = document.getElementById('heroItems');
  const heroTagline = document.getElementById('heroTagline');
  const heroBadges  = document.getElementById('heroBadges');
  const btnWear     = document.getElementById('btnWearToday');
  const btnNext     = document.getElementById('btnNextOutfit');
  const heroBadgeOcc= document.getElementById('heroBadgeOcc');

  if(!avail.length && !solos.length){
    if(heroImgWrap) heroImgWrap.innerHTML=`<div style="display:flex;flex-direction:column;align-items:center;gap:10px;opacity:.3;"><span class="icon" style="font-size:48px;color:var(--on-surface-variant);">checkroom</span><span style="font-family:var(--ff);font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--outline);">Add clothes to begin</span></div>`;
    if(heroTagline)  heroTagline.style.display='none';
    if(heroBadges)   heroBadges.style.display='none';
    if(heroItems)    heroItems.innerHTML='';
    if(btnWear)      btnWear.style.display='none';
    if(btnNext)      btnNext.style.display='none';
  } else {
    const idx=suggestionIdx%(avail.length||1);
    if(avail.length){
      const{s,p,sc}=avail[idx];
      const isToday=todaySet.has(s.id+'|'+p.id);
      const sHasPhoto=s.photo&&s.photo.startsWith('data:');
      const pHasPhoto=p.photo&&p.photo.startsWith('data:');
      // Hero image
      if(heroImgWrap){
        if(sHasPhoto||pHasPhoto){
          heroImgWrap.innerHTML=`<div style="display:grid;grid-template-columns:1fr 1fr;width:100%;height:100%;">
            ${sHasPhoto?`<img src="${s.photo}" style="width:100%;height:100%;object-fit:cover;display:block;">`:
              `<div style="background:${s.color}22;display:flex;align-items:center;justify-content:center;">${shirtSVG(s.color,52)}</div>`}
            ${pHasPhoto?`<img src="${p.photo}" style="width:100%;height:100%;object-fit:cover;display:block;">`:
              `<div style="background:${p.color}22;display:flex;align-items:center;justify-content:center;">${pantSVG(p.color,52)}</div>`}
          </div>`;
        } else {
          heroImgWrap.innerHTML=`<div style="display:flex;gap:16px;align-items:center;justify-content:center;padding:24px;">${shirtSVG(s.color,56)}${pantSVG(p.color,56)}</div>`;
        }
      }
      if(heroBadges)    heroBadges.style.display='flex';
      if(heroBadgeOcc)  heroBadgeOcc.textContent=s.occ==='formal'?'Formal':'Casual';
      if(heroTagline){
        heroTagline.style.display='block';
        heroTagline.textContent=`"${isToday?'Currently wearing':'Suggested for today'}: ${s.name} with ${p.name}."`;
      }
      if(heroItems){
        heroItems.innerHTML=`
          <div class="outfit-item-row">
            <div class="oir-icon">${shirtSVG(s.color,24)}</div>
            <div class="oir-text"><div class="oir-name">${s.name}</div><div class="oir-sub">${s.type}</div></div>
          </div>
          <div class="outfit-item-row">
            <div class="oir-icon">${pantSVG(p.color,24)}</div>
            <div class="oir-text"><div class="oir-name">${p.name}</div><div class="oir-sub">${p.type}</div></div>
          </div>`;
      }
      if(btnWear){ btnWear.style.display='block'; btnWear.textContent=isToday?'✓ Currently Wearing':'Confirm Selection'; }
      if(btnNext)  btnNext.style.display='flex';
    }
  }

  // ── Bento stats ──
  const totalItems=U.shirts.length+U.pants.length+U.outfits.length;
  document.getElementById('b-items').textContent=totalItems;
  document.getElementById('b-combos').textContent=avail.length;
  document.getElementById('b-wash').textContent=U.laundry.filter(i=>i.status==='wash').length;
  document.getElementById('b-streak').textContent=U.streak||1;

  // Laundry summary counts
  document.getElementById('lq-c').textContent=U.laundry.filter(i=>i.status==='clean').length;
  document.getElementById('lq-w').textContent=U.laundry.filter(i=>i.status==='worn').length;
  document.getElementById('lq-wsh').textContent=U.laundry.filter(i=>i.status==='wash').length;

  // Wash day
  if(U.washDay){
    document.getElementById('wdTxt').textContent=`Wash day: ${U.washDay} · ${daysUntilWashDay()} days away`;
    ['s','u','w'].forEach(k=>{
      const btn=document.getElementById('wdb-'+k);
      const map={s:'Saturday',u:'Sunday',w:'Wednesday'};
      btn.classList.toggle('on',map[k]===U.washDay);
    });
  }

  renderWeek();
  renderLaundryIntel('laundryIntel',false);
}

function wearSuggested(){
  const tops=filteredTops().filter(s=>s.status==='clean');
  const bots=filteredBottoms().filter(p=>p.status==='clean');
  const used=new Set(recentCombos(14).map(c=>c.shirtId+'|'+c.pantId));
  const avail=[];
  tops.forEach(s=>bots.forEach(p=>{if(!used.has(s.id+'|'+p.id))avail.push({s,p,sc:harmonyScore(s.color,p.color)});}));
  avail.sort((a,b)=>b.sc-a.sc);
  if(!avail.length)return;
  const{s,p}=avail[suggestionIdx%(avail.length)];
  wearToday(s.id,p.id);
}
function nextSuggestion(){suggestionIdx++;renderToday();}
function wearToday(sid,pid){
  const today=new Date().toISOString().slice(0,10);
  const already=U.combos.find(c=>c.shirtId===sid&&c.pantId===pid&&c.date===today);
  if(!already) U.combos.push({shirtId:sid,pantId:pid,date:today});
  const s=U.shirts.find(x=>x.id===sid),p=U.pants.find(x=>x.id===pid);
  if(s)s.status='worn'; if(p)p.status='worn';
  const ls=U.laundry.find(x=>x.id==='l'+sid),lp=U.laundry.find(x=>x.id==='l'+pid);
  if(ls)ls.status='worn'; if(lp)lp.status='worn';
  save();renderToday();toast('Outfit logged ✦');
}
function renderWeek(){
  const row=document.getElementById('weekRow');
  if(!row)return;
  const today=new Date();
  const days=['M','T','W','T','F','S','S'];
  const todayStr=today.toISOString().slice(0,10);
  // Get Mon-Sun of current week
  const mon=new Date(today);
  mon.setDate(today.getDate()-(today.getDay()===0?6:today.getDay()-1));
  // Week range label
  const rangeEl=document.getElementById('weekRange');
  if(rangeEl){
    const sun=new Date(mon);sun.setDate(mon.getDate()+6);
    const fmt=d=>d.toLocaleDateString('en-IN',{month:'short',day:'numeric'});
    rangeEl.textContent=fmt(mon)+' - '+fmt(sun);
  }
  let html='';
  for(let i=0;i<7;i++){
    const d=new Date(mon);d.setDate(mon.getDate()+i);
    const ds=d.toISOString().slice(0,10);
    const hasCb=U.combos.some(c=>c.date===ds);
    const isToday=ds===todayStr;
    html+=`<div class="week-dot-col">
      <div class="week-dot${hasCb?' logged':''}${isToday?' today':''}"></div>
      <div class="week-day-lbl">${days[i]}</div>
    </div>`;
  }
  row.innerHTML=html;
  // Update ready ring
  updateReadyRing();
}

function updateReadyRing(){
  const cleanC=U.shirts.filter(s=>s.status==='clean').length;
  const cleanP=U.pants.filter(p=>p.status==='clean').length;
  const total=U.shirts.length+U.pants.length;
  const pct=total>0?Math.round(((cleanC+cleanP)/total)*100):0;
  const el=document.getElementById('readyRingFill');
  const pctEl=document.getElementById('readyPct');
  const subEl=document.getElementById('readySub');
  const wdEl=document.getElementById('readyWashDayTxt');
  if(el){
    const circ=2*Math.PI*29;
    el.setAttribute('stroke-dashoffset',(circ*(1-pct/100)).toFixed(1));
  }
  if(pctEl)pctEl.textContent=pct+'%';
  if(subEl){
    const daysLeft=Math.min(cleanC,cleanP);
    subEl.textContent=daysLeft>0?`Optimal for ${daysLeft} more day${daysLeft!==1?'s':''}.`:'Wardrobe needs attention.';
  }
  if(wdEl)wdEl.textContent=U.washDay?'Wash Day: '+U.washDay+' AM':'Set your wash day';
}
function setWD(day,btn){U.washDay=day;save();renderToday();}

// ── RENDER CLOSET ─────────────────────────────
function renderCloset(){
  updateWardrobeTabs();
  const isS=currentUser==='S';
  const totalItems=U.shirts.length+U.pants.length+U.outfits.length;
  document.getElementById('closetCount').textContent=
    isS?`${U.shirts.length} tops · ${U.pants.length} bottoms · ${U.outfits.length} outfits`
      :`${U.shirts.length} shirts · ${U.pants.length} pants`;
  buildGrid('shirt');buildGrid('pant');
  if(isS)buildGrid('outfit');
}

function setFC(fc,btn){
  U.fc=fc;save();
  document.querySelectorAll('.fc-btn').forEach(b=>b.classList.remove('on'));
  if(btn)btn.classList.add('on');
  buildGrid('shirt');buildGrid('pant');
  if(currentUser==='S')buildGrid('outfit');
}

function buildGrid(type){
  let items,gridId,addLabel;
  if(type==='shirt'){items=filteredTops();gridId='topGrid';addLabel='Shirt';}
  else if(type==='pant'){items=filteredBottoms();gridId='bottomGrid';addLabel='Pant';}
  else{items=U.outfits.filter(fcFilter);gridId='outfitGrid';addLabel='Outfit';}
  const isS=currentUser==='S';
  if(type==='shirt'&&isS)addLabel='Top';
  if(type==='pant'&&isS)addLabel='Bottom';

  const grid=document.getElementById(gridId);
  let html='';
  items.forEach(item=>{
    const bs=type!=='outfit'?bestHarmonyForGarment(item,type):null;
    const{dot}=bs?scoreLabel(bs):{dot:''};
    const occTag=item.occ==='formal'?'F':item.occ==='casual'?'C':'F/C';
    html+=`<div class="g-tile${item.status==='wash'?' is-wash':''}" id="gtile-${item.id}">
      <div class="g-sw" style="background:${item.color}14; position:relative;">
        <div class="g-ew" style="background:${item.color}22;">
          ${garmentIcon(type,item.color)}
        </div>
        ${item.status==='wash'?'<div class="wash-bdg">Washing</div>':''}
        ${bs&&dot?`<div class="g-harm ${dot}">${bs}</div>`:''}
        <div style="position:absolute;bottom:4px;right:5px;font-size:8px;font-weight:800;color:${item.occ==='formal'?'var(--sky)':'var(--green)'};background:${item.occ==='formal'?'var(--sky-s)':'var(--green-s)'};padding:1px 5px;border-radius:var(--r-pill);">${occTag}</div>
        <button class="g-del-btn" onclick="confirmDelete('${item.id}','${type}',event)" title="Remove">×</button>
      </div>
      <div class="g-foot"><div class="g-tname">${item.name}</div><div class="g-tsub">${item.type} · ${item.status}</div></div>
    </div>`;
  });
  html+=`<div class="add-tile" onclick="openAddGarment('${type}')"><span class="add-tile-icon">＋</span><span>Add ${addLabel}</span></div>`;
  grid.innerHTML=html;
}

function confirmDelete(id,type,e){
  e.stopPropagation();
  const items=type==='shirt'?U.shirts:type==='pant'?U.pants:U.outfits;
  const item=items.find(x=>x.id===id);if(!item)return;
  const tile=document.getElementById('gtile-'+id);if(!tile)return;
  tile.innerHTML=`<div style="padding:12px 8px;text-align:center;display:flex;flex-direction:column;gap:8px;height:100%;justify-content:center;">
    <div style="font-size:10px;font-weight:700;color:var(--accent);line-height:1.4;">Remove<br>${item.name}?</div>
    <button onclick="deleteGarment('${id}','${type}')" style="background:var(--accent);color:#fff;border:none;border-radius:var(--r-sm);padding:6px 8px;font-family:var(--f-u);font-size:10px;font-weight:800;cursor:pointer;">Delete</button>
    <button onclick="buildGrid('${type}')" style="background:rgba(196,184,164,.2);color:var(--tx3);border:none;border-radius:var(--r-sm);padding:5px 8px;font-family:var(--f-u);font-size:10px;font-weight:700;cursor:pointer;">Cancel</button>
  </div>`;
}
function deleteGarment(id,type){
  if(type==='shirt'){U.shirts=U.shirts.filter(x=>x.id!==id);U.combos=U.combos.filter(c=>c.shirtId!==id);}
  else if(type==='pant'){U.pants=U.pants.filter(x=>x.id!==id);U.combos=U.combos.filter(c=>c.pantId!==id);}
  else{U.outfits=U.outfits.filter(x=>x.id!==id);}
  U.laundry=U.laundry.filter(x=>x.id!=='l'+id);
  save();renderCloset();renderToday();toast('Item removed');
}
function clearAllWardrobe(){
  if(!confirm('Remove all items for this profile?'))return;
  U.shirts=[];U.pants=[];U.outfits=[];U.combos=[];U.laundry=[];
  save();renderCloset();renderToday();toast('Wardrobe reset');
}

// ── MATRIX ───────────────────────────────────
function buildMatrix(){
  const tops=filteredTops(),bots=filteredBottoms();
  const head=document.getElementById('mxHead'),body=document.getElementById('mxBody');
  if(!tops.length||!bots.length){head.innerHTML='';body.innerHTML='<tr><td colspan="5" style="padding:20px;text-align:center;font-size:12px;color:var(--tx3);">Add tops and bottoms first</td></tr>';return;}
  const used=new Set(recentCombos(14).map(c=>c.shirtId+'|'+c.pantId));
  const todaySet=new Set(recentCombos(0).map(c=>c.shirtId+'|'+c.pantId));
  head.innerHTML='<tr><th class="mx-hc"></th>'+bots.map(p=>`<th class="mx-hc">${p.name.slice(0,6)}</th>`).join('')+'</tr>';
  body.innerHTML=tops.map(s=>`<tr>
    <td class="mx-rl">${s.name.slice(0,8)}</td>
    ${bots.map(p=>{
      const k=s.id+'|'+p.id;
      const cls=todaySet.has(k)?'mx-today':used.has(k)?'mx-used':'mx-av';
      const sc=harmonyScore(s.color,p.color);
      const{mini}=scoreLabel(sc);
      const bc=sc>=80?'var(--green)':sc>=65?'var(--amber)':sc>=45?'var(--sky)':'var(--accent)';
      return `<td class="mx-cell ${cls}"><div class="mx-in" onclick="${cls==='mx-av'?`wearToday('${s.id}','${p.id}')`:''}" title="${cls==='mx-av'?`Harmony: ${sc}/100`:''}">
        <div class="mx-dots"><div class="mx-dot" style="background:${s.color}"></div><div class="mx-dot" style="background:${p.color}"></div></div>
        <div class="mx-sc">${cls==='mx-today'?'✓':cls==='mx-used'?'Used':mini}</div>
        <div class="mx-hbar"><div class="mx-hfill" style="width:${sc}%;background:${bc};"></div></div>
      </div></td>`;
    }).join('')}
  </tr>`).join('');
}
function buildComboHist(){
  const el=document.getElementById('comboHist');
  const r=U.combos.slice(-8).reverse();
  if(!r.length){el.innerHTML='<div style="padding:16px;text-align:center;font-size:12px;color:var(--tx3);">No combos logged yet</div>';return;}
  el.innerHTML=r.map(c=>{
    const s=U.shirts.find(x=>x.id===c.shirtId),p=U.pants.find(x=>x.id===c.pantId);
    if(!s||!p)return '';
    const sc=harmonyScore(s.color,p.color);const{mini,cls}=scoreLabel(sc);
    return `<div class="chi">
      <div class="chi-date">${c.date.slice(5)}</div>
      <div class="chi-em" style="display:flex;gap:3px;">${shirtSVG(s.color,18)}${pantSVG(p.color,18)}</div>
      <div class="chi-names"><div class="chi-n1">${s.name}</div><div class="chi-n2">+ ${p.name}</div></div>
      <span class="chi-harm" style="background:${sc>=80?'var(--green-s)':sc>=65?'var(--amber-s)':'var(--sky-s)'};color:${sc>=80?'var(--green)':sc>=65?'var(--amber)':'var(--sky)'};">${mini}</span>
    </div>`;
  }).join('');
}
function buildHarmonyGuide(){
  const el=document.getElementById('harmGuide');
  const tops=filteredTops(),bots=filteredBottoms();
  if(!tops.length||!bots.length){el.innerHTML='<div style="padding:12px 0;font-size:12px;color:var(--tx3);">Add tops and bottoms to see guide.</div>';return;}
  const pairs=[];
  tops.forEach(s=>bots.forEach(p=>{pairs.push({s,p,sc:harmonyScore(s.color,p.color)});}));
  pairs.sort((a,b)=>b.sc-a.sc);
  el.innerHTML=pairs.slice(0,6).map(({s,p,sc})=>{
    const{mini}=scoreLabel(sc);
    const cls=sc>=80?'hgs-ex':sc>=65?'hgs-gd':sc>=45?'hgs-ok':'hgs-av';
    return `<div class="hg-row"><div class="hg-dots"><div class="hg-dot" style="background:${s.color}"></div><div class="hg-dot" style="background:${p.color}"></div></div><div class="hg-name">${s.name} + ${p.name}</div><span class="hg-score ${cls}">${mini} ${sc}</span></div>`;
  }).join('');
}

// ── LAUNDRY INTELLIGENCE ──────────────────────
const WEAR_LIMIT={shirt:2,pant:3,'T-Shirt':1,'Formal Shirt':1,'Chinos':3,'Jeans':4,top:2,bottom:3,outfit:1,dress:1,'Kurta Set':1,'Co-ord':1,default:2};
function wearLimit(item){return WEAR_LIMIT[item.type||'']||WEAR_LIMIT.default;}
function computeWearCounts(){
  const counts={};U.laundry.forEach(i=>{counts[i.id]=0;});
  const sorted=[...U.combos].sort((a,b)=>b.date.localeCompare(a.date));
  sorted.forEach(c=>{
    const sid='l'+c.shirtId,pid='l'+c.pantId;
    const sI=U.laundry.find(x=>x.id===sid),pI=U.laundry.find(x=>x.id===pid);
    if(sI&&sI.status!=='clean')counts[sid]=(counts[sid]||0)+1;
    if(pI&&pI.status!=='clean')counts[pid]=(counts[pid]||0)+1;
  });
  U.laundry.forEach(i=>{if((i.status==='worn'||i.status==='wash')&&!counts[i.id])counts[i.id]=1;});
  return counts;
}
function daysUntilWashDay(){
  if(!U.washDay)return null;
  const m={Sunday:0,Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6};
  const today=new Date().getDay(),target=m[U.washDay];
  if(target===undefined)return null;
  let diff=target-today;if(diff<=0)diff+=7;return diff;
}
function officeDaysLeft(){return Math.min(U.shirts.filter(s=>s.status==='clean').length,U.pants.filter(p=>p.status==='clean').length);}
function cleanCombosLeft(){
  const used=new Set(recentCombos(14).map(c=>c.shirtId+'|'+c.pantId));let n=0;
  U.shirts.filter(s=>s.status==='clean').forEach(s=>{U.pants.filter(p=>p.status==='clean').forEach(p=>{if(!used.has(s.id+'|'+p.id))n++;});});
  return n;
}
function laundryIntelligence(){
  const wornItems=U.laundry.filter(i=>i.status==='worn');
  const washItems=U.laundry.filter(i=>i.status==='wash');
  const cleanItems=U.laundry.filter(i=>i.status==='clean');
  const wearCounts=computeWearCounts();
  const daysLeft=officeDaysLeft(),combosLeft=cleanCombosLeft(),daysToWash=daysUntilWashDay();
  const total=U.laundry.length||1;
  const overdueItems=U.laundry.filter(i=>{if(i.status==='wash')return false;return(wearCounts[i.id]||0)>=wearLimit(i);});
  const soonItems=U.laundry.filter(i=>{if(i.status==='wash'||overdueItems.includes(i))return false;const w=wearCounts[i.id]||0,lim=wearLimit(i);return w===lim-1&&i.status==='worn';});
  let health=100;
  health-=Math.min(40,overdueItems.length*12);
  health-=Math.min(20,soonItems.length*6);
  health-=Math.max(0,(3-daysLeft)*10);
  health-=Math.max(0,(5-combosLeft)*4);
  if(wornItems.length+washItems.length>total*0.6)health-=15;
  health=Math.max(0,Math.min(100,Math.round(health)));
  let urgency,verdict,suggestion;
  if(health<35||daysLeft<2||overdueItems.length>3){urgency='urgent';verdict='Wash <em>tonight</em>';suggestion=daysLeft<2?`Only ${daysLeft} clean outfit${daysLeft!==1?'s':''} left.`:`${overdueItems.length} item${overdueItems.length!==1?'s':''} past limit.`;}
  else if(health<60||daysLeft<3||overdueItems.length>1){urgency='warning';verdict='Wash <em>soon</em>';suggestion=`${daysLeft} outfit${daysLeft!==1?'s':''} remaining.`;}
  else if(health<80){urgency='good';verdict='On <em>schedule</em>';suggestion=`${daysLeft} clean outfit${daysLeft!==1?'s':''} ready.`;}
  else{urgency='fine';verdict='All <em>good</em>';suggestion=`${daysLeft} outfit${daysLeft!==1?'s':''} available.`;}
  return{health,urgency,verdict,suggestion,daysLeft,combosLeft,daysToWash,overdueItems,soonItems,wearCounts,total};
}
function liItemIcon(item){
  const gid=item.id.replace(/^l/,'');
  const g=U.shirts.find(x=>x.id===gid)||U.pants.find(x=>x.id===gid)||U.outfits.find(x=>x.id===gid);
  const col=g?g.color:'#B8A882';
  const isP=(item.type||'').match(/pant|jean|chino|bottom/i);
  const isO=(item.type||'').match(/outfit|dress|kurta|co-ord/i);
  return `<div style="width:26px;height:26px;border-radius:50%;background:${col}20;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${isO?dressSVG(col,16):isP?pantSVG(col,16):shirtSVG(col,16)}</div>`;
}
function renderLaundryIntel(targetId,showFull){
  const el=document.getElementById(targetId);if(!el)return;
  if(!U.laundry.length){el.innerHTML='';return;}
  const I=laundryIntelligence();
  const ringR=26,circ=2*Math.PI*ringR,offset=circ*(1-I.health/100);
  const ringCol=I.urgency==='urgent'?'var(--accent)':I.urgency==='warning'?'var(--amber)':I.urgency==='good'?'var(--green)':'var(--sky)';
  const ringCls=`li-ring-${I.urgency}`;
  const flagged=[...I.overdueItems.map(i=>({i,wears:I.wearCounts[i.id]||0,limit:wearLimit(i),badge:'lwb-now',txt:'Wash Now'})),...I.soonItems.map(i=>({i,wears:I.wearCounts[i.id]||0,limit:wearLimit(i),badge:'lwb-soon',txt:'Soon'}))];
  const display=(flagged.length?flagged:U.laundry.filter(i=>i.status==='worn').map(i=>({i,wears:I.wearCounts[i.id]||0,limit:wearLimit(i),badge:'lwb-ok',txt:'Worn'}))).slice(0,showFull?20:3);
  const itemsHTML=display.map(({i,wears,limit,badge,txt})=>{
    const pct=Math.min(100,Math.round(wears/limit*100));
    const fc=badge==='lwb-now'?'var(--accent)':badge==='lwb-soon'?'var(--amber)':'var(--green)';
    return `<div class="li-item-row">${liItemIcon(i)}<div style="flex:1;"><div class="li-item-name">${i.name}</div><div class="li-item-sub">${i.type} · ${wears}/${limit} wears</div></div><div class="li-wear-bar"><div class="li-wear-track"><div class="li-wear-fill" style="width:${pct}%;background:${fc};"></div></div><div class="li-wear-label" style="color:${fc};">${wears}/${limit}</div></div><span class="li-wash-badge ${badge}">${txt}</span></div>`;
  }).join('');
  el.innerHTML=`<div class="li-card li-${I.urgency}">
    <div class="li-card-head">
      <div class="li-health-ring ${ringCls}"><svg width="64" height="64" viewBox="0 0 64 64"><circle class="li-ring-track" cx="32" cy="32" r="${ringR}"/><circle class="li-ring-fill" cx="32" cy="32" r="${ringR}" stroke="${ringCol}" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/></svg><div class="li-ring-label"><div class="li-ring-num">${I.health}</div><div class="li-ring-sub">Health</div></div></div>
      <div class="li-head-text"><div class="li-verdict">${I.verdict}</div><div class="li-next-wash">${I.suggestion}${I.daysToWash!==null?' '+U.washDay+' in '+I.daysToWash+'d':''}</div></div>
    </div>
    ${display.length?`<div class="li-items-section"><div class="li-items-title">${flagged.length?'Needs attention':'Worn items'}</div>${itemsHTML}</div>`:''}
    <div class="li-action-row">
      <button class="li-action-btn liab-p" onclick="showPage('wardrobe');setTimeout(()=>document.querySelector('#wardrobeTabs .seg-btn:nth-child(5)').click(),100)">Laundry Board →</button>
      ${I.overdueItems.length>0?`<button class="li-action-btn liab-g" onclick="bulkMoveToWash()">Queue Overdue</button>`:''}
    </div>
  </div>`;
}
function bulkMoveToWash(){
  const I=laundryIntelligence();let moved=0;
  I.overdueItems.forEach(i=>{
    i.status='wash';const gid=i.id.replace(/^l/,'');
    const s=U.shirts.find(x=>x.id===gid),p=U.pants.find(x=>x.id===gid),o=U.outfits.find(x=>x.id===gid);
    if(s)s.status='wash';if(p)p.status='wash';if(o)o.status='wash';moved++;
  });
  if(!moved){toast('No overdue items');return;}
  save();renderToday();renderLaundryIntel('laundryIntelFull',true);renderLaundry();
  toast(`${moved} item${moved!==1?'s':''} queued`);
}

// ── LAUNDRY BOARD ─────────────────────────────
function renderLaundry(){
  renderLaundryIntel('laundryIntelFull',true);
  const g={clean:[],worn:[],wash:[]};
  U.laundry.forEach(i=>{if(g[i.status])g[i.status].push(i);});
  const wearCounts=computeWearCounts();
  ['clean','worn','wash'].forEach(st=>{
    const short=st==='clean'?'cl':st==='worn'?'wo':'wa';
    document.getElementById('lc-'+short).textContent=g[st].length;
    const el=document.getElementById('ll-'+short);
    if(!g[st].length){el.innerHTML='<div class="l-empty">Empty</div>';return;}
    el.innerHTML=g[st].map(item=>{
      const wears=wearCounts[item.id]||0,limit=wearLimit(item);
      const pct=Math.min(100,Math.round(wears/limit*100));
      const fc=pct>=100?'var(--accent)':pct>=66?'var(--amber)':'var(--green)';
      return `<div class="l-item">${liItemIcon(item)}<div style="flex:1;"><div class="li-name">${item.name}</div>${wears>0?`<div style="height:2px;background:rgba(196,184,164,.2);border-radius:1px;overflow:hidden;margin-top:3px;"><div style="width:${pct}%;height:100%;background:${fc};border-radius:1px;"></div></div>`:''}</div><div class="li-acts">${st!=='clean'?`<button class="la la-sg" onclick="moveL('${item.id}','clean')" title="Clean">✓</button>`:''}${st==='clean'?`<button class="la la-gd" onclick="moveL('${item.id}','worn')" title="Worn">◐</button>`:''}${st!=='wash'?`<button class="la la-co" onclick="moveL('${item.id}','wash')" title="Wash">⟳</button>`:''}</div></div>`;
    }).join('');
  });
}
function moveL(id,status){
  const item=U.laundry.find(i=>i.id===id);if(!item)return;
  item.status=status;
  const gid=id.replace(/^l/,'');
  const s=U.shirts.find(x=>x.id===gid),p=U.pants.find(x=>x.id===gid),o=U.outfits.find(x=>x.id===gid);
  if(s)s.status=status;if(p)p.status=status;if(o)o.status=status;
  save();renderLaundry();renderLaundryIntel('laundryIntel',false);
  renderToday();toast(`${item.name} → ${status}`);
}
function markAllClean(){
  U.laundry.forEach(i=>{if(i.status==='wash')i.status='clean';});
  U.shirts.forEach(s=>{if(s.status==='wash')s.status='clean';});
  U.pants.forEach(p=>{if(p.status==='wash')p.status='clean';});
  U.outfits.forEach(o=>{if(o.status==='wash')o.status='clean';});
  save();renderLaundry();renderLaundryIntel('laundryIntel',false);renderToday();toast('All clean ✦');
}
function saveLaundryItem(){
  const name=document.getElementById('li-name').value.trim();
  if(!name){toast('Please enter a name');return;}
  const id='li'+Date.now();
  U.laundry.push({id,name,type:liType,status:'clean',icon:'👔'});
  save();closeAllSheets();renderLaundry();toast(name+' added to laundry');
}

// ── GROCERIES ─────────────────────────────────
let grocFilter='all';
function addGrocery(){
  const inp=document.getElementById('grocInput');
  const name=inp.value.trim();if(!name)return;
  const cat=document.getElementById('grocCat').value;
  SH.groceries.push({id:'gr'+Date.now(),name,cat,bought:false});
  saveShared();inp.value='';renderGroceries();toast(name+' added to list');
}
function renderGroceries(){
  renderGrocFilters();
  const el=document.getElementById('grocList');
  let items=SH.groceries;
  if(grocFilter!=='all')items=items.filter(i=>i.cat===grocFilter);
  if(!items.length){
    el.innerHTML='<div class="empty-state"><div class="es-icon">🛒</div><div class="es-title">List is empty</div><div class="es-body">Add items above to get started.</div></div>';
    return;
  }
  // Sort: pending first, bought last
  const pending=items.filter(i=>!i.bought),bought=items.filter(i=>i.bought);
  const catEmoji={produce:'🥬',dairy:'🥛',household:'🧹',grains:'🌾',snacks:'🍿',other:'📦'};
  el.innerHTML=[...pending,...bought].map(i=>`<div class="groc-item${i.bought?' bought':''}">
    <div class="gi-check" onclick="toggleGrocery('${i.id}')">${i.bought?'✓':''}</div>
    <div class="gi-info"><div class="gi-name">${i.name}</div><div class="gi-cat">${catEmoji[i.cat]||'📦'} ${i.cat}</div></div>
    <button class="gi-del" onclick="deleteGrocery('${i.id}')">×</button>
  </div>`).join('');
}
function renderGrocFilters(){
  const el=document.getElementById('grocFilters');
  const cats=['all','produce','dairy','household','grains','snacks','other'];
  const labels={all:'All',produce:'🥬 Produce',dairy:'🥛 Dairy',household:'🧹 Household',grains:'🌾 Grains',snacks:'🍿 Snacks',other:'📦 Other'};
  el.innerHTML=cats.map(c=>`<button class="gf-btn${grocFilter===c?' on':''}" onclick="setGrocFilter('${c}',this)">${labels[c]}</button>`).join('');
}
function setGrocFilter(f,btn){
  grocFilter=f;renderGroceries();
}
function toggleGrocery(id){
  const item=SH.groceries.find(i=>i.id===id);if(!item)return;
  item.bought=!item.bought;saveShared();renderGroceries();
}
function deleteGrocery(id){
  SH.groceries=SH.groceries.filter(i=>i.id!==id);saveShared();renderGroceries();
}
function clearBoughtItems(){
  SH.groceries=SH.groceries.filter(i=>!i.bought);saveShared();renderGroceries();toast('Bought items cleared');
}
function shareWhatsApp(){
  const pending=SH.groceries.filter(i=>!i.bought);
  if(!pending.length){toast('No pending items to share');return;}
  const catEmoji={produce:'🥬',dairy:'🥛',household:'🧹',grains:'🌾',snacks:'🍿',other:'📦'};
  const grouped={};
  pending.forEach(i=>{if(!grouped[i.cat])grouped[i.cat]=[];grouped[i.cat].push(i.name);});
  let txt='🛒 *Grocery List*\n\n';
  Object.entries(grouped).forEach(([cat,items])=>{
    txt+=`${catEmoji[cat]||'📦'} *${cat.charAt(0).toUpperCase()+cat.slice(1)}*\n`;
    items.forEach(n=>{txt+=`• ${n}\n`;});
    txt+='\n';
  });
  txt+=`_Shared from LifeOS_`;
  window.open('https://wa.me/?text='+encodeURIComponent(txt),'_blank');
}

// ── TASKS ─────────────────────────────────────
let taskFilter = 'all';

function addTask(){
  const inp = document.getElementById('taskInput');
  const name = inp.value.trim();
  if(!name){ toast('Enter a task name'); return; }
  const who = document.getElementById('taskWho').value;
  SH.tasks = SH.tasks || [];
  SH.tasks.push({ id:'tk'+Date.now(), name, who, done:false });
  saveShared();
  inp.value = '';
  renderTasks();
  toast('Task added');
}

function renderTasks(){
  SH.tasks = SH.tasks || [];
  renderTaskFilters();
  const el = document.getElementById('taskList');
  if(!el) return;

  let items = taskFilter === 'all'
    ? SH.tasks
    : SH.tasks.filter(t => t.who === taskFilter || t.who === 'both');

  if(!items.length){
    el.innerHTML = `<div class="empty-state" style="padding:30px 0;">
      <div class="es-icon">✅</div>
      <div class="es-title">No tasks yet</div>
      <div class="es-body">Add tasks above and assign<br>them to yourself, Syamala, or both.</div>
    </div>`;
    return;
  }

  // Pending first, done at bottom
  const pending = items.filter(t => !t.done);
  const done    = items.filter(t => t.done);

  const whoLabel = { H:'Harshit', S:'Syamala', both:'Both' };
  const whoClass = { H:'twb-H', S:'twb-S', both:'twb-both' };
  const whoEmoji = { H:'🙋', S:'🙋‍♀️', both:'👫' };

  el.innerHTML = [...pending, ...done].map(t => `
    <div class="task-item${t.done?' done':''}">
      <div class="task-check" onclick="toggleTask('${t.id}')">${t.done ? '✓' : ''}</div>
      <div class="task-info">
        <div class="task-name">${t.name}</div>
        <span class="task-who-badge ${whoClass[t.who]||'twb-both'}">
          ${whoEmoji[t.who]||'👫'} ${whoLabel[t.who]||'Both'}
        </span>
      </div>
      <button class="task-del" onclick="deleteTask('${t.id}')">×</button>
    </div>`).join('');
}

function renderTaskFilters(){
  const el = document.getElementById('taskWhoFilter');
  if(!el) return;
  const filters = [
    { val:'all', label:'All' },
    { val:'H',   label:'Harshit' },
    { val:'S',   label:'Syamala' },
    { val:'both',label:'Shared' }
  ];
  el.innerHTML = filters.map(f =>
    `<button class="twf-btn${taskFilter===f.val?' on':''}" onclick="setTaskFilter('${f.val}',this)">${f.label}</button>`
  ).join('');
}

function setTaskFilter(f){
  taskFilter = f;
  renderTasks();
}

function toggleTask(id){
  const t = (SH.tasks||[]).find(x => x.id === id);
  if(!t) return;
  t.done = !t.done;
  saveShared();
  renderTasks();
}

function deleteTask(id){
  SH.tasks = (SH.tasks||[]).filter(x => x.id !== id);
  saveShared();
  renderTasks();
}

function clearDoneTasks(){
  SH.tasks = (SH.tasks||[]).filter(t => !t.done);
  saveShared();
  renderTasks();
  toast('Completed tasks cleared');
}

// ── MEAL PLANNER ──────────────────────────────
const DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const SLOTS=['Breakfast','Lunch','Dinner'];
function getMealWeekStart(){
  const today=new Date();
  const day=today.getDay();
  const diff=(day===0?-6:1-day);
  const mon=new Date(today);mon.setDate(today.getDate()+diff+(SH.mealWeekOffset||0)*7);
  return mon;
}
function buildMealGrid(){
  const weekStart=getMealWeekStart();
  const endDate=new Date(weekStart);endDate.setDate(weekStart.getDate()+6);
  const fmt=d=>d.toLocaleDateString('en-IN',{month:'short',day:'numeric'});
  document.getElementById('mealWeekLbl').textContent=`${fmt(weekStart)} – ${fmt(endDate)}`;
  const grid=document.getElementById('mealGrid');
  grid.innerHTML=DAYS.map((day,di)=>{
    const d=new Date(weekStart);d.setDate(weekStart.getDate()+di);
    const ds=d.toISOString().slice(0,10);
    const isToday=ds===new Date().toISOString().slice(0,10);
    return `<div class="meal-day-row">
      <div class="meal-day-hd" style="${isToday?'color:var(--accent);':''}">${day} <span style="font-weight:500;font-size:10px;color:var(--tx3);margin-left:4px;">${fmt(d)}</span></div>
      <div class="meal-slots">${SLOTS.map(slot=>`<div class="meal-slot">
        <div class="ms-lbl">${slot}</div>
        <input class="ms-inp" placeholder="What's cooking?" value="${SH.meals[ds+'-'+slot]||''}"
          oninput="saveMeal('${ds}','${slot}',this.value)">
      </div>`).join('')}</div>
    </div>`;
  }).join('');
}
function saveMeal(date,slot,val){
  SH.meals[date+'-'+slot]=val;saveShared();
}
function shiftMealWeek(dir){SH.mealWeekOffset=(SH.mealWeekOffset||0)+dir;saveShared();buildMealGrid();}

// ── CALENDAR ──────────────────────────────────
function getCalDate(){
  const d=new Date();d.setDate(1);
  d.setMonth(d.getMonth()+(SH.calMonthOffset||0));return d;
}
function buildCalendar(){
  const base=getCalDate();
  const month=base.getMonth(),year=base.getFullYear();
  document.getElementById('calMonthLbl').textContent=base.toLocaleDateString('en-IN',{month:'long',year:'numeric'});
  const firstDay=new Date(year,month,1).getDay();
  const daysInMonth=new Date(year,month+1,0).getDate();
  const today=new Date().toISOString().slice(0,10);

  // Event date set
  const evtDates=new Set(SH.events.map(e=>e.date));
  const leaveDates=new Set(SH.events.filter(e=>{
    const d=new Date(e.date);const dow=d.getDay();
    return dow>0&&dow<6&&(e.type==='travel'||e.type==='festival'||e.type==='personal');
  }).map(e=>e.date));

  const dayHeaders=['Su','Mo','Tu','We','Th','Fr','Sa'];
  let html=dayHeaders.map(d=>`<div class="cal-dh">${d}</div>`).join('');

  // Empty cells before first
  for(let i=0;i<firstDay;i++) html+=`<div class="cal-day other-month"></div>`;

  for(let d=1;d<=daysInMonth;d++){
    const ds=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday=ds===today;
    const hasEvt=evtDates.has(ds);
    const needsLeave=leaveDates.has(ds);
    html+=`<div class="cal-day${isToday?' today':''}${hasEvt?' has-event':''}${needsLeave?' needs-leave':''}" onclick="calDayClick('${ds}')">${d}</div>`;
  }
  document.getElementById('calGrid').innerHTML=html;
  buildLeaveAlerts();
  buildEventsList();
}
function calDayClick(ds){
  document.getElementById('ev-date').value=ds;
  openSheet('eventSheet');
}
function shiftCalMonth(dir){SH.calMonthOffset=(SH.calMonthOffset||0)+dir;saveShared();buildCalendar();}

function buildLeaveAlerts(){
  const upcoming=SH.events.filter(e=>{
    const d=new Date(e.date);const dow=d.getDay();
    const today=new Date().toISOString().slice(0,10);
    return e.date>=today&&dow>0&&dow<6&&(e.type==='travel'||e.type==='festival'||e.type==='personal');
  }).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,4);

  const el=document.getElementById('leaveAlerts');
  if(!upcoming.length){el.innerHTML='';return;}
  el.innerHTML=`<div class="leave-alert">
    <div class="la-title">🗓 You may need leave for:</div>
    ${upcoming.map(e=>`<div class="la-item">📌 ${e.name} — ${new Date(e.date).toLocaleDateString('en-IN',{weekday:'short',month:'short',day:'numeric'})}</div>`).join('')}
  </div>`;
}

function buildEventsList(){
  const el=document.getElementById('calEventsList');
  const base=getCalDate();
  const month=base.getMonth(),year=base.getFullYear();
  const evts=SH.events.filter(e=>{const d=new Date(e.date);return d.getMonth()===month&&d.getFullYear()===year;}).sort((a,b)=>a.date.localeCompare(b.date));
  if(!evts.length){
    el.innerHTML='<div class="empty-state" style="padding:20px;"><div class="es-icon">📅</div><div class="es-body">No events this month.<br>Tap a date or + Event to add one.</div></div>';
    return;
  }
  const typeCol={personal:'ce-personal',office:'ce-office',travel:'ce-travel',festival:'ce-festival'};
  el.innerHTML=evts.map(e=>{
    const d=new Date(e.date);const dow=d.getDay();
    const needsLeave=dow>0&&dow<6&&(e.type==='travel'||e.type==='festival'||e.type==='personal');
    return `<div class="cal-event">
      <div class="ce-dot ${typeCol[e.type]||'ce-personal'}"></div>
      <div class="ce-info">
        <div class="ce-name">${e.name}</div>
        <div class="ce-date">${d.toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long'})}</div>
        ${e.note?`<div style="font-size:11px;color:var(--tx3);margin-top:2px;">${e.note}</div>`:''}
        <div style="margin-top:4px;">
          ${needsLeave?'<span class="ce-leave-flag">⚠ May need leave</span>':''}
          ${e.gcal?'<span class="ce-gcal-flag">📅 Google Cal</span>':''}
        </div>
      </div>
      <button class="ce-del" onclick="deleteEvent('${e.id}')">×</button>
    </div>`;
  }).join('');
}

// ── CALENDAR — GOOGLE CALENDAR SYNC ──────────
async function saveEvent(){
  const name=document.getElementById('ev-name').value.trim();
  const date=document.getElementById('ev-date').value;
  if(!name||!date){toast('Please fill in name and date');return;}
  const note=document.getElementById('ev-note').value.trim();
  const id='ev'+Date.now();
  const event={id,name,date,type:evtType,note,gcal:gcalSync};
  SH.events.push(event);saveShared();
  closeAllSheets();buildCalendar();

  if(gcalSync){
    document.getElementById('gcalSaving').style.display='block';
    await syncEventToGCal(event);
    document.getElementById('gcalSaving').style.display='none';
    toast(`${name} saved + synced to Google Calendar ✦`);
  } else {
    toast(`${name} saved`);
  }
}

async function syncEventToGCal(event){
  try{
    const startDT=event.date+'T09:00:00';
    const endDT=event.date+'T10:00:00';
    const response=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
      body:JSON.stringify({
        model:'claude-sonnet-4-20250514',
        max_tokens:1000,
        mcp_servers:[{type:'url',url:'https://www.googleapis.com/calendar/v3',name:'google-calendar-mcp'}],
        messages:[{role:'user',content:`Create a Google Calendar event: title="${event.name}", start="${startDT}", end="${endDT}", description="${event.note||''}", calendarId="primary". Use the calendar tool to create it.`}]
      })
    });
    const data=await response.json();
    console.log('GCal sync response:',data);
    toast(event.name+' synced to Google Calendar');
  }catch(err){
    console.error('GCal sync error:',err);
    toast('Saved locally · GCal sync requires hosting');
  }
}

function deleteEvent(id){
  SH.events=SH.events.filter(e=>e.id!==id);
  saveShared();buildCalendar();toast('Event deleted');
}

// ── ROUTINES ──────────────────────────────────
function renderRoutines(){
  const el=document.getElementById('routineList');
  const morning=SH.routines.filter(r=>r.period==='morning');
  const evening=SH.routines.filter(r=>r.period==='evening');
  const catClass={wardrobe:'rtc-wardrobe',work:'rtc-work',routine:'rtc-routine'};
  const section=(label,items)=>`
    <div class="rt-period">${label}</div>
    ${items.map(r=>`<div class="rt-item">
      <div class="rt-time">${r.time}</div>
      <div class="rt-name">${r.name}</div>
      <span class="rt-cat ${catClass[r.cat]||'rtc-routine'}">${r.cat}</span>
    </div>`).join('')}`;
  el.innerHTML=section('🌅 Morning',morning)+section('🌙 Evening',evening);
}

// ── PLANNER CALC ──────────────────────────────
function runCalc(){
  const d=+document.getElementById('ci-d').value||5;
  const w=+document.getElementById('ci-w').value||10;
  const b=+document.getElementById('ci-b').value||3;
  const l=+document.getElementById('ci-l').value||14;
  const minCombos=w+b;
  const cleanCycle=Math.ceil(l/d);
  const minShirts=Math.ceil(cleanCycle*1.2);
  const minPants=Math.ceil(cleanCycle*0.6);
  const minS2=Math.ceil(Math.sqrt(minCombos*0.7));
  const minP2=Math.ceil(minCombos/minS2);
  const recShirts=Math.max(minShirts,minS2);
  const recPants=Math.max(minPants,minP2);
  document.getElementById('calcResult').innerHTML=`
    <div class="cr-lbl">Recommended Wardrobe</div>
    <div class="cr-val">${recShirts} Shirts · ${recPants} Pants</div>
    <div class="cr-note">Gives ${recShirts*recPants} combos · ${recShirts*recPants-w} combo buffer · suits ${l}-day laundry cycle.</div>`;
}

// ── FULL RENDER ───────────────────────────────
function renderAll(){
  renderToday();
  renderCloset();
  renderRoutines();
  runCalc();
}

// ── THEME TOGGLE ──────────────────────────────
function initTheme(){
  const saved = localStorage.getItem('lifeos-theme') || 'light';
  if(saved === 'dark'){
    document.body.classList.add('dark-mode');
    const icon = document.getElementById('themeIcon');
    if(icon) icon.textContent = 'light_mode';
  }
}
function toggleTheme(){
  const isDark = document.body.classList.toggle('dark-mode');
  localStorage.setItem('lifeos-theme', isDark ? 'dark' : 'light');
  const icon = document.getElementById('themeIcon');
  if(icon) icon.textContent = isDark ? 'light_mode' : 'dark_mode';
}

// ── INIT ──────────────────────────────────────
initTheme();
updateWardrobeTabs();
setFC(U.fc||'all', document.getElementById('fc'+(U.fc==='formal'?'Formal':U.fc==='casual'?'Casual':'All')));
renderAll();
buildColorSwatches();
runCalc();

// Set today's date as default for event sheet
document.getElementById('ev-date').value=new Date().toISOString().slice(0,10);

