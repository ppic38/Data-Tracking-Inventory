/**
 * ============================================================
 * MODUL 5 - ORCHESTRATOR
 * ============================================================
 * [VERSI v3 -- MENYESUAIKAN MODUL 3 (SURAT JALAN NEW) & MODUL 4 v3]
 *
 * PERUBAHAN vs v2:
 * 1. [HAPUS TOTAL] groupGIRegRibPairs_ dan seluruh logic gabung 2 link PO
 *    (REG+RIB) jadi 1 entri PO DIHAPUS. PO REG dan RIB SEKARANG SELALU
 *    diproses TERPISAH (masing-masing link sheet-nya sendiri, nomor koli
 *    masing-masing dipakai APA ADANYA, TIDAK di-offset -- karena nomor koli
 *    REG dan RIB sudah pasti tidak akan tabrakan satu sama lain).
 * 2. [BARU] buildIntransitMatchCandidates_(nomorPO) -- dipakai untuk
 *    menentukan urutan kandidat pencarian ke INTRANSIT & DASHBOARD (HPP):
 *    kalau nomor PO berakhiran " REG" atau " RIB" (pola GI), coba dulu versi
 *    GABUNGAN (base tanpa suffix -- karena INTRANSIT biasanya mencatat
 *    REG+RIB sebagai SATU checklist bersama), baru fallback ke nomor PO
 *    ASLINYA sendiri (kalau ternyata di INTRANSIT dicatat terpisah). Kalau
 *    bukan pola GI REG/RIB, kandidatnya cuma nomor PO itu sendiri.
 * 3. [SEDERHANA] STATUS HPP sekarang SELALU salah satu dari 'ADA HPP' /
 *    'BELUM ADA HPP' (tidak pernah string kosong lagi), sesuai Modul 4 v3.
 * 4. Sumber SURAT JALAN sekarang SURAT JALAN NEW (Modul 3 v5) -- field-field
 *    entri yang dipakai (nomorKoli, itemStandard, matched, qty, tglPengiriman,
 *    resi, tipe) bentuknya SAMA seperti sebelumnya, jadi bagian agregasi
 *    (WIP, ON PRODUCTION, DATA REJECT) di bawah TIDAK PERLU diubah strukturnya.
 *
 * DEPENDENSI: modul1.gs, modul2.gs, modul3.gs (v5), modul4.gs (v3) harus
 * ada di project Apps Script yang SAMA.
 * ============================================================
 */

const CONFIG_MODUL5 = {
  KUMPULAN_PO_SHEET_URL: 'https://docs.google.com/spreadsheets/d/1gNvg9N0TUc9CCuIHyTty-2owoV8wTZAnKYCayQc6KHc/edit?usp=sharing', // <-- WAJIB DIISI
  KUMPULAN_PO_SHEET_NAME: 'KUMPULAN PO',
  OUTPUT_SHEET_NAME: 'DATA TRACKING',
  UNMATCHED_SHEET_NAME: 'UNMATCHED ITEMS',
  REJECT_SHEET_NAME: 'DATA REJECT',
  ON_PRODUCTION_SHEET_NAME: 'ON PRODUCTION',
  STATUS_CRITICAL_SHEET_NAME: 'STATUS STOCK', // [BARU v3] sheet ini sekarang 5 kolom: ITEM | KATEGORI | WARNA | LENGAN & SIZE | STATUS
  AUTO_REFRESH_INTERVAL_HOURS: 3,
  ESTIMASI_TIBA_TAMBAH_HARI: 7,
};

const BULAN_INDO_ = {
  'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MEI': 5, 'JUN': 6,
  'JUL': 7, 'AGU': 8, 'AGT': 8, 'SEP': 9, 'OKT': 10, 'NOV': 11, 'DES': 12
};

function normalisasiTahun_(yStr) {
  const n = parseInt(yStr, 10);
  if (isNaN(n)) return null;
  if (yStr.length <= 2) return 2000 + n;
  if (yStr.length === 4) return n;
  const last2 = parseInt(yStr.slice(-2), 10);
  return 2000 + last2;
}

function parseTanggalDariTeks_(teks) {
  if (!teks) return null;

  if (Object.prototype.toString.call(teks) === '[object Date]') {
    return isNaN(teks.getTime()) ? null : teks;
  }

  const t = String(teks);

  let m = t.match(/(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})\s*[\/\-\.]\s*(\d{2,4})/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = normalisasiTahun_(m[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year) {
      return new Date(year, month - 1, day);
    }
  }

  m = t.match(/(\d{1,2})[\s\-\.]*([A-Za-z]{3,9})[\s\-\.]*(\d{2,4})/);
  if (m) {
    const day = parseInt(m[1], 10);
    const bulanTeks = m[2].toUpperCase().substring(0, 3);
    const month = BULAN_INDO_[bulanTeks];
    const year = normalisasiTahun_(m[3]);
    if (day >= 1 && day <= 31 && month && year) {
      return new Date(year, month - 1, day);
    }
  }

  m = t.match(/(\d{1,2})[\s\-\.]*([A-Za-z]{3,9})(?!\d)/);
  if (m) {
    const day = parseInt(m[1], 10);
    const bulanTeks = m[2].toUpperCase().substring(0, 3);
    const month = BULAN_INDO_[bulanTeks];
    if (day >= 1 && day <= 31 && month) {
      return new Date(new Date().getFullYear(), month - 1, day);
    }
  }

  return null;
}

