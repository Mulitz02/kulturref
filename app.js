// Kulturref HBC – Partyplanung mit Live-Abgleich über Firebase.
// Alle Inhalte (Abläufe, Kontakte, Termine) liegen in der geschützten Datenbank, nicht in diesem Code.
import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, setDoc, updateDoc,
  deleteDoc, writeBatch, serverTimestamp, deleteField, FieldPath } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 864e5;
const P = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const F = t => new Date(t).toISOString().slice(0, 10);
const add = (s, n) => F(P(s) + n * DAY);
const now = new Date();
const TODAY = F(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
const diff = s => Math.round((P(s) - P(TODAY)) / DAY);
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const dshort = s => { const d = new Date(P(s)); return WD[d.getUTCDay()] + " " + s.slice(8, 10) + "." + s.slice(5, 7) + "."; };
const dlong = s => dshort(s) + s.slice(2, 4);
const PHASES = ["Langer Vorlauf", "2 Wochen vorher", "Woche davor", "Am Tag", "Danach", "Eigene Aufgaben"];
const INFO_TYPES = ["sonst", "hangout"];
let toastT;
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2200); }
function rel(s) {
  const n = diff(s);
  if (n === 0) return "heute";
  if (n === 1) return "morgen";
  if (n === -1) return "gestern";
  if (n < 0) return "seit " + (-n) + " Tagen";
  if (n < 7) return "in " + n + " Tagen";
  return dshort(s);
}

// ---------- Setup ----------
const main = $("main");
if (!firebaseConfig.apiKey) {
  main.innerHTML = `<div class="card"><h2>Noch nicht verbunden</h2><p>Die App ist noch mit keinem Firebase-Projekt verbunden. Trag die Werte in <code>config.js</code> ein.</p></div>`;
  throw new Error("config fehlt");
}
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
auth.languageCode = "de";
let db;
try { db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = initializeFirestore(fb, {}); }

// ---------- Zustand ----------
let me = null, members = null, events = [], tasks = [], templates = {}, contacts = [];
let tab = "due", dueFilter = "all", showLater = false, showInfo = false, openEvent = null, unsub = [];
const email = () => (me?.email || "").toLowerCase();
const isAdmin = () => !!members && (members.admins || []).includes(email());
const nameOf = e => !e ? "" : (members?.names?.[e] || e.split("@")[0]);
const initials = e => nameOf(e).split(/[\s.]+/).filter(Boolean).map(x => x[0]).join("").slice(0, 2).toUpperCase();

// ---------- Login ----------
getRedirectResult(auth).catch(() => {});
if (isSignInWithEmailLink(auth, location.href)) {
  let m = localStorage.getItem("kr-mail") || prompt("Zur Bestätigung: deine E-Mail-Adresse");
  if (m) signInWithEmailLink(auth, m, location.href)
    .then(() => { localStorage.removeItem("kr-mail"); history.replaceState(null, "", location.pathname); })
    .catch(e => toast("Link ungültig oder abgelaufen"));
}

onAuthStateChanged(auth, u => {
  me = u; unsub.forEach(f => f()); unsub = []; members = null;
  $("me").hidden = !u; $("tabs").hidden = true;
  if (!u) return renderLogin();
  $("me").textContent = u.email;
  main.innerHTML = `<div class="loading">Prüfe Zugang …</div>`;
  unsub.push(onSnapshot(doc(db, "config", "members"), snap => {
    if (!snap.exists()) return bootstrap();
    const first = !members;
    members = snap.data();
    $("me").textContent = nameOf(email());
    if (first) startData();
    else render();
  }, err => noAccess(err)));
});

async function bootstrap() {
  // Erstes Login des Admins: Mitgliederliste anlegen (die Regeln erlauben das nur dem Admin)
  try {
    await setDoc(doc(db, "config", "members"), { admins: [email()], emails: [email()], names: { [email()]: me.displayName || "" } });
  } catch (e) { noAccess(e); }
}

function noAccess(err) {
  console.warn(err);
  $("tabs").hidden = true;
  main.innerHTML = `<div class="card"><h2>Kein Zugang</h2>
    <p>Du bist als <b>${esc(me?.email)}</b> angemeldet, aber für diese App noch nicht freigeschaltet.</p>
    <p>Schick deine Adresse an einen Admin des Kulturreferats – er schaltet dich unter <i>Mehr → Mitglieder</i> frei.</p>
    <button class="btn" data-act="logout">Abmelden</button></div>`;
}

