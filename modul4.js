/**
 * ============================================================
 * MODUL 4 - INTRANSIT / TERFULFILL MATCHER (modul4 - intransitmatcher)
 * ============================================================
 * [VERSI v3 -- STATUS HPP DISEDERHANAKAN + DUKUNGAN NOMOR KOLI TEKS BEBAS]
 *
 * PERUBAHAN vs v2:
 * 1. [SEDERHANA] STATUS HPP sekarang HANYA berdasarkan "apakah nomor PO ini
 *    TERTULIS sebagai baris di sheet DASHBOARD (file INBOUND)" -- apapun isi
 *    kolom lain di baris itu (termasuk LINK HPP) TIDAK DICEK lagi. PO ada
 *    baris -> ADA HPP. PO tidak ketemu sama sekali -> BELUM ADA HPP. Semua
 *    logic lama (LINK HPP column, fallback tebak pola tulisan nomor PO
 *    "lengkap/belum lengkap") DIHAPUS -- terlalu rumit & tidak dibutuhkan.
 * 2. [BARU] extractKoliNumber_() -- nomor koli dari SURAT JALAN NEW sekarang
 *    bisa berupa TEKS BEBAS (mis. "KOLI 1", bukan cuma angka polos). Supaya
 *    tetap bisa dicocokkan ke checklist INTRANSIT (yang formatnya angka
 *    polos + checkbox), diambil angka PERTAMA yang muncul di teks tsb.
 *    classifyKoli_() dipakai lewat fungsi ini sebelum di-Number()-kan.
 * 3. [HAPUS] groupGIRegRibPairs_ (dan seluruh logic gabung PO REG+RIB jadi
 *    1 entri PO) DIPINDAH KONSEPNYA ke Modul 5 -- PO REG dan RIB TETAP
 *    dicatat terpisah (nomor koli masing-masing dipakai apa adanya, TIDAK
 *    di-offset), tapi saat CEK STATUS ke INTRANSIT/DASHBOARD, dicoba 2
 *    kandidat: nama PO GABUNGAN dulu (base tanpa suffix REG/RIB -- karena
 *    di sheet INTRANSIT biasanya REG+RIB dicatat sebagai SATU checklist),
 *    baru fallback ke nama PO ASLINYA sendiri (kalau ternyata di INTRANSIT
 *    dicatat terpisah). Helper buildIntransitMatchCandidates_() ada di
 *    Modul 5 (dipakai juga untuk pencarian status HPP di modul ini).
 *
 * Fungsi: baca sheet "INTRANSIT" di file INBOUND, cocokkan status checklist
 * (TRUE/FALSE) tiap nomor koli ke data SURAT JALAN NEW (dari Modul 3), untuk
 * menentukan TERFULFILL / INTRANSIT / ON_DELIVERY. Juga baca sheet
 * "DASHBOARD" untuk status HPP per PO.
 * ============================================================
 */

const CONFIG_MODUL4 = {
  INBOUND_SHEET_URL: 'https://docs.google.com/spreadsheets/d/1ECm_ihqnF3YSeb2S_7JUiOROeQ9r5QIZUzrry_PEnjM/edit?usp=sharing', // <-- WAJIB DIISI
  INTRANSIT_SHEET_NAME: 'INTRANSIT', // dicari pakai "mengandung"
  NOMOR_PO_HEADER_TEXT: 'NOMOR PO',
  MAX_KOLI_NUMBER: 9999, // batas wajar nomor koli, buat filter angka yang BUKAN nomor koli
};

/**
 * [BARU v3] Ambil angka PERTAMA dari sebuah teks nomor koli (mis. "KOLI 12"
 * -> 12, "5" -> 5, "No.3/A" -> 3). Return null kalau tidak ada angka sama
 * sekali di dalamnya.
 */
function extractKoliNumber_(text) {
  if (text === null || text === undefined) return null;
  const m = String(text).match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return isNaN(n) ? null : n;
}

/**
 * Cari baris & kolom header sheet INTRANSIT: kolom NOMOR PO, VENDOR, JUMLAH KOLI.
 * scanStartCol selalu mulai TEPAT setelah kolom NOMOR PO -- filter datanya
 * sendiri (lihat parseKoliStatusInBlock_) yang menentukan valid/tidak, jadi
 * tidak butuh batas kolom manual yang rapuh.
 */
