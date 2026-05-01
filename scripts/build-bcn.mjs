#!/usr/bin/env node
/**
 * ETL — Descarga los datasets oficiales del Ajuntament de Barcelona
 * (Open Data BCN) y regenera `parkingZonesDirect-bcn.json`.
 *
 * Pensado para correr dentro de una GitHub Action programada
 * (`.github/workflows/refresh-bcn.yml`). El workflow ejecuta este
 * script cada noche; si el JSON resultante difiere del actual,
 * commitea automáticamente. Las apps APPARCAR fetchean el JSON
 * remoto y se actualizan.
 *
 * Sin dependencias npm — solo Node 18+ (fetch nativo).
 *
 * Datasets fuente:
 *   - trams-aparcament-superficie     (~17k tramos con coords)
 *   - horaris-aparcaments-superficie  (~100 horarios CA)
 *   - tarifes-aparcament-superficie   (~25 tarifas €)
 *   - colors-aparcaments-superficie   (5 códigos color)
 *
 * Output: parkingZonesDirect-bcn.json (3-4 MB, JSON array compacto).
 */

import { writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const OUTPUT_PATH = join(REPO_ROOT, "parkingZonesDirect-bcn.json");

const CKAN_BASE = "https://opendata-ajuntament.barcelona.cat/data/api/3/action";

// Los IDs de cada package (CKAN dataset)
const PACKAGES = {
  trams: "trams-aparcament-superficie",
  horaris: "horaris-aparcaments-superficie",
  tarifes: "tarifes-aparcament-superficie",
  colors: "colors-aparcaments-superficie",
};

// ---------------------------------------------------------------------------
// Descubre URL del CSV "vivo" (no ZIP histórico) por package
// ---------------------------------------------------------------------------

async function getLatestCsvUrl(packageId) {
  const r = await fetch(`${CKAN_BASE}/package_show?id=${packageId}`);
  if (!r.ok) throw new Error(`CKAN package_show ${packageId}: HTTP ${r.status}`);
  const json = await r.json();
  const resources = json?.result?.resources ?? [];
  // Primer recurso CSV (los ZIP son históricos mensuales)
  const csv = resources.find((x) => (x.format || "").toUpperCase() === "CSV");
  if (!csv?.url) throw new Error(`No CSV resource in ${packageId}`);
  return csv.url;
}

async function fetchCsv(url) {
  const r = await fetch(url, { headers: { Accept: "text/csv" } });
  if (!r.ok) throw new Error(`Fetch ${url}: HTTP ${r.status}`);
  return r.text();
}

// ---------------------------------------------------------------------------
// Mini parser CSV (handles quoted commas)
// ---------------------------------------------------------------------------

function parseCSV(text) {
  const lines = [];
  let cur = "";
  let row = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (c === "," && !inQ) {
      row.push(cur);
      cur = "";
    } else if ((c === "\n" || c === "\r") && !inQ) {
      if (cur || row.length) {
        row.push(cur);
        lines.push(row);
        row = [];
        cur = "";
      }
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      cur += c;
    }
  }
  if (cur || row.length) {
    row.push(cur);
    lines.push(row);
  }
  return lines;
}

function rowsToObjects(rows) {
  const headers = rows[0].map((s) => s.trim());
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const o = {};
    headers.forEach((k, i) => (o[k] = r[i]));
    return o;
  });
}

// ---------------------------------------------------------------------------
// Traducción horario catalán → sintaxis OSM
// ---------------------------------------------------------------------------

const DAY_CA = { Dl: "Mo", Dt: "Tu", Dc: "We", Dj: "Th", Dv: "Fr", Ds: "Sa", Dg: "Su" };