function formatTanggalDDMMYYYY_(date) {
  if (!date) return '';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return dd + '/' + mm + '/' + yyyy;
}

function tambahHari_(date, jumlahHari) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + jumlahHari);
  return d;
}

const KNOWN_COURIERS_ = [
  { words: ['SAMUDRA', 'PAKET'], canonical: 'SAMUDRA PAKET' },
  { words: ['WUS', 'CARGO'], canonical: 'WUS CARGO' },
  { words: ['JNE'], canonical: 'JNE' },
  { words: ['J&T'], canonical: 'J&T' },
  { words: ['JNT'], canonical: 'JNT' },
  { words: ['SICEPAT'], canonical: 'SICEPAT' },
  { words: ['ANTERAJA'], canonical: 'ANTERAJA' },
  { words: ['LION', 'PARCEL'], canonical: 'LION PARCEL' },
  { words: ['NINJA'], canonical: 'NINJA XPRESS' },
  { words: ['ID', 'EXPRESS'], canonical: 'ID EXPRESS' },
  { words: ['POS', 'INDONESIA'], canonical: 'POS INDONESIA' },
  { words: ['TIKI'], canonical: 'TIKI' },
  { words: ['WAHANA'], canonical: 'WAHANA' },
];

function extractResiDariTeks_(teksRaw) {
  if (!teksRaw) return '';
  if (Object.prototype.toString.call(teksRaw) === '[object Date]') return '';
  const teks = String(teksRaw);

  let m = teks.match(/AWB\s*[:\-]?\s*(\d+)/i);
  if (m) return 'AWB ' + m[1];

  m = teks.match(/STTB\s*[:\-]?\s*(\d+)/i);
  if (m) return 'STTB ' + m[1];

  m = teks.match(/STT\s*[:\-]?\s*(\d+)/i);
  if (m) return 'STT ' + m[1];

  const teksNorm = normalizeText_(teks);
  for (let i = 0; i < KNOWN_COURIERS_.length; i++) {
    const semuaKataAda = KNOWN_COURIERS_[i].words.every(function (w) { return teksNorm.indexOf(w) !== -1; });
    if (semuaKataAda) return KNOWN_COURIERS_[i].canonical;
  }

  return '';
}

/**
 * [BARU v3] Sheet STATUS STOCK sekarang 5 kolom: ITEM | KATEGORI | WARNA |
 * LENGAN & SIZE | STATUS. Nama item tetap di kolom A, STATUS sekarang di kolom E
 * (bukan lagi kolom B seperti sheet STATUS CRITICAL yang lama).
 */
function loadStatusStokMap_() {
  const map = new Map();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG_MODUL5.STATUS_CRITICAL_SHEET_NAME);
  if (!sheet) {
    Logger.log('  [INFO] Sheet "' + CONFIG_MODUL5.STATUS_CRITICAL_SHEET_NAME + '" tidak ditemukan -- kolom STATUS TOTAL STOK di DATA TRACKING akan dikosongkan.');
    return map;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;

  const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues(); // A:E -> ITEM..STATUS
  data.forEach(function (row) {
    const item = row[0];
    const status = row[4]; // kolom E = STATUS
    if (!item || String(item).trim() === '') return;
    map.set(normalizeText_(item), status ? String(status).trim() : '');
  });

  Logger.log('  STATUS STOCK: ' + map.size + ' ITEM dengan status stok terbaca.');
  return map;
}

/**
 * Deteksi apakah suatu nomor PO berpola "... REG" atau "... RIB" (pola GI).
 * @return {Object|null} { base, suffix } atau null kalau bukan pola ini.
 */
function detectGIRegRibSuffix_(nomorPO) {
  const norm = normalizeText_(nomorPO);
  const m = norm.match(/^(.*)\s+(REG|RIB)$/);
  if (!m) return null;
  return { base: m[1].trim(), suffix: m[2] };
}

/**
 * [BARU v3] Bangun daftar kandidat nomor PO untuk dicocokkan ke INTRANSIT
 * ATAU DASHBOARD (HPP), URUT SESUAI PRIORITAS: kalau PO ini bagian dari
 * pasangan GI REG/RIB, coba dulu versi GABUNGAN (base tanpa suffix -- karena
 * INTRANSIT biasanya mencatat REG+RIB sebagai SATU checklist bersama), baru
 * fallback ke nomor PO ASLINYA sendiri (kalau di INTRANSIT ternyata dicatat
 * terpisah per REG/RIB). PENTING: ini HANYA memengaruhi PENCARIAN status,
 * BUKAN mengubah nomor koli/data -- nomor koli REG dan RIB tetap dipakai
 * apa adanya, tidak pernah di-offset/digabung.
 */