function detectIntransitHeader_(dataValues) {
  const poCells = findCellsByText_(dataValues, CONFIG_MODUL4.NOMOR_PO_HEADER_TEXT);
  if (poCells.length === 0) {
    throw new Error('Header "NOMOR PO" tidak ditemukan di sheet INTRANSIT.');
  }
  const headerRow = poCells[0].row;
  const nomorPOCol = poCells[0].col;
  const rowValues = dataValues[headerRow - 1];

  let vendorCol = null, jumlahKoliCol = null, shippingCol = null;

  for (let c = 0; c < rowValues.length; c++) {
    const text = normalizeText_(rowValues[c]);
    if (!text) continue;
    if (text === 'VENDOR') vendorCol = c + 1;
    if (text.indexOf('KOLI') !== -1) jumlahKoliCol = c + 1;
    if (text.indexOf('SHIPPING') !== -1) shippingCol = c + 1;
  }

  const scanStartCol = nomorPOCol + 1;

  return { headerRow, nomorPOCol, vendorCol, jumlahKoliCol, shippingCol, scanStartCol };
}

function isValidKoliNumber_(value) {
  let num;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string') {
    const t = value.trim();
    if (t === '' || isNaN(Number(t))) return false;
    num = Number(t);
  } else {
    return false;
  }
  if (!Number.isInteger(num)) return false;
  if (num <= 0 || num > CONFIG_MODUL4.MAX_KOLI_NUMBER) return false;
  return true;
}

function isBooleanValue_(value) {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') {
    const t = value.trim().toUpperCase();
    return t === 'TRUE' || t === 'FALSE';
  }
  return false;
}

function toBooleanValue_(value) {
  if (typeof value === 'boolean') return value;
  return String(value).trim().toUpperCase() === 'TRUE';
}

/**
 * Parse SATU blok PO (rentang baris tertentu) untuk menemukan semua pasangan
 * (nomor koli -> status TRUE/FALSE): baris berisi ANGKA (koli), baris TEPAT
 * DI BAWAHNYA berisi BOOLEAN (checkbox), di kolom yang sama.
 */
function parseKoliStatusInBlock_(dataValues, startRow0, endRow0, scanStartCol1) {
  const koliStatusMap = new Map();
  const scanStartCol0 = scanStartCol1 - 1;

  for (let r = startRow0; r < endRow0; r++) {
    const row = dataValues[r];
    const rowBelow = dataValues[r + 1];
    if (!row || !rowBelow) continue;

    for (let c = scanStartCol0; c < row.length; c++) {
      const koliVal = row[c];
      const statusVal = rowBelow[c];

      if (isValidKoliNumber_(koliVal) && isBooleanValue_(statusVal)) {
        const koliKey = Number(koliVal);
        const statusBool = toBooleanValue_(statusVal);
        const existing = koliStatusMap.get(koliKey);
        if (existing === undefined || statusBool === true) {
          koliStatusMap.set(koliKey, statusBool);
        }
      }
    }
  }

  return koliStatusMap;
}

/**
 * Hapus penanda "Part" dari nomor PO (mis. "Part 1", "P.1", "P1").
 */
function normalizePOForGrouping_(poRaw) {
  let normalized = normalizeText_(poRaw);
  normalized = normalized.replace(/\s*(PART|PT|P)\.?\s*\d+\s*$/i, '');
  normalized = normalized.replace(/[\s\-]+$/, '');
  return normalized.trim();
}

function stripNonAlnum_(text) {
  return normalizeText_(text).replace(/[^A-Z0-9]/g, '');
}

/**
 * Load seluruh data INTRANSIT dari file INBOUND.
 */