function renderLogin() {
  main.innerHTML = `<div class="card login">
    <h2>Anmelden</h2>
    <p>Nur für das Kulturreferat. Melde dich mit der Adresse an, die freigeschaltet wurde.</p>
    <button class="btn primary wide" data-act="google">Mit Google anmelden</button>
    <div class="or">oder per E-Mail-Link</div>
    <form id="mailform" class="row-form">
      <input type="email" id="mailin" placeholder="name@beispiel.de" autocomplete="email" required>
      <button class="btn">Link senden</button>
    </form>
  </div>`;
  $("mailform").onsubmit = async e => {
    e.preventDefault();
    const m = $("mailin").value.trim();
    try {
      await sendSignInLinkToEmail(auth, m, { url: location.origin + location.pathname, handleCodeInApp: true });
      localStorage.setItem("kr-mail", m);
      main.querySelector(".login").insertAdjacentHTML("beforeend", `<p class="ok">Link ist unterwegs – öffne ihn auf diesem Gerät.</p>`);
    } catch (err) { toast("Senden fehlgeschlagen: " + err.code); }
  };
}

// ---------- Daten live ----------
function startData() {
  $("tabs").hidden = false;
  const sub = (name, fn) => unsub.push(onSnapshot(collection(db, name), s => { fn(s.docs.map(d => ({ id: d.id, ...d.data() }))); render(); }, noAccess));
  sub("events", a => events = a.sort((x, y) => (x.date + (x.time || "")).localeCompare(y.date + (y.time || ""))));
  sub("tasks", a => tasks = a);
  sub("templates", a => templates = Object.fromEntries(a.map(t => [t.id, t])));
  sub("contacts", a => contacts = a.sort((x, y) => (x.o ?? 99) - (y.o ?? 99) || x.name.localeCompare(y.name)));
  render();
}

// ---------- Hilfen ----------
const evById = id => events.find(e => e.id === id);
const tasksOf = id => tasks.filter(t => t.ev === id);
const isParty = e => !INFO_TYPES.includes(e.type);
const progress = id => { const a = tasksOf(id); return [a.filter(t => t.done).length, a.length]; };
const tplLabel = ty => templates[ty]?.label || ty;
function nextParty() { return events.find(e => isParty(e) && e.date >= TODAY); }

function taskRow(t, showEv = true) {
  const ev = t.ev ? evById(t.ev) : null;
  const n = diff(t.due);
  const cls = t.done ? "done" : n < 0 ? "late" : n <= 2 ? "soon" : "";
  const where = ev ? `<button class="link" data-act="open" data-id="${ev.id}">${esc(ev.title)} · ${dshort(ev.date)}</button>` : `<span>${esc(t.sec || "Allgemein")}</span>`;
  return `<div class="task ${cls}">
    <button class="cb" data-act="toggle" data-id="${t.id}" aria-label="erledigt">${t.done ? "✓" : ""}</button>
    <div class="tt">
      <div class="tx">${esc(t.t)}</div>
      <div class="meta">${showEv ? where + " · " : ""}<span class="due">${t.done ? "erledigt" + (t.doneBy ? " von " + esc(nameOf(t.doneBy)) : "") : esc(rel(t.due))}</span></div>
    </div>
    <button class="who ${t.who ? "set" : ""}" data-act="assign" data-id="${t.id}" title="Zuständig: ${esc(nameOf(t.who) || "niemand")}">${t.who ? esc(initials(t.who)) : "+"}</button>
  </div>`;
}

// ---------- Ansichten ----------
function render() {
  if (!members) return;
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab && !openEvent));
  if (openEvent) return renderEvent(openEvent);
  ({ due: renderDue, events: renderEvents, sec: renderSec, contacts: renderContacts, more: renderMore })[tab]();
}

function emptyHint() {
  return `<div class="card"><h2>Noch keine Daten</h2><p>${isAdmin() ? "Importiere die Startdatei (Terminplan + Abläufe) unter <b>Mehr → Daten</b>." : "Ein Admin muss die Startdaten noch importieren."}</p>
  ${isAdmin() ? `<button class="btn primary" data-act="tab" data-tab="more">Zu den Daten</button>` : ""}</div>`;
}