function buildIntransitMatchCandidates_(nomorPO) {
  const info = detectGIRegRibSuffix_(nomorPO);
  if (info) {
    return [info.base, nomorPO]; // gabungan dulu, baru fallback terpisah
  }
  return [nomorPO];
}

function loadDaftarPO_() {
  const ss = SpreadsheetApp.openByUrl(CONFIG_MODUL5.KUMPULAN_PO_SHEET_URL);
  const sheet = findSheetByPartialName_(ss, CONFIG_MODUL5.KUMPULAN_PO_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + CONFIG_MODUL5.KUMPULAN_PO_SHEET_NAME + '" tidak ditemukan di file SUMBER PO 2026.');
  }

  const data = sheet.getDataRange().getValues();
  const daftar = [];
  let dilewati = 0;

  for (let r = 1; r < data.length; r++) {
    const nomorPO = data[r][0];
    const linkSheet = data[r][1];

    if (!nomorPO || !linkSheet || String(linkSheet).trim() === '') continue;

    const nomorPOText = String(nomorPO).trim();
    const linkText = String(linkSheet).trim();

    const nomorPONorm = normalizeText_(nomorPOText);
    if (nomorPONorm === 'PO' || nomorPONorm === 'NOMOR PO') {
      Logger.log('  [SKIP] Baris ' + (r + 1) + ' di KUMPULAN PO dilewati (kelihatan seperti header nyasar): "' + nomorPOText + '"');
      dilewati++;
      continue;
    }
    if (linkText.indexOf('https://docs.google.com/spreadsheets/') !== 0) {
      Logger.log('  [SKIP] Baris ' + (r + 1) + ' di KUMPULAN PO dilewati (link bukan URL Google Sheets yang valid): "' + linkText + '"');
      dilewati++;
      continue;
    }

    // [BARU v3] PO REG dan RIB TIDAK DIGABUNG lagi di sini -- masing-masing
    // tetap jadi 1 entri PO independen, diproses terpisah (lihat
    // buildIntransitMatchCandidates_ untuk bagian pencarian status-nya).
    daftar.push({ nomorPO: nomorPOText, linkSheet: linkText });
  }

  if (dilewati > 0) {
    Logger.log('Total baris dilewati dari KUMPULAN PO: ' + dilewati);
  }

  return daftar;
}

/**
 * Proses 1 PO secara lengkap: Report Harian + Surat Jalan New + Intransit + HPP.
 */
