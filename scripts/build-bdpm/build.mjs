#!/usr/bin/env node
/**
 * build-bdpm — Génère un snapshot JSON de la BDPM pour le mobile.
 *
 * Source : Base de Données Publique des Médicaments (ANSM/HAS/Ameli)
 *   https://base-donnees-publique.medicaments.gouv.fr/telechargement.php
 * Licence : Licence Ouverte Etalab — réutilisation libre, y compris commerciale.
 *
 * Sortie :
 *   ./out/medications.min.json   (catalogue complet normalisé)
 *   ./out/version.json           (métadonnées : date, count, hash)
 *
 * Exécution :
 *   node scripts/build-bdpm/build.mjs
 *
 * Aucune dépendance npm — utilise fetch + TextDecoder natifs (Node 22).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');

const BASE_DL = 'https://base-donnees-publique.medicaments.gouv.fr/download/file/';
const FILES = {
  cis:    'CIS_bdpm.txt',
  compo:  'CIS_COMPO_bdpm.txt',
  cip:    'CIS_CIP_bdpm.txt',
  gener:  'CIS_GENER_bdpm.txt',
  cpd:    'CIS_CPD_bdpm.txt',
  smr:    'CIS_HAS_SMR_bdpm.txt',
};

/* ───── HTTP helpers ─────────────────────────────────────── */
async function downloadText(url, label) {
  const started = Date.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DoserAlert-BDPM-Builder/1.0 (open-source)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`[DL] ${label}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // BDPM = Latin-1 (ISO-8859-1)
  const text = new TextDecoder('latin1').decode(buf);
  console.log(`  ✓ ${label.padEnd(8)} ${(buf.length / 1024).toFixed(1).padStart(7)} KB · ${Date.now() - started} ms`);
  return text;
}

/* ───── TSV parser (tabs, pas de quoting) ─────────────────── */
function parseTSV(text) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\t'));
}

/* ───── Normalisation ────────────────────────────────────── */
function cleanStr(s) {
  return (s || '').trim();
}

function parseFrDate(s) {
  // BDPM : "jj/mm/aaaa" → "aaaa-mm-jj"
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cleanStr(s));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function shortName(fullName) {
  // "DOLIPRANE 1000 mg, comprimé" → "DOLIPRANE"
  const n = cleanStr(fullName);
  // On coupe au premier chiffre, au premier "," ou au premier mot de moins de 3 lettres
  const cut = n.search(/\s\d|,/);
  return cut > 0 ? n.slice(0, cut).trim() : n;
}

function detectPrescription(cpdLabel) {
  const s = cleanStr(cpdLabel).toLowerCase();
  if (!s) return false;
  return /liste\s+i|liste\s+ii|stupéfiant|stupefiant|assimilé|psychotrope/.test(s);
}

/* ───── Pipeline ─────────────────────────────────────────── */
async function build() {
  console.log('▶ Téléchargement des fichiers BDPM…');
  const raw = {};
  for (const [k, name] of Object.entries(FILES)) {
    raw[k] = await downloadText(BASE_DL + name, name);
  }

  console.log('▶ Parsing TSV…');

  // ── CIS principal : 1 ligne = 1 médicament ──
  // Colonnes : CIS · Dénomination · Forme · Voies admin · Statut AMM · Procédure
  //           · Commercialisation · Date AMM · StatusBdm · Num EU · Titulaire(s) · Surveillance
  const meds = new Map(); // cis → med
  for (const cols of parseTSV(raw.cis)) {
    const cis = cleanStr(cols[0]);
    if (!cis) continue;
    const name = cleanStr(cols[1]);
    meds.set(cis, {
      cis,
      name,
      shortName: shortName(name),
      form: cleanStr(cols[2]),
      administration: cleanStr(cols[3]).split(';').map(cleanStr).filter(Boolean).join(', '),
      ammStatus: cleanStr(cols[4]),
      marketingStatus: cleanStr(cols[6]),
      ammDate: parseFrDate(cols[5]) || parseFrDate(cols[7]),
      holder: cleanStr(cols[10]),
      surveillance: /oui/i.test(cleanStr(cols[11] || '')),
      // remplis ensuite :
      substances: [],
      substancesLabel: '',
      prescriptionRequired: false,
      generic: false,
      genericGroupId: null,
      presentations: [],
    });
  }
  console.log(`  ✓ ${meds.size} médicaments référencés`);

  // ── Composition (substances actives) ──
  // Cols : CIS · désignation · code SA · nom SA · dosage · unité · nature · num lien
  // On ne garde que "SA" (substance active), pas les "FT" (fraction thérapeutique).
  let compoCount = 0;
  for (const cols of parseTSV(raw.compo)) {
    const cis = cleanStr(cols[0]);
    const m = meds.get(cis);
    if (!m) continue;
    const nature = cleanStr(cols[6]).toUpperCase();
    if (nature && nature !== 'SA') continue;
    const subName = cleanStr(cols[3]);
    if (!subName) continue;
    const dose = [cleanStr(cols[4]), cleanStr(cols[5])].filter(Boolean).join(' ');
    m.substances.push({ name: subName, dose });
    compoCount++;
  }
  // Construit le label lisible (compact pour l'UI mobile)
  for (const m of meds.values()) {
    m.substancesLabel = m.substances
      .map(s => s.dose ? `${s.name} ${s.dose}` : s.name)
      .join(' + ');
  }
  console.log(`  ✓ ${compoCount} substances actives mappées`);

  // ── Conditions de prescription (Liste I/II/Stupéfiant) ──
  // Cols : CIS · libellé CPD
  let cpdCount = 0;
  for (const cols of parseTSV(raw.cpd)) {
    const cis = cleanStr(cols[0]);
    const m = meds.get(cis);
    if (!m) continue;
    if (detectPrescription(cols[1])) {
      m.prescriptionRequired = true;
      cpdCount++;
    }
  }
  console.log(`  ✓ ${cpdCount} médicaments sous prescription`);

  // ── Groupes génériques ──
  // Cols : groupId · libellé · CIS · type (0=princeps, 1/2/4=générique) · tri
  for (const cols of parseTSV(raw.gener)) {
    const cis = cleanStr(cols[2]);
    const m = meds.get(cis);
    if (!m) continue;
    const groupId = Number(cleanStr(cols[0])) || null;
    const type = Number(cleanStr(cols[3])) || 0;
    m.genericGroupId = groupId;
    m.generic = type !== 0; // 0 = princeps, autre = générique
  }

  // ── Présentations (CIP13, prix, remboursement) ──
  // Cols : CIS · CIP7 · libellé · statut · commercialisation · date · CIP13 · agrément
  //       · taux remb. · prix · prix hors honoraires · honoraires · indication remb.
  let presCount = 0;
  for (const cols of parseTSV(raw.cip)) {
    const cis = cleanStr(cols[0]);
    const m = meds.get(cis);
    if (!m) continue;
    const cip13 = cleanStr(cols[6]);
    if (!cip13) continue;
    const rate = cleanStr(cols[8]);
    const price = parseFloat(cleanStr(cols[9]).replace(',', '.'));
    m.presentations.push({
      cip13,
      label: cleanStr(cols[2]),
      marketing: cleanStr(cols[4]),
      reimbursementRate: rate || null,
      price: Number.isFinite(price) ? price : null,
    });
    presCount++;
  }
  console.log(`  ✓ ${presCount} présentations (CIP13) mappées`);

  // ── Filtrage final : on garde uniquement les AMM actives ──
  // (les "Autorisation abrogée/retirée/suspendue" polluent inutilement le mobile)
  const all = [...meds.values()];
  const active = all.filter(m =>
    !/abrogé|retiré|suspendu|annulé/i.test(m.ammStatus || '')
  );
  console.log(`  ✓ ${active.length}/${all.length} médicaments avec AMM active (${all.length - active.length} filtrés)`);

  // ── Tri alphabétique par shortName pour cohérence inter-builds ──
  active.sort((a, b) => a.shortName.localeCompare(b.shortName, 'fr', { sensitivity: 'base' }));

  // ── Génération des sorties ──
  const today = new Date().toISOString().slice(0, 10);
  const generatedAt = new Date().toISOString();

  // SLIM : tout ce qui est nécessaire à la recherche + carte résultat mobile.
  //        Pas de presentations, pas de dates, pas de surveillance.
  const slimMeds = active.map(m => ({
    cis:                  m.cis,
    name:                 m.name,
    shortName:            m.shortName,
    form:                 m.form || undefined,
    administration:       m.administration || undefined,
    holder:               m.holder || undefined,
    substancesLabel:      m.substancesLabel || undefined,
    marketingStatus:      m.marketingStatus || undefined,
    prescriptionRequired: m.prescriptionRequired || undefined,
    generic:              m.generic || undefined,
  }));
  const slim = {
    version: today, generatedAt,
    source: 'BDPM (ANSM/HAS/Ameli) — Licence Ouverte Etalab',
    count: slimMeds.length,
    medications: slimMeds,
  };

  // FULL : version exhaustive pour fiche détaillée (à charger à la demande).
  const full = {
    version: today, generatedAt,
    source: 'BDPM (ANSM/HAS/Ameli) — Licence Ouverte Etalab',
    count: active.length,
    medications: active,
  };

  const slimJson = JSON.stringify(slim);
  const fullJson = JSON.stringify(full);
  const hash = createHash('sha256').update(slimJson).digest('hex').slice(0, 16);
  const version = {
    version: today, count: slim.count, hash, generatedAt,
    files: {
      slim: 'medications.min.json',
      full: 'medications.full.json',
    },
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'medications.min.json'),  slimJson, 'utf8');
  await writeFile(join(OUT_DIR, 'medications.full.json'), fullJson, 'utf8');
  await writeFile(join(OUT_DIR, 'version.json'), JSON.stringify(version, null, 2), 'utf8');

  const slimMB = (Buffer.byteLength(slimJson, 'utf8') / 1024 / 1024).toFixed(2);
  const fullMB = (Buffer.byteLength(fullJson, 'utf8') / 1024 / 1024).toFixed(2);
  console.log(`\n✅ Build terminé`);
  console.log(`   version       : ${today}`);
  console.log(`   medications   : ${active.length}`);
  console.log(`   slim (search) : ${slimMB} MB`);
  console.log(`   full (detail) : ${fullMB} MB`);
  console.log(`   hash          : ${hash}`);
  console.log(`   out           : ${OUT_DIR}`);
}

build().catch(err => {
  console.error('\n❌ Échec du build :', err);
  process.exit(1);
});