function loadIntransitData_() {
  const ss = SpreadsheetApp.openByUrl(CONFIG_MODUL4.INBOUND_SHEET_URL);
  const sheet = findSheetByPartialName_(ss, CONFIG_MODUL4.INTRANSIT_SHEET_NAME);
  if (!sheet) {
    throw new Error('Tidak ada sheet yang namanya mengandung "' + CONFIG_MODUL4.INTRANSIT_SHEET_NAME + '".');
  }

  const dataValues = sheet.getDataRange().getValues();
  const header = detectIntransitHeader_(dataValues);

  Logger.log('Sheet INTRANSIT ditemukan: "' + sheet.getName() + '"');
  Logger.log('Header -> NOMOR PO col ' + header.nomorPOCol + ', VENDOR col ' + header.vendorCol + ', scan data mulai kolom ' + header.scanStartCol);

  const poStartRows = [];
  for (let r = header.headerRow; r < dataValues.length; r++) {
    const poVal = dataValues[r][header.nomorPOCol - 1];
    if (poVal && String(poVal).trim() !== '') {
      poStartRows.push(r);
    }
  }

  const groupedMap = new Map();

  for (let i = 0; i < poStartRows.length; i++) {
    const startRow0 = poStartRows[i];
    const endRow0 = (i + 1 < poStartRows.length) ? poStartRows[i + 1] : dataValues.length;

    const nomorPORawAsli = String(dataValues[startRow0][header.nomorPOCol - 1]).trim();
    const normalizedPO = normalizePOForGrouping_(nomorPORawAsli);
    const matchKey = stripNonAlnum_(normalizedPO);
    const vendor = header.vendorCol ? dataValues[startRow0][header.vendorCol - 1] : '';
    const jumlahKoli = header.jumlahKoliCol ? dataValues[startRow0][header.jumlahKoliCol - 1] : '';

    const blockKoliStatusMap = parseKoliStatusInBlock_(dataValues, startRow0, endRow0, header.scanStartCol);

    if (!groupedMap.has(matchKey)) {
      groupedMap.set(matchKey, {
        vendor: vendor,
        nomorPORaw: normalizedPO,
        matchKey: matchKey,
        jumlahKoli: jumlahKoli,
        koliStatusMap: new Map(),
        rawNamesFound: []
      });
    }

    const group = groupedMap.get(matchKey);
    group.rawNamesFound.push(nomorPORawAsli);

    blockKoliStatusMap.forEach(function (status, koli) {
      const existing = group.koliStatusMap.get(koli);
      if (existing === undefined || status === true) {
        group.koliStatusMap.set(koli, status);
      }
    });
  }

  const result = Array.from(groupedMap.values());

  result.forEach(function (r) {
    if (r.rawNamesFound.length > 1) {
      Logger.log('  [GABUNG PART] "' + r.nomorPORaw + '" <- digabung dari: ' + r.rawNamesFound.map(function (n) { return '"' + n + '"'; }).join(', ') + ' (total koli dengan status: ' + r.koliStatusMap.size + ')');
    }
    if (r.koliStatusMap.size === 0) {
      Logger.log('  [PERHATIAN] PO "' + r.nomorPORaw + '" ketemu di INTRANSIT tapi 0 koli+checkbox berhasil dibaca -- cek manual blok barisnya.');
    }
  });

  return result;
}

/**
 * Cari entry PO di data INTRANSIT yang PALING COCOK dengan nomor PO
 * (pencocokan prefix dua arah, ambil overlap terpanjang).
 */
function findBestMatchingPO_(intransitData, fullPOCode) {
  const target = stripNonAlnum_(fullPOCode);
  if (!target) return null;

  let bestMatch = null;
  let bestLength = -1;

  for (let i = 0; i < intransitData.length; i++) {
    const candidate = intransitData[i].matchKey;
    if (!candidate) continue;

    const isPrefixForward = target.indexOf(candidate) === 0;
    const isPrefixBackward = !isPrefixForward && candidate.indexOf(target) === 0;

    if (isPrefixForward || isPrefixBackward) {
      const overlapLength = Math.min(candidate.length, target.length);
      if (overlapLength > bestLength) {
        bestLength = overlapLength;
        bestMatch = intransitData[i];
      }
    }
  }

  return bestMatch;
}

/**
 * [PENTING] candidatePOs dicoba BERURUTAN sesuai urutan array-nya, berhenti
 * di kandidat PERTAMA yang ketemu. Modul 5 yang menentukan urutan prioritas
 * lewat buildIntransitMatchCandidates_() (gabungan GI REG+RIB dicoba dulu,
 * baru fallback ke nomor PO aslinya sendiri).
 */