function prosesSatuPO_(nomorPO, linkSheet, masterData, intransitData, statusStokMap, hppData) {
  const rows = [];
  const unmatchedRows = [];
  const rejectRows = [];
  const rejectTrackingRows = [];
  const onProductionRows = [];

  const itemMap = new Map();

  let reportHarianData = [];
  try {
    reportHarianData = parseReportHarian_(linkSheet, masterData);
  } catch (e) {
    Logger.log('  [WARNING] Gagal baca REPORT HARIAN PO "' + nomorPO + '": ' + e.message);
  }

  let suratJalanData = { nomorPO: null, entries: [] };
  try {
    suratJalanData = parseSuratJalan_(linkSheet, masterData);
  } catch (e) {
    Logger.log('  [WARNING] Gagal baca SURAT JALAN NEW PO "' + nomorPO + '": ' + e.message);
  }

  reportHarianData.forEach(function (r) {
    if (!r.matched) {
      unmatchedRows.push({
        nomorPO: nomorPO,
        nomorKoli: '',
        itemName: r.itemRaw,
        qty: r.target,
        note: '[REPORT HARIAN] ' + (r.mapNote || 'gagal dipetakan ke Master Item Name')
      });
    }

    itemMap.set(r.item, {
      qtyPO: r.target,
      cutting: r.cutting,
      finishGood: r.finishGood,
      reject: r.reject,
      koliEntries: []
    });
  });

  // [BARU v3] Kandidat pencarian status: gabungan dulu (kalau pola GI REG/RIB), fallback sendiri.
  const candidates = buildIntransitMatchCandidates_(nomorPO);

  const koliStatus = getKoliStatusForPOCandidates_(intransitData, candidates);
  if (!koliStatus.found) {
    Logger.log('  [WARNING] PO "' + nomorPO + '" (dicoba kandidat: ' + candidates.join(' / ') + ') TIDAK ditemukan di INTRANSIT -- semua koli untuk PO ini dianggap ON_DELIVERY.');
  } else if (koliStatus.matchedUsing !== nomorPO) {
    Logger.log('  [INFO] PO "' + nomorPO + '" cocok ke INTRANSIT lewat kandidat GABUNGAN: "' + koliStatus.matchedUsing + '".');
  }

  // [SEDERHANA v3] Status HPP -- dicek SEKALI per PO, SELALU 'ADA HPP' / 'BELUM ADA HPP'.
  const hppStatus = hppData ? getHppStatusForPOCandidates_(hppData, candidates) : { found: false };
  const statusHppStr = hppStatus.found ? 'ADA HPP' : 'BELUM ADA HPP';
  if (hppData) {
    Logger.log('  [HPP] PO "' + nomorPO + '" -> ' + statusHppStr + (hppStatus.found ? ' (cocok lewat "' + hppStatus.matchedUsing + '")' : ''));
  }

  suratJalanData.entries.forEach(function (entry) {
    if (!entry.matched) {
      unmatchedRows.push({
        nomorPO: nomorPO,
        nomorKoli: entry.nomorKoli,
        itemName: entry.itemStandard,
        qty: entry.qty,
        note: entry.note
      });
      return;
    }

    if (entry.tipe === 'reject') {
      rejectRows.push({
        itemName: entry.itemStandard,
        nomorPO: nomorPO,
        nomorKoli: entry.nomorKoli,
        qtyReject: entry.qty
      });

      rejectTrackingRows.push({
        itemName: entry.itemStandard,
        nomorKoli: entry.nomorKoli + ' (REJECT)',
        qty: entry.qty,
        tglPengiriman: entry.tglPengiriman || '',
        resi: entry.resi
      });
      return;
    }

    if (!itemMap.has(entry.itemStandard)) {
      itemMap.set(entry.itemStandard, { qtyPO: 0, cutting: 0, finishGood: 0, reject: 0, koliEntries: [] });
    }

    const agg = itemMap.get(entry.itemStandard);
    const status = koliStatus.found ? classifyKoli_(koliStatus.koliStatusMap, entry.nomorKoli) : 'ON_DELIVERY';
    agg.koliEntries.push({
      koli: entry.nomorKoli,
      qty: entry.qty,
      status: status,
      tglPengiriman: entry.tglPengiriman,
      resi: entry.resi
    });
  });

  itemMap.forEach(function (agg, itemName) {
    let wipFinal = Math.max(0, agg.qtyPO - (agg.finishGood + agg.reject));

    if (agg.cutting > 0 && agg.cutting === (agg.finishGood + agg.reject)) {
      wipFinal = 0;
    }

    if (agg.qtyPO !== 0 || agg.finishGood !== 0 || agg.reject !== 0) {
      const koliList = agg.koliEntries.map(function (ce) { return ce.koli; });
      const koliUnik = koliList.filter(function (k, idx) { return koliList.indexOf(k) === idx; });
      onProductionRows.push({
        itemName: itemName,
        nomorPO: nomorPO,
        targetCutting: agg.qtyPO,
        cutting: agg.cutting,
        finishGood: agg.finishGood,
        reject: agg.reject,
        wip: wipFinal,
        koli: koliUnik.join(', ')
      });
    }

    const koliBelumSelesai = agg.koliEntries.filter(function (ce) { return ce.status !== 'TERFULFILL'; });

    if (koliBelumSelesai.length > 0) {
      koliBelumSelesai.forEach(function (ce) {
        const tglDeliveryDate = parseTanggalDariTeks_(ce.tglPengiriman);
        const tglDeliveryStr = tglDeliveryDate ? formatTanggalDDMMYYYY_(tglDeliveryDate) : '';
        const estimasiTibaStr = tglDeliveryDate ? formatTanggalDDMMYYYY_(tambahHari_(tglDeliveryDate, CONFIG_MODUL5.ESTIMASI_TIBA_TAMBAH_HARI)) : '';
        const resiStr = ce.resi || extractResiDariTeks_(ce.tglPengiriman);

        rows.push({
          itemName: itemName,
          nomorPO: nomorPO,
          nomorKoli: ce.koli,
          qtyPO: agg.qtyPO,
          wip: wipFinal,
          onDelivery: ce.status === 'ON_DELIVERY' ? ce.qty : 0,
          intransit: ce.status === 'INTRANSIT' ? ce.qty : 0,
          terfulfill: 0,
          tglPengiriman: ce.tglPengiriman || '',
          resi: resiStr,
          tglDelivery: tglDeliveryStr,
          estimasiTiba: estimasiTibaStr,
          statusStok: statusStokMap.get(normalizeText_(itemName)) || '',
          statusHpp: statusHppStr
        });
      });
    } else if (wipFinal !== 0) {
      rows.push({
        itemName: itemName,
        nomorPO: nomorPO,
        nomorKoli: '',
        qtyPO: agg.qtyPO,
        wip: wipFinal,
        onDelivery: 0,
        intransit: 0,
        terfulfill: 0,
        tglPengiriman: '',
        resi: '',
        tglDelivery: '',
        estimasiTiba: '',
        statusStok: statusStokMap.get(normalizeText_(itemName)) || '',
        statusHpp: statusHppStr
      });
    }
  });

  rejectTrackingRows.forEach(function (rtr) {
    const agg = itemMap.get(rtr.itemName);
    const tglDeliveryDate = parseTanggalDariTeks_(rtr.tglPengiriman);
    const tglDeliveryStr = tglDeliveryDate ? formatTanggalDDMMYYYY_(tglDeliveryDate) : '';
    const estimasiTibaStr = tglDeliveryDate ? formatTanggalDDMMYYYY_(tambahHari_(tglDeliveryDate, CONFIG_MODUL5.ESTIMASI_TIBA_TAMBAH_HARI)) : '';
    const resiStr = rtr.resi || extractResiDariTeks_(rtr.tglPengiriman);

    rows.push({
      itemName: rtr.itemName,
      nomorPO: nomorPO,
      nomorKoli: rtr.nomorKoli,
      qtyPO: agg ? agg.qtyPO : 0,
      wip: '',
      onDelivery: 0,
      intransit: 0,
      terfulfill: 0,
      tglPengiriman: rtr.tglPengiriman,
      resi: resiStr,
      tglDelivery: tglDeliveryStr,
      estimasiTiba: estimasiTibaStr,
      statusStok: statusStokMap.get(normalizeText_(rtr.itemName)) || '',
      statusHpp: statusHppStr
    });
  });

  return { rows: rows, unmatchedRows: unmatchedRows, rejectRows: rejectRows, onProductionRows: onProductionRows };
}