function parseHorariCA(desc) {
  if (!desc) return "";
  let s = desc.trim();
  s = s.replace(/excepte.*$/i, "").trim();
  s = s.replace(/^[A-Z]+:\s*/, "");
  let days = "";
  let m = s.match(/^de\s+(\w{2})\s+a\s+(\w{2})\b/);
  if (m) {
    const a = DAY_CA[m[1]];
    const b = DAY_CA[m[2]];
    if (a && b) days = a + "-" + b;
    s = s.substring(m[0].length).trim();
  } else {
    m = s.match(/^(\w{2}(?:[,\s]+\w{2})*)/);
    if (m) {
      const dd = m[1].split(/[,\s]+/).map((d) => DAY_CA[d]).filter(Boolean);
      if (dd.length) days = dd.join(",");
      s = s.substring(m[0].length).trim();
    }
  }
  const intervals = [];
  const re = /de\s+(\d{1,2}):(\d{2})\s+a\s+(\d{1,2}):(\d{2})/g;
  let r;
  while ((r = re.exec(s))) {
    const sh = r[1].padStart(2, "0");
    const sm = r[2];
    const eh = r[3].padStart(2, "0");
    const em = r[4];
    intervals.push(`${sh}:${sm}-${eh}:${em}`);
  }
  if (!days || !intervals.length) return desc;
  return `${days} ${intervals.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Mapeo TIPUS_TRAM → color/label
// ---------------------------------------------------------------------------

const COLOR_MAP = {
  AZL: { color: "blue", label: "Zona Blava (rotación)" },
  VM: { color: "green", label: "Àrea Verda mixta (rotació + residents)" },
  VR: { color: "green", label: "Àrea Verda residents" },
  DUM: { color: "orange", label: "DUM (càrrega i descàrrega)" },
  BUS: { color: "orange", label: "Parada bus" },
};

// ---------------------------------------------------------------------------
// Limpieza de direcciones
// ---------------------------------------------------------------------------

const SMALL = new Set(["DE", "DEL", "DELS", "LA", "EL", "I", "D", "L", "EN"]);

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w+/g, (w) => {
    if (SMALL.has(w.toUpperCase())) return w.toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

function cleanAddress(adr) {
  if (!adr) return "";
  const parts = adr.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  const street = titleCase(parts[0]);
  const nbr = (parts[1] || "").replace(/\s+/g, " ").trim();
  return nbr ? `${street} ${nbr}` : street;
}

function streetOnly(adr) {
  if (!adr) return "";
  const parts = adr.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? titleCase(parts[0]) : "";
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  console.log("APPARCAR data refresh — descargando Open Data BCN");

  const urls = {};
  for (const [k, pkg] of Object.entries(PACKAGES)) {
    process.stdout.write(`  · ${k} (${pkg})... `);
    urls[k] = await getLatestCsvUrl(pkg);
    process.stdout.write("OK\n");
  }

  process.stdout.write("Descargando CSVs... ");
  const [tramsCsv, horarisCsv, tarifesCsv] = await Promise.all([
    fetchCsv(urls.trams),
    fetchCsv(urls.horaris),
    fetchCsv(urls.tarifes),
    // colors no se usa en runtime — el color viene de TIPUS_TRAM
  ]);
  process.stdout.write("OK\n");

  const trams = rowsToObjects(parseCSV(tramsCsv));
  const horaris = rowsToObjects(parseCSV(horarisCsv));
  const tarifes = rowsToObjects(parseCSV(tarifesCsv));

  console.log(
    `Parseados: ${trams.length} tramos, ${horaris.length} horarios, ${tarifes.length} tarifas`
  );

  const horarisBy = {};
  horaris.forEach((h) => (horarisBy[h.ID_HORARI] = h));
  const tarifesBy = {};
  tarifes.forEach((t) => (tarifesBy[t.ID_TARIFA] = t));

  const processed = [];
  let skipped = 0;
  for (const t of trams) {
    const lng1 = parseFloat(t.LONGITUD_I);
    const lat1 = parseFloat(t.LATITUD_I);
    const lng2 = parseFloat(t.LONGITUD_F);
    const lat2 = parseFloat(t.LATITUD_F);
    if (
      !Number.isFinite(lng1) ||
      !Number.isFinite(lat1) ||
      !Number.isFinite(lng2) ||
      !Number.isFinite(lat2)
    ) {
      skipped++;
      continue;
    }
    const colorInfo = COLOR_MAP[t.TIPUS_TRAM];
    if (!colorInfo) {
      skipped++;
      continue;
    }
    const horari = horarisBy[t.ID_HORARIO];
    const tarifa = tarifesBy[t.ID_TARIFA];
    const hoursOSM = horari ? parseHorariCA(horari.DESCRIPCIO) : "";
    const feeStr = tarifa ? tarifa.DESCRIPCIO : "";
    processed.push({
      i: t.ID_TRAM,
      c: colorInfo.color,
      l: colorInfo.label,
      h: hoursOSM,
      f: feeStr,
      s: streetOnly(t["ADREÇA"]),
      a: cleanAddress(t["ADREÇA"]),
      p: parseInt(t.PLACES, 10) || 0,
      g: [
        [+lng1.toFixed(6), +lat1.toFixed(6)],
        [+lng2.toFixed(6), +lat2.toFixed(6)],
      ],
    });
  }

  console.log(`Procesados: ${processed.length} tramos (${skipped} descartados)`);

  // Comparar con el JSON existente — si no hay cambios reales, no
  // commiteamos. Esto evita inflar el git log con commits idénticos.
  const newJson = JSON.stringify(processed);
  let oldJson = null;
  try {
    oldJson = await readFile(OUTPUT_PATH, "utf8");
  } catch {
    /* no existe aún */
  }

  if (oldJson === newJson) {
    console.log("Sin cambios respecto al JSON anterior. Salgo sin escribir.");
    process.exit(0);
  }

  await writeFile(OUTPUT_PATH, newJson, "utf8");
  console.log(`Escrito ${OUTPUT_PATH} (${(newJson.length / 1024 / 1024).toFixed(2)} MB)`);

  // Devuelve diff conciso para el commit message
  if (oldJson) {
    let oldLen = 0;
    try {
      const oldArr = JSON.parse(oldJson);
      oldLen = oldArr.length;
    } catch {
      /* corrupto */
    }
    console.log(`Diff: ${oldLen} → ${processed.length} tramos`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
