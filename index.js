const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const ROOT = process.env.SYNC_ROOT || '/data';
const CONFIG = process.env.SYNC_CONFIG || path.join(ROOT, 'sync', 'sync.conf');
const BASE_NAME = process.env.BASE_DIR || 'base';
const BASE = path.join(ROOT, BASE_NAME);
const EXCLUDE = new Set(['sync', BASE_NAME, 'node_modules', '.git', 'backup']);
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '2000', 10);

function log(...args) { console.log(new Date().toISOString(), ...args); }

function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function readConfig() {
  try {
    return fs.readFileSync(CONFIG, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch (e) {
    log('config read error:', e.message);
    return [];
  }
}

function getProjects() {
  try {
    return fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => !EXCLUDE.has(name) && !name.startsWith('.'));
  } catch (e) {
    log('readdir error:', e.message);
    return [];
  }
}

function walkFiles(dir) {
  const result = [];
  if (!exists(dir) || !isDir(dir)) return result;
  const rec = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) rec(full);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          result.push({ rel: path.relative(dir, full), full, mtime: st.mtimeMs });
        } catch {}
      }
    }
  };
  rec(dir);
  return result;
}

async function syncFile(locations) {
  // locations: absolute file paths that exist
  let newest = null;
  for (const loc of locations) {
    try {
      const st = fs.statSync(loc);
      if (!newest || st.mtimeMs > newest.mtime) newest = { loc, mtime: st.mtimeMs };
    } catch {}
  }
  if (!newest) return;
  let data;
  try { data = fs.readFileSync(newest.loc); } catch { return; }
  for (const loc of locations) {
    try {
      const st = fs.statSync(loc);
      if (st.mtimeMs < newest.mtime) {
        fs.writeFileSync(loc, data);
        const d = new Date(newest.mtime);
        fs.utimesSync(loc, d, d);
        log('updated file:', loc);
      }
    } catch {}
  }
}

async function syncFolder(locations) {
  // locations: absolute dir paths that exist
  const locFiles = locations.map(loc => walkFiles(loc));
  const fileSet = new Set();
  for (const arr of locFiles) for (const f of arr) fileSet.add(f.rel);

  for (const rel of fileSet) {
    let newest = null;
    for (let i = 0; i < locations.length; i++) {
      const f = locFiles[i].find(x => x.rel === rel);
      if (f && (!newest || f.mtime > newest.mtime)) {
        newest = { idx: i, mtime: f.mtime, full: f.full };
      }
    }
    if (!newest) continue;
    let data;
    try { data = fs.readFileSync(newest.full); } catch { continue; }
    for (let i = 0; i < locations.length; i++) {
      const target = path.join(locations[i], rel);
      const f = locFiles[i].find(x => x.rel === rel);
      if (!f || f.mtime < newest.mtime) {
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, data);
          const d = new Date(newest.mtime);
          fs.utimesSync(target, d, d);
          log('updated:', target);
        } catch (e) { log('write error:', target, e.message); }
      }
    }
  }
}

async function syncOnePath(P) {
  const baseP = path.join(BASE, P);
  const projects = getProjects();
  const existingProj = projects
    .map(name => path.join(ROOT, name, P))
    .filter(p => exists(p));

  const dirSomewhere = isDir(baseP) || existingProj.some(p => isDir(p));
  const fileSomewhere = isFile(baseP) || existingProj.some(p => isFile(p));

  if (dirSomewhere) {
    if (!exists(baseP) && existingProj.length) {
      try { fs.mkdirSync(baseP, { recursive: true }); } catch {}
    }
    const locs = [baseP, ...existingProj].filter(p => exists(p) && isDir(p));
    if (locs.length >= 1) await syncFolder(locs);
  } else if (fileSomewhere) {
    if (!exists(baseP) && existingProj.length) {
      // pick newest project file -> base
      let newest = null;
      for (const p of existingProj) {
        try {
          const st = fs.statSync(p);
          if (!newest || st.mtimeMs > newest.mtime) newest = { p, mtime: st.mtimeMs };
        } catch {}
      }
      if (newest) {
        try {
          fs.mkdirSync(path.dirname(baseP), { recursive: true });
          fs.copyFileSync(newest.p, baseP);
          const d = new Date(newest.mtime);
          fs.utimesSync(baseP, d, d);
          log('seeded base from project:', baseP);
        } catch (e) { log('seed error:', e.message); }
      }
    }
    const locs = [baseP, ...existingProj].filter(p => exists(p) && isFile(p));
    if (locs.length >= 2) await syncFile(locs);
  }
}

let syncing = false;
let pending = false;
async function syncAll() {
  if (syncing) { pending = true; return; }
  syncing = true;
  try {
    const paths = readConfig();
    for (const P of paths) {
      try { await syncOnePath(P); } catch (e) { log('path error', P, e.message); }
    }
  } finally {
    syncing = false;
    if (pending) { pending = false; scheduleSync(); }
  }
}

let timer = null;
function scheduleSync() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; syncAll(); }, DEBOUNCE_MS);
}

async function main() {
  log('sync service started');
  log('ROOT:', ROOT, 'CONFIG:', CONFIG, 'BASE:', BASE);
  try { fs.mkdirSync(BASE, { recursive: true }); } catch {}
  await syncAll();

  const watcher = chokidar.watch(ROOT, {
    persistent: true,
    usePolling: true,
    interval: 2000,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignored: (p) => {
      const parts = p.split(path.sep);
      return parts.some(part => part === 'node_modules' || part === '.git');
    }
  });
  watcher.on('all', (event, p) => {
    // ignore changes inside sync folder config? still sync
    scheduleSync();
  });
  watcher.on('error', (e) => log('watcher error:', e.message));
  log('watching', ROOT);
}

main().catch(e => { console.error(e); process.exit(1); });