/**
 * ============================================================
 * FUNGSI UTAMA - jalankan ini untuk update seluruh data
 * ============================================================
 */
const PROP_KEY_PROGRESS_INDEX = 'DT_PROGRESS_INDEX';
const MAX_RUNTIME_MS = 5 * 60 * 1000;
const PROP_KEY_ERROR_POS = 'DT_ERROR_POS';

function updateDataTracking() {
  const startTime = new Date().getTime();
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const daftarPO = loadDaftarPO_();
  const savedIndex = Number(props.getProperty(PROP_KEY_PROGRESS_INDEX)) || 0;

  const isFirstBatch = (savedIndex === 0);
  Logger.log('=== ' + (isFirstBatch ? 'MULAI' : 'LANJUTKAN') + ' UPDATE DATA TRACKING ===');
  Logger.log('Total PO: ' + daftarPO.length + ' | Mulai dari index: ' + savedIndex);

  if (isFirstBatch) {
    tulisHeaderSaja_();
    props.deleteProperty(PROP_KEY_ERROR_POS);
    ss.toast('Memulai update data untuk ' + daftarPO.length + ' PO...', '🔄 Data Tracking', 5);
  } else {
    ss.toast('Melanjutkan update data dari PO ke-' + (savedIndex + 1) + '/' + daftarPO.length + '...', '🔄 Data Tracking', 5);
  }

  const masterData = loadItemMasterMap_();
  const intransitData = loadIntransitData_();
  const statusStokMap = loadStatusStokMap_();
  const hppData = loadHppStatusData_();
  Logger.log('Master Item Name: ' + masterData.exactMap.size + ' entri | INTRANSIT: ' + intransitData.length + ' PO | HPP (DASHBOARD): ' + hppData.length + ' PO');

  const errorPOs = JSON.parse(props.getProperty(PROP_KEY_ERROR_POS) || '[]');

  let idx = savedIndex;
  let toastCounter = 0;

  for (; idx < daftarPO.length; idx++) {
    const po = daftarPO[idx];
    Logger.log('[' + (idx + 1) + '/' + daftarPO.length + '] Proses PO: ' + po.nomorPO);

    const poStartTime = new Date().getTime();
    try {
      const hasil = prosesSatuPO_(po.nomorPO, po.linkSheet, masterData, intransitData, statusStokMap, hppData);
      appendKeSheetOutput_(hasil.rows);
      appendKeSheetUnmatched_(hasil.unmatchedRows);
      appendKeSheetReject_(hasil.rejectRows);
      appendKeSheetOnProduction_(hasil.onProductionRows);
    } catch (e) {
      Logger.log('  [ERROR] Gagal total proses PO "' + po.nomorPO + '": ' + e.message);
      errorPOs.push({ po: po.nomorPO, error: e.message });
      ss.toast('PO "' + po.nomorPO + '" GAGAL diproses: ' + e.message, '❌ PO Bermasalah', 8);
    }

    const durasiPO = (new Date().getTime() - poStartTime) / 1000;
    if (durasiPO > 15) {
      ss.toast('PO "' + po.nomorPO + '" makan waktu ' + durasiPO.toFixed(1) + ' detik (lebih lambat dari biasanya)', '🐢 PO Lambat', 6);
    }

    toastCounter++;
    if (toastCounter % 10 === 0) {
      ss.toast('Progres: ' + (idx + 1) + '/' + daftarPO.length + ' PO selesai diproses...', '🔄 Data Tracking', 4);
    }

    const elapsed = new Date().getTime() - startTime;
    if (elapsed > MAX_RUNTIME_MS) {
      props.setProperty(PROP_KEY_PROGRESS_INDEX, String(idx + 1));
      props.setProperty(PROP_KEY_ERROR_POS, JSON.stringify(errorPOs));
      Logger.log('=== BERHENTI SEMENTARA (mendekati limit waktu) di PO ke-' + (idx + 1) + '/' + daftarPO.length + ' ===');
      ss.toast('Waktu mepet, lanjut otomatis 10 detik lagi... (' + (idx + 1) + '/' + daftarPO.length + ')', '⏸️ Jeda Sementara', 8);
      pasangTriggerLanjutan_();
      return;
    }
  }

  props.deleteProperty(PROP_KEY_PROGRESS_INDEX);
  props.deleteProperty(PROP_KEY_ERROR_POS);
  hapusTriggerLanjutan_();
  Logger.log('=== SELESAI SEMUA: ' + daftarPO.length + ' PO diproses, ' + errorPOs.length + ' PO error total ===');

  if (errorPOs.length > 0) {
    const daftarNamaPO = errorPOs.map(function (e) { return e.po; }).join(', ');
    Logger.log('Daftar PO yang gagal total: ' + JSON.stringify(errorPOs));
    ss.toast('Selesai dengan ' + errorPOs.length + ' PO GAGAL: ' + daftarNamaPO, '⚠️ Update Selesai (Ada Masalah)', 15);
  } else {
    ss.toast('Semua ' + daftarPO.length + ' PO berhasil diproses tanpa error!', '✅ Update Selesai', 10);
  }
}