function renderDue() {
  if (!events.length && !tasks.length) { main.innerHTML = emptyHint(); return; }
  let open = tasks.filter(t => !t.done);
  if (dueFilter === "mine") open = open.filter(t => t.who === email());
  if (dueFilter === "free") open = open.filter(t => !t.who);
  open.sort((a, b) => a.due.localeCompare(b.due) || (a.o ?? 0) - (b.o ?? 0));
  const g = { late: [], week: [], soon: [], later: [] };
  open.forEach(t => { const n = diff(t.due); (n < 0 ? g.late : n <= 7 ? g.week : n <= 21 ? g.soon : g.later).push(t); });
  const np = nextParty();
  let h = "";
  if (np) {
    const [d, a] = progress(np.id), n = diff(np.date);
    h += `<button class="next" data-act="open" data-id="${np.id}">
      <div class="k">Nächste Party · ${n === 0 ? "heute" : n === 1 ? "morgen" : "in " + n + " Tagen"}</div>
      <div class="ttl">${esc(np.title)}</div>
      <div class="meta">${dlong(np.date)}${np.time ? " · " + esc(np.time) + " Uhr" : ""} · ${esc(np.loc || "")}${np.sec ? " · " + np.sec + " Securities ab " + esc(np.secStart) : ""}</div>
      ${a ? `<div class="bar"><i style="width:${Math.round(d / a * 100)}%"></i></div><div class="meta">${d} von ${a} Aufgaben erledigt</div>` : ""}
    </button>`;
  }
  h += `<div class="seg">${[["all", "Alle"], ["mine", "Meine"], ["free", "Ohne Zuständige"]].map(([k, l]) => `<button class="${dueFilter === k ? "on" : ""}" data-act="filter" data-f="${k}">${l}</button>`).join("")}</div>`;
  const sec = (title, list, cls = "") => list.length ? `<h3 class="${cls}">${title} <span class="n">${list.length}</span></h3><div class="list">${list.map(t => taskRow(t)).join("")}</div>` : "";
  h += sec("Überfällig", g.late, "warn") + sec("Diese Woche", g.week) + sec("Nächste 2 Wochen", g.soon);
  if (g.later.length) h += showLater ? sec("Später", g.later) : `<button class="btn ghost wide" data-act="later">Später fällig anzeigen (${g.later.length})</button>`;
  if (!g.late.length && !g.week.length && !g.soon.length) h += `<div class="empty">Für die nächsten drei Wochen ist nichts offen. 🎉</div>`;
  main.innerHTML = h;
}

function renderEvents() {
  if (!events.length) { main.innerHTML = emptyHint() + addEventForm(); bindAddForm(); return; }
  const list = events.filter(e => showInfo || isParty(e));
  let h = `<div class="bar-row"><label class="switch"><input type="checkbox" data-act="info" ${showInfo ? "checked" : ""}> Infotermine zeigen</label>
    <button class="btn" data-act="newev">+ Party</button></div><div id="newevbox"></div>`;
  let month = "";
  list.forEach(e => {
    const m = new Date(P(e.date)).toLocaleDateString("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });
    if (m !== month) { month = m; h += `<h3>${m}</h3>`; }
    const [d, a] = progress(e.id), past = e.date < TODAY;
    const late = tasksOf(e.id).filter(t => !t.done && t.due < TODAY).length;
    h += `<button class="ev ${past ? "past" : ""} ${isParty(e) ? "" : "info"}" data-act="open" data-id="${e.id}">
      <div class="date"><b>${e.date.slice(8, 10)}</b><span>${WD[new Date(P(e.date)).getUTCDay()]}</span></div>
      <div class="body"><div class="ttl">${esc(e.title)}</div>
        <div class="meta">${esc(tplLabel(e.type))}${e.loc ? " · " + esc(e.loc) : ""}${e.time ? " · " + esc(e.time) : ""}</div>
        ${a ? `<div class="bar"><i style="width:${Math.round(d / a * 100)}%"></i></div>` : ""}</div>
      <div class="side">${a ? `<span class="${late ? "pill warn" : "pill"}">${late ? late + " überfällig" : d + "/" + a}</span>` : ""}${e.sec ? `<span class="pill sec">⛨ ${e.sec}</span>` : ""}</div>
    </button>`;
  });
  main.innerHTML = h;
}

function addEventForm() {
  const opts = Object.values(templates).sort((a, b) => a.label.localeCompare(b.label)).map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
  return `<form class="card form" id="evform"><h2>Neue Party</h2>
    <label>Titel<input name="title" required placeholder="z. B. Malle-Party"></label>
    <div class="grid2"><label>Datum<input type="date" name="date" required></label><label>Beginn<input type="time" name="time" value="20:00"></label></div>
    <label>Art (bestimmt Checkliste & Security)<select name="type" required>${opts}</select></label>
    <label>Location<input name="loc" placeholder="wird aus der Art übernommen"></label>
    <div class="actions"><button type="button" class="btn ghost" data-act="cancelnew">Abbrechen</button><button class="btn primary">Anlegen</button></div></form>`;
}
function bindAddForm() {
  const f = $("evform"); if (!f) return;
  f.onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const tp = templates[d.type];
    if (!tp) return toast("Keine Vorlagen vorhanden – erst Startdaten importieren");
    const id = d.date + "-" + d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30) + "-" + Math.random().toString(36).slice(2, 5);
    const ev = { title: d.title, date: d.date, time: d.time, loc: d.loc || tp.loc || "", type: d.type, sec: tp.sec || 0, secStart: tp.start || "21:00", notes: "", pack: {} };
    const b = writeBatch(db);
    b.set(doc(db, "events", id), ev);
    tasksFor({ id, ...ev }, tp).forEach(t => b.set(doc(db, "tasks", t.id), t));
    await b.commit();
    openEvent = id; render(); toast("Party angelegt");
  };
}
function tasksFor(ev, tp, markDone = false) {
  return (tp.tasks || []).filter(x => !(x.sec && !ev.sec)).map(x => {
    const t = { id: ev.id + "-" + x.o, ev: ev.id, t: x.t, off: x.off, ph: x.ph, o: x.o, due: add(ev.date, x.off), done: markDone, who: "" };
    if (x.sec) t.secTask = true;
    if (x.tix) t.tix = true;
    return t;
  });
}