function getKoliStatusForPOCandidates_(intransitData, candidatePOs) {
  const uniqueCandidates = (candidatePOs || [])
    .map(function (c) { return c ? String(c).trim() : ''; })
    .filter(function (c) { return c !== ''; })
    .filter(function (c, idx, arr) { return arr.indexOf(c) === idx; });

  for (let i = 0; i < uniqueCandidates.length; i++) {
    const match = findBestMatchingPO_(intransitData, uniqueCandidates[i]);
    if (match) {
      return {
        found: true,
        koliStatusMap: match.koliStatusMap,
        vendor: match.vendor,
        jumlahKoli: match.jumlahKoli,
        matchedUsing: uniqueCandidates[i]
      };
    }
  }

  return { found: false, koliStatusMap: new Map(), vendor: '', jumlahKoli: '', matchedUsing: null };
}

/**
 * Klasifikasikan 1 nomor koli (TEKS BEBAS, mis. "KOLI 3") jadi 3 kategori:
 * - TERFULFILL   : angka koli ketemu di INTRANSIT, checkbox TRUE
 * - INTRANSIT    : angka koli ketemu di INTRANSIT, checkbox FALSE
 * - ON_DELIVERY  : angka koli TIDAK ADA SAMA SEKALI di data INTRANSIT
 *                  (termasuk kalau teksnya sama sekali tidak mengandung angka)
 */
function classifyKoli_(koliStatusMap, nomorKoli) {
  const koliNum = extractKoliNumber_(nomorKoli);
  if (koliNum === null || !koliStatusMap.has(koliNum)) return 'ON_DELIVERY';
  const status = koliStatusMap.get(koliNum);
  return status === true ? 'TERFULFILL' : 'INTRANSIT';
}

/**
 * ============================================================
 * STATUS HPP -- DISEDERHANAKAN (v3): CUKUP "ADA BARISNYA" DI SHEET DASHBOARD
 * ============================================================
 */

const CONFIG_MODUL4_HPP = {
  DASHBOARD_SHEET_NAME: 'DASHBOARD',
  NOMOR_PO_HEADER_TEXT: 'NOMOR PO',
};

/**
 * [SEDERHANA v3] Load daftar nomor PO yang TERTULIS di sheet DASHBOARD (file
 * INBOUND) -- apapun isi kolom lainnya TIDAK dicek. Kehadiran baris = cukup.
 */
function loadHppStatusData_() {
  const ss = SpreadsheetApp.openByUrl(CONFIG_MODUL4.INBOUND_SHEET_URL);
  const sheet = findSheetByPartialName_(ss, CONFIG_MODUL4_HPP.DASHBOARD_SHEET_NAME);
  if (!sheet) {
    Logger.log('  [INFO HPP] Sheet "' + CONFIG_MODUL4_HPP.DASHBOARD_SHEET_NAME + '" tidak ditemukan -- STATUS HPP akan "BELUM ADA HPP" untuk semua PO.');
    return [];
  }

  const dataValues = sheet.getDataRange().getValues();
  const poCells = findCellsByText_(dataValues, CONFIG_MODUL4_HPP.NOMOR_PO_HEADER_TEXT);
  if (poCells.length === 0) {
    Logger.log('  [WARNING HPP] Header "NOMOR PO" tidak ditemukan di sheet DASHBOARD.');
    return [];
  }
  const headerRow = poCells[0].row;
  const nomorPOCol = poCells[0].col;

  const result = [];
  for (let r = headerRow; r < dataValues.length; r++) {
    const nomorPORaw = dataValues[r][nomorPOCol - 1];
    if (!nomorPORaw || String(nomorPORaw).trim() === '') continue;
    const nomorPOText = String(nomorPORaw).trim();

    result.push({
      matchKey: stripNonAlnum_(normalizePOForGrouping_(nomorPOText)),
      nomorPORaw: nomorPOText,
    });
  }

  Logger.log('  Sheet DASHBOARD (HPP): ' + result.length + ' baris PO terbaca (dianggap ADA HPP).');
  return result;
}

/**
 * [SEDERHANA v3] found=true kalau salah satu kandidat PO cocok ke daftar PO
 * di DASHBOARD -> berarti ADA HPP. found=false -> BELUM ADA HPP. Kandidat
 * dicoba berurutan (lihat buildIntransitMatchCandidates_ di Modul 5).
 */