const PROP_KEY_CONTINUATION_TRIGGER_ID = 'DT_CONTINUATION_TRIGGER_ID';

function pasangTriggerLanjutan_() {
  hapusTriggerLanjutan_();
  const trigger = ScriptApp.newTrigger('updateDataTracking')
    .timeBased()
    .after(10 * 1000)
    .create();
  PropertiesService.getScriptProperties().setProperty(PROP_KEY_CONTINUATION_TRIGGER_ID, trigger.getUniqueId());
}

function hapusTriggerLanjutan_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(PROP_KEY_CONTINUATION_TRIGGER_ID);
  if (!savedId) return;

  const allTriggers = ScriptApp.getProjectTriggers();
  allTriggers.forEach(function (t) {
    if (t.getUniqueId() === savedId) {
      ScriptApp.deleteTrigger(t);
    }
  });
  props.deleteProperty(PROP_KEY_CONTINUATION_TRIGGER_ID);
}

function tulisHeaderSaja_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const setup = function (sheetName, header, headerColor) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }
    sheet.clear();
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground(headerColor);
    sheet.setFrozenRows(1);
  };

  setup(CONFIG_MODUL5.OUTPUT_SHEET_NAME, ['ITEM NAME', 'NOMOR PO', 'NOMOR KOLI', 'QTY PO', 'WIP', 'ON DELIVERY', 'INTRANSIT', 'TERFULFILL', 'TANGGAL DAN JAM PENGIRIMAN', 'RESI', 'TANGGAL DELIVERY', 'ESTIMASI TIBA', 'STATUS TOTAL STOK', 'STATUS HPP'], '#FFFF00');
  setup(CONFIG_MODUL5.UNMATCHED_SHEET_NAME, ['NOMOR PO', 'NOMOR KOLI', 'ITEM (gagal mapping)', 'QTY', 'CATATAN'], '#FF9999');
  setup(CONFIG_MODUL5.REJECT_SHEET_NAME, ['ITEM NAME', 'NOMOR PO', 'NOMOR KOLI', 'QTY REJECT'], '#FFCC99');
  setup(CONFIG_MODUL5.ON_PRODUCTION_SHEET_NAME, ['ITEM', 'NOMOR PO', 'TARGET CUTTING', 'CUTTING', 'FINISH GOOD', 'REJECT', 'WIP', 'KOLI'], '#C9DAF8');

  Logger.log('Header sheet DATA TRACKING / UNMATCHED ITEMS / DATA REJECT / ON PRODUCTION sudah disiapkan.');
}

function appendKeSheetOutput_(rows) {
  if (rows.length === 0) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG_MODUL5.OUTPUT_SHEET_NAME);

  const dataToWrite = rows.map(function (r) {
    return [r.itemName, r.nomorPO, r.nomorKoli, r.qtyPO, r.wip, r.onDelivery, r.intransit, r.terfulfill, r.tglPengiriman, r.resi || '', r.tglDelivery || '', r.estimasiTiba || '', r.statusStok || '', r.statusHpp || ''];
  });

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, dataToWrite.length, dataToWrite[0].length).setValues(dataToWrite);
}

function appendKeSheetOnProduction_(onProductionRows) {
  if (onProductionRows.length === 0) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG_MODUL5.ON_PRODUCTION_SHEET_NAME);

  const dataToWrite = onProductionRows.map(function (r) {
    return [r.itemName, r.nomorPO, r.targetCutting, r.cutting, r.finishGood, r.reject, r.wip, r.koli];
  });

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, dataToWrite.length, dataToWrite[0].length).setValues(dataToWrite);
}