function renderEvent(id) {
  const e = evById(id);
  if (!e) { openEvent = null; return render(); }
  const tp = templates[e.type] || {};
  const list = tasksOf(id).sort((a, b) => a.due.localeCompare(b.due) || (a.o ?? 0) - (b.o ?? 0));
  const [d, a] = progress(id);
  const tix = ["abdera", "ranking"].includes(e.type);
  let h = `<button class="back" data-act="back">‹ Zurück</button>
  <div class="card head">
    <div class="k">${esc(tplLabel(e.type))}</div>
    <h2>${esc(e.title)}</h2>
    <div class="meta">${dlong(e.date)} · ${e.date >= TODAY ? (diff(e.date) === 0 ? "heute" : "in " + diff(e.date) + " Tagen") : "vorbei"}</div>
    ${a ? `<div class="bar"><i style="width:${Math.round(d / a * 100)}%"></i></div><div class="meta">${d} von ${a} Aufgaben erledigt</div>` : ""}
    <div class="grid3">
      <label>Datum<input type="date" value="${e.date}" data-ev="date"></label>
      <label>Beginn<input type="time" value="${esc(e.time || "")}" data-ev="time"></label>
      <label>Location<input value="${esc(e.loc || "")}" data-ev="loc"></label>
    </div>
    <div class="grid3">
      <label>Securities<input type="number" min="0" inputmode="numeric" value="${e.sec || 0}" data-ev="sec"></label>
      <label>Security ab<input type="time" value="${esc(e.secStart || "21:00")}" data-ev="secStart"></label>
      ${tix ? `<label>Tickets verkauft<input type="number" min="0" inputmode="numeric" value="${e.tickets ?? ""}" data-ev="tickets"></label>` : "<span></span>"}
    </div>
    ${e.secNote ? `<div class="note">⛨ ${esc(e.secNote)}</div>` : ""}
    ${tix ? ticketLight(e.tickets) : ""}
  </div>`;
  if ((tp.info || []).length) h += `<div class="card info"><h3>Gut zu wissen</h3><ul>${tp.info.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  if (list.length || isParty(e)) {
    h += `<h3>Checkliste</h3>`;
    PHASES.forEach(ph => {
      const l = list.filter(t => (t.ph || "Eigene Aufgaben") === ph);
      if (!l.length) return;
      const first = l[0].due;
      h += `<div class="phase"><div class="ph">${ph}<span>${ph === "Eigene Aufgaben" ? "" : "ab " + dshort(first)}</span></div><div class="list">${l.map(t => taskRow(t, false)).join("")}</div></div>`;
    });
    h += `<form class="row-form" id="addtask"><input name="t" placeholder="Eigene Aufgabe hinzufügen" required><input type="date" name="due" value="${e.date}"><button class="btn">+</button></form>`;
  }
  const pack = [...new Set([...(tp.pack || []), ...Object.keys(e.pack || {})])];
  if (pack.length || isParty(e)) {
    h += `<h3>Packliste</h3><div class="card packs">${pack.map(p => `<label class="pk"><input type="checkbox" data-pack="${esc(p)}" ${e.pack?.[p] ? "checked" : ""}> ${esc(p)}</label>`).join("")}
      <form class="row-form" id="addpack"><input name="p" placeholder="Weiteres Teil" required><button class="btn">+</button></form></div>`;
  }
  h += `<h3>Notizen & Nachbereitung</h3><div class="card"><textarea id="notes" rows="5" placeholder="Was lief gut, was schief? Mengen, Kontakte, Tipps für nächstes Mal …">${esc(e.notes || "")}</textarea>
    <div class="meta" id="notesstate">${e.notesBy ? "zuletzt von " + esc(nameOf(e.notesBy)) : ""}</div></div>
    <button class="btn danger" data-act="delev" data-id="${id}">Party löschen</button>`;
  main.innerHTML = h;
  window.scrollTo(0, 0);
  bindEvent(e);
}
function ticketLight(n) {
  if (n === undefined || n === null || n === "") return `<div class="note">Ticketstand eintragen – unter 100 verkauften Tickets fahrt ihr Minus.</div>`;
  n = +n;
  const c = n >= 100 ? "go" : n >= 70 ? "mid" : "stop";
  const txt = n >= 100 ? "Über 100 – passt." : n >= 70 ? "Knapp – nochmal Werbung machen." : "Unter 70 – Verschieben in den Hecht prüfen und auf Eventim absagen.";
  return `<div class="light ${c}"><i></i>${n} Tickets · ${txt}</div>`;
}
function bindEvent(e) {
  main.querySelectorAll("[data-ev]").forEach(inp => inp.onchange = async () => {
    const k = inp.dataset.ev; let v = inp.value;
    if (k === "sec" || k === "tickets") v = v === "" ? null : +v;
    if (k === "date") {
      if (!v) return;
      const shift = confirm("Fristen der offenen Aufgaben an das neue Datum anpassen?");
      const b = writeBatch(db);
      b.update(doc(db, "events", e.id), { date: v });
      if (shift) tasksOf(e.id).forEach(t => { if (!t.done && typeof t.off === "number") b.update(doc(db, "tasks", t.id), { due: add(v, t.off) }); });
      await b.commit(); return toast("Datum geändert");
    }
    if (k === "sec" && v > 0 && !tasksOf(e.id).some(t => t.secTask)) {
      // Security dazugekommen: Empfang & Protokoll ergänzen
      const tp = templates[e.type];
      const extra = (tp?.tasks || []).filter(x => x.sec).map(x => ({ id: e.id + "-" + x.o, ev: e.id, t: x.t, off: x.off, ph: x.ph, o: x.o, due: add(e.date, x.off), done: false, who: "", secTask: true }));
      const b = writeBatch(db); extra.forEach(t => b.set(doc(db, "tasks", t.id), t)); await b.commit();
    }
    await updateDoc(doc(db, "events", e.id), { [k]: v });
  });
  const nt = $("notes"); let nT;
  if (nt) nt.oninput = () => { clearTimeout(nT); $("notesstate").textContent = "…"; nT = setTimeout(async () => { await updateDoc(doc(db, "events", e.id), { notes: nt.value, notesBy: email() }); $("notesstate").textContent = "gespeichert"; }, 900); };
  main.querySelectorAll("[data-pack]").forEach(c => c.onchange = () => updateDoc(doc(db, "events", e.id), new FieldPath("pack", c.dataset.pack), c.checked));
  const at = $("addtask");
  if (at) at.onsubmit = async ev => {
    ev.preventDefault(); const d = Object.fromEntries(new FormData(at));
    const id = e.id + "-x" + Date.now().toString(36);
    await setDoc(doc(db, "tasks", id), { ev: e.id, t: d.t, due: d.due || e.date, ph: "Eigene Aufgaben", o: 999, done: false, who: "" });
  };
  const ap = $("addpack");
  if (ap) ap.onsubmit = async ev => { ev.preventDefault(); const p = new FormData(ap).get("p").trim(); if (p) await updateDoc(doc(db, "events", e.id), new FieldPath("pack", p), false); };
}

function renderSec() {
  const list = events.filter(e => e.sec > 0 && e.date >= TODAY);
  const unclear = events.filter(e => e.secNote && e.date >= TODAY);
  let h = `<div class="card"><h2>Security-Planung</h2><p class="meta">Rotunde ab 20 Uhr, sonst ab 21 Uhr · Hecht Opening/Closing 2 · Abdera 3 · Erstie & Endstation 4 · Winterball 10 · Open-Air ca. 9. Anpassen in der jeweiligen Party.</p>
    <table class="tbl"><thead><tr><th>Datum</th><th>Party</th><th>Anz.</th><th>ab</th></tr></thead><tbody>
    ${list.map(e => `<tr data-act="open" data-id="${e.id}"><td>${dlong(e.date)}</td><td>${esc(e.title)}<div class="meta">${esc(e.loc || "")}</div></td><td><b>${e.sec}</b></td><td>${esc(e.secStart)}</td></tr>`).join("") || `<tr><td colspan="4">Keine kommenden Partys mit Security.</td></tr>`}
    </tbody></table>
    <div class="meta">Insgesamt ${list.reduce((s, e) => s + e.sec, 0)} Security-Einsätze an ${list.length} Abenden.</div>
    <button class="btn primary wide" data-act="copysec">Text für Raphi kopieren</button></div>`;
  if (unclear.length) h += `<div class="card info"><h3>Noch zu klären</h3><ul>${unclear.map(e => `<li><b>${esc(e.title)}</b>: ${esc(e.secNote)}</li>`).join("")}</ul></div>`;
  main.innerHTML = h;
}
function secText() {
  const list = events.filter(e => e.sec > 0 && e.date >= TODAY);
  return "Hi Raphi,\n\nhier die Security-Termine vom Kulturreferat:\n\n" +
    list.map(e => `${dlong(e.date)} – ${e.title} (${e.loc || "-"}): ${e.sec} Securities ab ${e.secStart} Uhr`).join("\n") +
    "\n\nSag gern Bescheid, falls etwas nicht passt. Danke dir!\n" + (nameOf(email()) || "");
}

function renderContacts() {
  let h = `<div class="bar-row"><h2 style="margin:0">Kontakte</h2><button class="btn" data-act="newcontact">+ Kontakt</button></div>`;
  h += contacts.map(c => `<details class="card contact"><summary><div><b>${esc(c.name)}</b><div class="meta">${esc(c.role || "")}${c.note ? " · " + esc(c.note) : ""}</div></div>
      <div class="cact">${c.phone ? `<a class="btn sm" href="tel:${esc(c.phone.replace(/\s/g, ""))}">Anrufen</a>` : ""}${c.mail ? `<a class="btn sm" href="mailto:${esc(c.mail)}">Mail</a>` : ""}</div></summary>
      <div class="grid2">
        <label>Name<input value="${esc(c.name)}" data-c="${c.id}" data-k="name"></label>
        <label>Rolle<input value="${esc(c.role || "")}" data-c="${c.id}" data-k="role"></label>
        <label>Telefon<input type="tel" value="${esc(c.phone || "")}" data-c="${c.id}" data-k="phone"></label>
        <label>E-Mail<input type="email" value="${esc(c.mail || "")}" data-c="${c.id}" data-k="mail"></label>
      </div>
      <label>Notiz<input value="${esc(c.note || "")}" data-c="${c.id}" data-k="note"></label>
      <button class="btn danger sm" data-act="delcontact" data-id="${c.id}">Kontakt löschen</button>
    </details>`).join("") || emptyHint();
  main.innerHTML = h;
  main.querySelectorAll("[data-c]").forEach(i => i.onchange = () => updateDoc(doc(db, "contacts", i.dataset.c), { [i.dataset.k]: i.value.trim() }));
}

function renderMore() {
  const gen = tasks.filter(t => !t.ev).sort((a, b) => a.due.localeCompare(b.due));
  const secs = [...new Set(gen.map(t => t.sec || "Allgemein"))];
  let h = `<h2>Semesteraufgaben</h2>`;
  secs.forEach(s => {
    const l = gen.filter(t => (t.sec || "Allgemein") === s);
    h += `<div class="phase"><div class="ph">${esc(s)}<span>${l.filter(t => t.done).length}/${l.length}</span></div><div class="list">${l.map(t => taskRow(t, false)).join("")}</div></div>`;
  });
  h += `<form class="row-form" id="addgen"><input name="t" placeholder="Allgemeine Aufgabe" required><input type="date" name="due" value="${add(TODAY, 7)}"><button class="btn">+</button></form>`;

  const mem = members.emails || [];
  h += `<h2>Mitglieder</h2><div class="card">${mem.map(m => `<div class="mem"><span class="who set">${esc(initials(m))}</span><div><b>${esc(nameOf(m))}</b><div class="meta">${esc(m)}${(members.admins || []).includes(m) ? " · Admin" : ""}</div></div>
    ${isAdmin() ? `<button class="btn sm" data-act="rename" data-m="${esc(m)}">Name</button>` : ""}${isAdmin() && m !== email() ? `<button class="btn sm danger" data-act="delmem" data-m="${esc(m)}">Entfernen</button>` : ""}</div>`).join("")}
    ${isAdmin() ? `<form class="card form inner" id="memform"><h3>Mitglied freischalten</h3>
      <div class="grid2"><label>E-Mail (Google oder Mail-Link)<input type="email" name="m" required></label><label>Name<input name="n" placeholder="Vorname"></label></div>
      <label class="switch"><input type="checkbox" name="a"> auch Admin (darf Mitglieder verwalten)</label>
      <button class="btn primary">Freischalten</button></form>` : ""}</div>`;

  h += `<h2>Daten</h2><div class="card">
    ${isAdmin() ? `<label class="btn wide filebtn">Startdaten importieren (.json)<input type="file" accept="application/json,.json" id="importfile" hidden></label>
      <p class="meta">Legt Termine, Checklisten, Kontakte und Semesteraufgaben an. Bestehende Einträge mit gleicher ID werden überschrieben, erledigte Haken bleiben nur bei neuen Einträgen leer.</p>` : ""}
    <button class="btn wide" data-act="exportnotes">Übergabe-Notizen exportieren</button>
    <button class="btn wide" data-act="backup">Backup herunterladen</button>
    <button class="btn wide ghost" data-act="logout">Abmelden</button></div>
    <p class="meta center">Änderungen gleichen sich sofort zwischen allen Mitgliedern ab.</p>`;
  main.innerHTML = h;

  const ag = $("addgen");
  ag.onsubmit = async e => { e.preventDefault(); const d = Object.fromEntries(new FormData(ag)); await setDoc(doc(db, "tasks", "g-" + Date.now().toString(36)), { ev: null, sec: "Allgemein", t: d.t, due: d.due, done: false, who: "" }); };
  const mf = $("memform");
  if (mf) mf.onsubmit = async e => {
    e.preventDefault(); const d = new FormData(mf); const m = d.get("m").trim().toLowerCase();
    const upd = { emails: [...new Set([...(members.emails || []), m])], names: { ...(members.names || {}), [m]: (d.get("n") || "").trim() } };
    if (d.get("a")) upd.admins = [...new Set([...(members.admins || []), m])];
    await updateDoc(doc(db, "config", "members"), upd); toast(m + " freigeschaltet");
  };
  const fi = $("importfile");
  if (fi) fi.onchange = () => fi.files[0] && importSeed(fi.files[0]);
}

// ---------- Import / Export ----------
async function importSeed(file) {
  let j;
  try { j = JSON.parse(await file.text()); } catch (e) { return toast("Datei ist kein gültiges JSON"); }
  if (j.kind !== "kulturref-seed") return toast("Das ist keine Kulturref-Startdatei");
  if (events.length && !confirm("Es gibt schon Daten. Trotzdem importieren? Gleichnamige Einträge werden überschrieben.")) return;
  const ops = [];
  Object.entries(j.templates).forEach(([k, v]) => ops.push(["templates", k, v]));
  j.events.forEach(e => {
    const { id, ...rest } = e;
    ops.push(["events", id, { notes: "", pack: {}, ...rest }]);
    tasksFor(e, j.templates[e.type] || {}, e.date < TODAY).forEach(t => { const { id: tid, ...r } = t; ops.push(["tasks", tid, r]); });
  });
  j.general.forEach((g, i) => ops.push(["tasks", "g-" + String(i).padStart(3, "0"), { ev: null, sec: g.sec, t: g.t, due: g.due, o: i, done: false, who: "" }]));
  j.contacts.forEach((c, i) => ops.push(["contacts", "c-" + String(i).padStart(3, "0"), { ...c, o: i }]));
  toast("Importiere " + ops.length + " Einträge …");
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([c, id, d]) => b.set(doc(db, c, id), d));
    await b.commit();
  }
  toast("Import fertig: " + j.events.length + " Termine");
  tab = "due"; render();
}
function download(name, text, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
function exportNotes() {
  let s = "# Kulturreferat – Notizen zur Übergabe\n\nExport vom " + dlong(TODAY) + "\n\n";
  events.filter(isParty).forEach(e => {
    const open = tasksOf(e.id).filter(t => !t.done && e.date < TODAY);
    if (!e.notes && !open.length) return;
    s += `## ${e.title} – ${dlong(e.date)} (${e.loc || ""})\n\n${e.notes || "_keine Notizen_"}\n\n`;
    if (open.length) s += "Nicht abgehakt:\n" + open.map(t => "- " + t.t).join("\n") + "\n\n";
  });
  s += "## Kontakte\n\n" + contacts.map(c => `- **${c.name}** (${c.role || ""})${c.phone ? " · " + c.phone : ""}${c.mail ? " · " + c.mail : ""}${c.note ? " – " + c.note : ""}`).join("\n") + "\n";
  download("Kulturref-Uebergabe-" + TODAY + ".md", s, "text/markdown");
}