function getHppStatusForPOCandidates_(hppData, candidatePOs) {
  const uniqueCandidates = (candidatePOs || [])
    .map(function (c) { return c ? String(c).trim() : ''; })
    .filter(function (c) { return c !== ''; })
    .filter(function (c, idx, arr) { return arr.indexOf(c) === idx; });

  for (let i = 0; i < uniqueCandidates.length; i++) {
    const target = stripNonAlnum_(uniqueCandidates[i]);
    if (!target) continue;

    let bestMatch = null;
    let bestLength = -1;
    for (let j = 0; j < hppData.length; j++) {
      const candidate = hppData[j].matchKey;
      if (!candidate) continue;
      const isPrefixForward = target.indexOf(candidate) === 0;
      const isPrefixBackward = !isPrefixForward && candidate.indexOf(target) === 0;
      if (isPrefixForward || isPrefixBackward) {
        const overlapLength = Math.min(candidate.length, target.length);
        if (overlapLength > bestLength) {
          bestLength = overlapLength;
          bestMatch = hppData[j];
        }
      }
    }
    if (bestMatch) {
      return { found: true, matchedUsing: uniqueCandidates[i] };
    }
  }
  return { found: false, matchedUsing: null };
}

/**
 * ============================================================
 * FUNGSI DEBUG -- CEK 1 PO SPESIFIK
 * ============================================================
 */
function debugCekStatusUntukPO(nomorPOUntukDicek, nomorPOAlternatif) {
  const intransitData = loadIntransitData_();
  const hppData = loadHppStatusData_();

  const kandidat = [nomorPOUntukDicek];
  if (nomorPOAlternatif) kandidat.push(nomorPOAlternatif);

  Logger.log('=== CEK INTRANSIT untuk kandidat: ' + JSON.stringify(kandidat) + ' ===');
  const hasil = getKoliStatusForPOCandidates_(intransitData, kandidat);
  Logger.log('Ditemukan di sheet INTRANSIT: ' + hasil.found);
  if (hasil.found) {
    Logger.log('Cocok lewat kandidat: "' + hasil.matchedUsing + '" | Vendor: ' + hasil.vendor + ' | Jumlah Koli (kolom): ' + hasil.jumlahKoli);
    Logger.log('Jumlah koli yang statusnya terbaca: ' + hasil.koliStatusMap.size);
    let n = 0;
    hasil.koliStatusMap.forEach(function (status, koli) {
      if (n >= 30) return;
      Logger.log('  Koli ' + koli + ' -> ' + (status ? 'TERFULFILL (checkbox TRUE)' : 'INTRANSIT (checkbox FALSE)'));
      n++;
    });
  } else {
    Logger.log('  TIDAK ketemu di sheet INTRANSIT.');
  }

  Logger.log('=== CEK STATUS HPP (sederhana: cukup "ada baris" di DASHBOARD) ===');
  const hasilHpp = getHppStatusForPOCandidates_(hppData, kandidat);
  Logger.log('Status HPP: ' + (hasilHpp.found ? 'ADA HPP (cocok lewat "' + hasilHpp.matchedUsing + '")' : 'BELUM ADA HPP'));
}

/**
 * ============================================================
 * FUNGSI TES
 * ============================================================
 */
function testMatchIntransit() {
  if (CONFIG_MODUL4.INBOUND_SHEET_URL.indexOf('GANTI_DENGAN') !== -1) {
    Logger.log('WAJIB isi dulu CONFIG_MODUL4.INBOUND_SHEET_URL dengan link file INBOUND yang asli!');
    return;
  }

  const intransitData = loadIntransitData_();
  Logger.log('Total PO ditemukan di sheet INTRANSIT: ' + intransitData.length);

  Logger.log('Contoh 5 PO pertama beserta jumlah koli yang punya status:');
  intransitData.slice(0, 5).forEach(function (po) {
    Logger.log(
      'PO: "' + po.nomorPORaw + '" | Vendor: ' + po.vendor +
      ' | Jumlah Koli (kolom): ' + po.jumlahKoli +
      ' | Koli dengan status terbaca: ' + po.koliStatusMap.size
    );
  });
}