function appendKeSheetUnmatched_(unmatchedRows) {
  if (unmatchedRows.length === 0) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG_MODUL5.UNMATCHED_SHEET_NAME);

  const dataToWrite = unmatchedRows.map(function (r) {
    return [r.nomorPO, r.nomorKoli, r.itemName, r.qty, r.note];
  });

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, dataToWrite.length, dataToWrite[0].length).setValues(dataToWrite);
}

function appendKeSheetReject_(rejectRows) {
  if (rejectRows.length === 0) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG_MODUL5.REJECT_SHEET_NAME);

  const dataToWrite = rejectRows.map(function (r) {
    return [r.itemName, r.nomorPO, r.nomorKoli, r.qtyReject];
  });

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, dataToWrite.length, dataToWrite[0].length).setValues(dataToWrite);
}

/**
 * ============================================================
 * AUTO-UPDATE DARI STATUS CRITICAL
 * ============================================================
 */
function onEdit(e) {
  const sheetName = e.source.getActiveSheet().getName();
  if (sheetName !== CONFIG_MODUL5.STATUS_CRITICAL_SHEET_NAME) return;

  Logger.log('Sheet "' + CONFIG_MODUL5.STATUS_CRITICAL_SHEET_NAME + '" berubah, akan update DATA TRACKING dalam 10 detik...');

  const props = PropertiesService.getScriptProperties();
  props.setProperty('NEED_UPDATE_FROM_CRITICAL', 'true');

  const allTriggers = ScriptApp.getProjectTriggers();
  allTriggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'backgroundUpdateFromCritical') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('backgroundUpdateFromCritical')
    .timeBased()
    .after(10 * 1000)
    .create();
}

function backgroundUpdateFromCritical() {
  const props = PropertiesService.getScriptProperties();
  const needUpdate = props.getProperty('NEED_UPDATE_FROM_CRITICAL');

  if (needUpdate !== 'true') return;

  try {
    Logger.log('=== BACKGROUND UPDATE DARI STATUS CRITICAL (triggered oleh onEdit) ===');
    updateDataTracking();
    props.deleteProperty('NEED_UPDATE_FROM_CRITICAL');
    Logger.log('=== Background update dari STATUS CRITICAL selesai ===');
  } catch (e) {
    Logger.log('[ERROR] Background update gagal: ' + e.message);
    props.deleteProperty('NEED_UPDATE_FROM_CRITICAL');
  }
}