// ---------- Klicks ----------
document.addEventListener("click", async ev => {
  const b = ev.target.closest("[data-act],[data-tab]");
  if (!b) return;
  if (b.closest("#tabs")) { tab = b.dataset.tab; openEvent = null; render(); window.scrollTo(0, 0); return; }
  const a = b.dataset.act, id = b.dataset.id;
  try {
    switch (a) {
      case "google": {
        const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
        try { await signInWithPopup(auth, p); } catch (e) { if (/popup/.test(e.code)) await signInWithRedirect(auth, p); else toast("Anmeldung fehlgeschlagen: " + e.code); }
        break;
      }
      case "logout": await signOut(auth); break;
      case "tab": tab = b.dataset.tab; openEvent = null; render(); break;
      case "toggle": {
        const t = tasks.find(x => x.id === id);
        await updateDoc(doc(db, "tasks", id), t.done ? { done: false, doneBy: deleteField(), doneAt: deleteField() } : { done: true, doneBy: email(), doneAt: serverTimestamp() });
        break;
      }
      case "assign": {
        const t = tasks.find(x => x.id === id);
        const cyc = ["", ...(members.emails || [])];
        const nx = cyc[(cyc.indexOf(t.who || "") + 1) % cyc.length];
        await updateDoc(doc(db, "tasks", id), { who: nx });
        toast(nx ? "Zuständig: " + nameOf(nx) : "Niemand zuständig");
        break;
      }
      case "filter": dueFilter = b.dataset.f; render(); break;
      case "later": showLater = true; render(); break;
      case "open": openEvent = id; render(); break;
      case "back": openEvent = null; render(); break;
      case "newev": $("newevbox").innerHTML = addEventForm(); bindAddForm(); $("evform").scrollIntoView({ behavior: "smooth" }); break;
      case "cancelnew": $("newevbox") ? $("newevbox").innerHTML = "" : render(); break;
      case "delev": {
        const e = evById(id);
        if (!confirm(`„${e.title}" mit allen Aufgaben löschen?`)) break;
        const bt = writeBatch(db); bt.delete(doc(db, "events", id)); tasksOf(id).forEach(t => bt.delete(doc(db, "tasks", t.id))); await bt.commit();
        openEvent = null; render(); toast("Gelöscht"); break;
      }
      case "copysec": await navigator.clipboard.writeText(secText()); toast("Text kopiert – jetzt in WhatsApp einfügen"); break;
      case "newcontact": await setDoc(doc(db, "contacts", "c-" + Date.now().toString(36)), { name: "Neuer Kontakt", role: "", phone: "", mail: "", note: "", o: 99 }); break;
      case "delcontact": if (confirm("Kontakt löschen?")) await deleteDoc(doc(db, "contacts", id)); break;
      case "delmem": {
        const m = b.dataset.m;
        if (!confirm(m + " entfernen?")) break;
        await updateDoc(doc(db, "config", "members"), { emails: (members.emails || []).filter(x => x !== m), admins: (members.admins || []).filter(x => x !== m) });
        break;
      }
      case "rename": {
        const m = b.dataset.m, n = prompt("Anzeigename für " + m, nameOf(m));
        if (n !== null) await updateDoc(doc(db, "config", "members"), { names: { ...(members.names || {}), [m]: n.trim() } });
        break;
      }
      case "exportnotes": exportNotes(); break;
      case "backup": download("Kulturref-Backup-" + TODAY + ".json", JSON.stringify({ kind: "kulturref-backup", date: TODAY, events, tasks, contacts, templates }, null, 1)); break;
    }
  } catch (e) { console.error(e); toast(e.code === "permission-denied" ? "Keine Berechtigung" : "Fehler: " + (e.code || e.message)); }
});
document.addEventListener("change", ev => { if (ev.target.dataset.act === "info") { showInfo = ev.target.checked; render(); } });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