/**
 * ============================================================
 * MENU & TRIGGER
 * ============================================================
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔄 Data Tracking')
    .addItem('Update Data Sekarang (Semua PO)', 'updateDataTracking')
    .addItem('Update PO Tertentu Saja (Cepat)', 'updateSatuPOInteraktif')
    .addSeparator()
    .addItem('Isi Link dari Judul PO (Kolom A)', 'isiLinkDariJudulPO')
    .addToUi();
}

function updateSatuPOInteraktif() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt(
    'Update PO Tertentu',
    'Masukkan Nomor PO yang mau di-refresh (harus sama persis / mirip dengan yang ada di KUMPULAN PO):',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const nomorPOInput = resp.getResponseText().trim();
  if (!nomorPOInput) {
    ui.alert('Nomor PO tidak boleh kosong.');
    return;
  }

  updateSatuPO_(nomorPOInput);
}

function updateSatuPO_(nomorPOTarget) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Mencari PO "' + nomorPOTarget + '" di KUMPULAN PO...', '🔄 Update PO Tertentu', 5);

  const daftarPO = loadDaftarPO_();
  const targetNorm = normalizeText_(nomorPOTarget);
  const po = daftarPO.find(function (p) { return normalizeText_(p.nomorPO).indexOf(targetNorm) !== -1 || targetNorm.indexOf(normalizeText_(p.nomorPO)) !== -1; });

  if (!po) {
    SpreadsheetApp.getUi().alert('PO "' + nomorPOTarget + '" tidak ditemukan di KUMPULAN PO. Cek lagi penulisannya.');
    return;
  }

  ss.toast('Memproses PO: ' + po.nomorPO + '...', '🔄 Update PO Tertentu', 15);

  const masterData = loadItemMasterMap_();
  const intransitData = loadIntransitData_();
  const statusStokMap = loadStatusStokMap_();
  const hppData = loadHppStatusData_();

  let hasil;
  try {
    hasil = prosesSatuPO_(po.nomorPO, po.linkSheet, masterData, intransitData, statusStokMap, hppData);
  } catch (e) {
    ss.toast('GAGAL memproses PO "' + po.nomorPO + '": ' + e.message, '❌ Error', 10);
    SpreadsheetApp.getUi().alert('Gagal memproses PO "' + po.nomorPO + '":\n' + e.message);
    return;
  }

  hapusBarisUntukPO_(CONFIG_MODUL5.OUTPUT_SHEET_NAME, 2, po.nomorPO);
  hapusBarisUntukPO_(CONFIG_MODUL5.UNMATCHED_SHEET_NAME, 1, po.nomorPO);
  hapusBarisUntukPO_(CONFIG_MODUL5.REJECT_SHEET_NAME, 2, po.nomorPO);
  hapusBarisUntukPO_(CONFIG_MODUL5.ON_PRODUCTION_SHEET_NAME, 2, po.nomorPO);

  appendKeSheetOutput_(hasil.rows);
  appendKeSheetUnmatched_(hasil.unmatchedRows);
  appendKeSheetReject_(hasil.rejectRows);
  appendKeSheetOnProduction_(hasil.onProductionRows);

  ss.toast('Selesai! PO "' + po.nomorPO + '" sudah di-update (' + hasil.rows.length + ' baris).', '✅ Update PO Tertentu', 8);
  SpreadsheetApp.getUi().alert('Selesai!\n\nPO: ' + po.nomorPO + '\n' + hasil.rows.length + ' baris DATA TRACKING\n' + hasil.unmatchedRows.length + ' item gagal mapping\n' + hasil.rejectRows.length + ' baris reject');
}

function hapusBarisUntukPO_(sheetName, poColIndex, nomorPO) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const values = sheet.getRange(2, poColIndex, lastRow - 1, 1).getValues();
  const targetNorm = normalizeText_(nomorPO);

  for (let i = values.length - 1; i >= 0; i--) {
    if (normalizeText_(String(values[i][0])) === targetNorm) {
      sheet.deleteRow(2 + i);
    }
  }
}

function isiLinkDariJudulPO() {
  const ss = SpreadsheetApp.openByUrl(CONFIG_MODUL5.KUMPULAN_PO_SHEET_URL);
  const sheet = findSheetByPartialName_(ss, CONFIG_MODUL5.KUMPULAN_PO_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + CONFIG_MODUL5.KUMPULAN_PO_SHEET_NAME + '" tidak ditemukan.');
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('Tidak ada baris data (selain header).');
    return;
  }

  const colACells = sheet.getRange(2, 1, lastRow - 1, 1);
  const richTextValues = colACells.getRichTextValues();
  const currentColB = sheet.getRange(2, 2, lastRow - 1, 1).getValues();

  let terisi = 0;
  let dilewatiSudahAda = 0;
  let tidakAdaLink = 0;

  for (let i = 0; i < richTextValues.length; i++) {
    const rowNum = 2 + i;
    const sudahAdaIsi = currentColB[i][0] && String(currentColB[i][0]).trim() !== '';
    if (sudahAdaIsi) {
      dilewatiSudahAda++;
      continue;
    }

    const rt = richTextValues[i][0];
    if (!rt) { tidakAdaLink++; continue; }

    let linkUrl = rt.getLinkUrl();

    if (!linkUrl) {
      const runs = rt.getRuns();
      for (let j = 0; j < runs.length; j++) {
        const url = runs[j].getLinkUrl();
        if (url) { linkUrl = url; break; }
      }
    }

    if (linkUrl) {
      sheet.getRange(rowNum, 2).setValue(linkUrl);
      terisi++;
    } else {
      tidakAdaLink++;
    }
  }

  Logger.log('Isi Link dari Judul PO selesai: ' + terisi + ' terisi, ' + dilewatiSudahAda + ' dilewati (kolom B sudah ada isi), ' + tidakAdaLink + ' tidak punya link sama sekali di kolom A.');

  try {
    SpreadsheetApp.getUi().alert('Selesai!\n\n' + terisi + ' link berhasil diisi.\n' + dilewatiSudahAda + ' dilewati (sudah ada isi).\n' + tidakAdaLink + ' tidak punya link di kolom A.');
  } catch (e) {
    // Dijalankan dari editor Apps Script (bukan dari UI Sheet) -- abaikan
  }
}

function resetTotalProgress() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_KEY_PROGRESS_INDEX);
  hapusTriggerLanjutan_();
  Logger.log('Progres direset total. Jalankan updateDataTracking() lagi untuk mulai dari awal bersih.');
}

function installTimeTrigger() {
  const allTriggers = ScriptApp.getProjectTriggers();
  allTriggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'updateDataTracking') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('updateDataTracking')
    .timeBased()
    .everyHours(CONFIG_MODUL5.AUTO_REFRESH_INTERVAL_HOURS)
    .create();

  Logger.log('Trigger otomatis terpasang: updateDataTracking() akan jalan tiap ' + CONFIG_MODUL5.AUTO_REFRESH_INTERVAL_HOURS + ' jam.');
}

/**
 * ============================================================
 * FUNGSI TES -- buildIntransitMatchCandidates_
 * ============================================================
 */
function testBuildIntransitMatchCandidates() {
  const contoh = [
    'GI25-08JULI2026-02 RIB',
    'GI25-08JULI2026-02 REG',
    'BY25-08JULI2026',
    'CP23-24JUNI2026-REG',
  ];
  contoh.forEach(function (po) {
    Logger.log('PO "' + po + '" -> kandidat: ' + JSON.stringify(buildIntransitMatchCandidates_(po)));
  });
}