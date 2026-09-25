/**
 * ============================================================
 * MODUL 3 - SURAT JALAN NEW PARSER
 * ============================================================
 * [VERSI v5 -- REWRITE TOTAL UNTUK FORMAT "SURAT JALAN NEW"]
 *
 * GANTI TOTAL dari versi sebelumnya (v4). Format lama (grid per-koli versi
 * lama, dan format "form" per-baris koli lama) DIHAPUS SELURUHNYA -- tidak
 * ada fallback ke format lama sama sekali. Modul ini HANYA membaca sheet
 * yang namanya MENGANDUNG "SURAT JALAN NEW" (jadi "Salinan dari SURAT JALAN
 * NEW" ikut kebaca).
 *
 * STRUKTUR SHEET "SURAT JALAN NEW" (hasil observasi contoh nyata):
 *   Baris label (di kolom sebelah kiri, sebelum kolom data koli dimulai):
 *     - "BERAT KOLI"      -> baris ini berisi berat (KG) per koli
 *     - "Awb / Resi"      -> baris ini berisi teks AWB/Resi (bisa 1 sel
 *                            gabungan mencakup beberapa koli sekaligus,
 *                            ATAU disalin manual ke tiap kolom -- dua-duanya
 *                            ditangani lewat pembacaan yang sadar merge cell)
 *     - "Tanggal Kirim"   -> baris ini berisi tanggal pengiriman (Date atau
 *                            teks), pola pembacaan sama seperti Awb/Resi
 *   Baris header tabel item:
 *     KATEGORI | WARNA | ITEM NAME | Lengan & Size | Total | <nomor koli 1> | <nomor koli 2> | ...
 *     - Kolom "nomor koli" ini TEKS BEBAS (bukan harus angka polos -- bisa
 *       "1", "KOLI 1", dsb). Dipakai APA ADANYA untuk kolom NOMOR KOLI di
 *       output, tapi untuk PENCOCOKAN ke sheet INTRANSIT (yang formatnya
 *       angka+checkbox), diambil angka pertama yang ada di teksnya lewat
 *       extractKoliNumber_() (didefinisikan di Modul 4).
 *     - REJECT ditandai lewat WARNA BACKGROUND KUNING pada sel nomor koli
 *       di baris header ini -- SEMUA item di kolom koli itu dianggap reject.
 *   Baris-baris item (di bawah header): tiap baris = 1 kombinasi
 *     KATEGORI+WARNA+ITEM NAME+Lengan&Size. Kolom "ITEM NAME" SUDAH dalam
 *     format standar Master Item Name (mis. "BEIGE 24S PDK M"), jadi tetap
 *     diproses lewat jalur standardisasi yang sama (deriveKey2FromItem_ +
 *     mapItemName_ dari Modul 1) supaya kalau ada penulisan yang meleset
 *     dari master, tetap tercatat ke UNMATCHED ITEMS (bukan diam-diam
 *     dipakai apa adanya).
 *
 * DEPENDENSI: fungsi-fungsi berikut dipakai dari Modul 1 (normalizeText_,
 * deriveKey2FromItem_, mapItemName_) dan Modul 2 (findAllSheetsByPartialName_).
 * Harus ada di project Apps Script yang SAMA.
 * ============================================================
 */

const CONFIG_MODUL3 = {
  CONTOH_PO_SHEET_URL: 'https://docs.google.com/spreadsheets/d/1GF3AtPnqgBNHtF8MN7vncj59euVL1yjAFo8isG3bglA/edit',
  SURAT_JALAN_SHEET_NAME: 'SURAT JALAN NEW', // dicari pakai "mengandung", case-insensitive
  LABEL_MAX_SCAN_ROWS_UP: 10, // jumlah baris di atas header tabel item yang discan untuk cari label BERAT/AWB/TANGGAL
  // Daftar warna background (hex, huruf kecil) yang dianggap penanda REJECT
  // di sel nomor koli (baris header). Di luar daftar ini, ada juga fallback
  // heuristik "kuning secara umum" lewat isWarnaRejectSJNew_().
  WARNA_REJECT_HEX: ['#ffff00', '#ffd966', '#fce8b2', '#fff2cc', '#ffe599', '#fffd37'],
};

/**
 * Cari SEMUA cell yang teksnya MENGANDUNG suatu kata kunci (substring,
 * case-insensitive setelah normalizeText_). Beda dari findCellsByText_ di
 * Modul 2 (yang exact match) -- di sini sengaja dibikin fleksibel karena
 * label di sheet SURAT JALAN NEW bisa sedikit bervariasi penulisannya
 * (mis. "TANGGAL KIRIM" vs "TGL KIRIM", "AWB/RESI" vs "Awb / Resi").
 */
function findCellsByTextContains_(dataValues, keyword) {
  const kw = normalizeText_(keyword);
  const found = [];
  for (let r = 0; r < dataValues.length; r++) {
    const row = dataValues[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cellText = normalizeText_(row[c]);
      if (cellText && cellText.indexOf(kw) !== -1) {
        found.push({ row: r + 1, col: c + 1 }); // 1-indexed
      }
    }
  }
  return found;
}

/**
 * Cari baris & kolom header tabel item di sheet SURAT JALAN NEW:
 * - Anchor utama: cell yang mengandung teks "ITEM NAME" -> itemNameCol, headerRow.
 * - Di baris yang sama, cari cell "TOTAL" (kolom ringkasan qty per item,
 *   SEBELUM kolom-kolom nomor koli mulai) -> totalCol.
 * - Kolom koli dimulai TEPAT setelah totalCol, dan berakhir di kolom
 *   terakhir yang header-nya TIDAK KOSONG (berhenti begitu ketemu 1 sel
 *   kosong pertama).
 *
 * @return {Object|null} { headerRow, itemNameCol, totalCol, koliStartCol, koliEndCol }
 */
function detectSuratJalanNewHeader_(dataValues) {
  const itemNameCells = findCellsByTextContains_(dataValues, 'ITEM NAME');
  if (itemNameCells.length === 0) return null;

  const headerRow = itemNameCells[0].row;
  const itemNameCol = itemNameCells[0].col;
  const rowValues = dataValues[headerRow - 1] || [];

  let totalCol = null;
  for (let c = itemNameCol; c < rowValues.length; c++) {
    if (normalizeText_(rowValues[c]) === 'TOTAL') { totalCol = c + 1; break; }
  }
  if (!totalCol) return null;

  const koliStartCol = totalCol + 1;
  let koliEndCol = koliStartCol - 1;
  for (let c = koliStartCol - 1; c < rowValues.length; c++) {
    const v = rowValues[c];
    if (v === null || v === undefined || String(v).trim() === '') break;
    koliEndCol = c + 1;
  }
  if (koliEndCol < koliStartCol) return null;

  return { headerRow, itemNameCol, totalCol, koliStartCol, koliEndCol };
}

/**
 * Cari 3 baris label (BERAT, AWB/RESI, TANGGAL) di AREA SEBELAH KIRI kolom
 * koli (kolom sebelum koliStartCol), dalam rentang beberapa baris di atas
 * header tabel item. Kalau ada lebih dari 1 kemunculan kata kunci yang
 * sama, dipakai yang PALING DEKAT ke header row (paling masuk akal secara
 * layout).
 *
 * @return {Object} { beratRow, awbRow, tanggalRow } -- masing-masing baris
 *         1-indexed, atau null kalau tidak ketemu.
 */
function findSuratJalanNewLabelRows_(dataValues, headerRow, koliStartCol) {
  const scanRowStart0 = Math.max(0, headerRow - 1 - CONFIG_MODUL3.LABEL_MAX_SCAN_ROWS_UP);
  const scanRowEnd0 = headerRow - 1; // exclusive, tidak termasuk baris header itu sendiri
  const leftColEnd0 = koliStartCol - 1; // kolom 0..leftColEnd0-1 dianggap area label

  function findRow(keywords) {
    let found = null;
    for (let r = scanRowStart0; r < scanRowEnd0; r++) {
      const row = dataValues[r];
      if (!row) continue;
      for (let c = 0; c < leftColEnd0; c++) {
        const text = normalizeText_(row[c]);
        if (!text) continue;
        if (keywords.some(function (kw) { return text.indexOf(kw) !== -1; })) {
          found = r + 1; // terus ditimpa -> hasil akhir = kemunculan paling dekat ke header
        }
      }
    }
    return found;
  }

  return {
    beratRow: findRow(['BERAT']),
    awbRow: findRow(['AWB', 'RESI']),
    tanggalRow: findRow(['TANGGAL', 'TGL']),
  };
}

/**
 * Baca 1 baris sepanjang [startCol, startCol+numCols-1], SADAR MERGE CELL:
 * kalau suatu rentang sel di-merge jadi satu, nilai sel gabungan itu
 * "disebar" ke semua kolom yang termasuk dalam rentang merge tsb. Ini
 * menangani DUA kemungkinan sekaligus: (a) label ditulis 1x di sel gabungan
 * yang meng-cover banyak koli, ATAU (b) nilai yang SAMA disalin manual ke
 * tiap kolom satu-satu (tidak di-merge) -- untuk kasus (b), fungsi ini
 * otomatis baca literal per kolom (tidak ada merge yang perlu disebar).
 */
function getRowValuesMergedAwareSJ_(sheet, row, startCol, numCols) {
  const range = sheet.getRange(row, startCol, 1, numCols);
  const values = range.getValues()[0];
  const merged = range.getMergedRanges();

  merged.forEach(function (mr) {
    const val = mr.getCell(1, 1).getValue();
    const mrStartCol = mr.getColumn();
    const mrEndCol = mr.getLastColumn();
    for (let c = Math.max(mrStartCol, startCol); c <= Math.min(mrEndCol, startCol + numCols - 1); c++) {
      values[c - startCol] = val;
    }
  });

  return values;
}

/**
 * Cek apakah suatu warna background (hex) dianggap "kuning" (penanda REJECT).
 * Cek dulu ke daftar hex yang sudah dikenal, kalau tidak ketemu, pakai
 * heuristik umum: R & G tinggi, B rendah (ciri khas warna kuning).
 */
function isWarnaRejectSJNew_(hex) {
  const h = String(hex || '').toLowerCase();
  if (CONFIG_MODUL3.WARNA_REJECT_HEX.indexOf(h) !== -1) return true;
  const m = h.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (!m) return false;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return r > 200 && g > 180 && b < 150;
}

/**
 * Format nilai kolom AWB/Resi jadi teks siap pakai:
 * - Angka polos (mis. 12184) -> "AWB 12184"
 * - Teks yang mengandung bagian tanggal/waktu menempel di belakang, dipisah
 *   dengan "/" (mis. "AWB11835 / 11 Agustus 2026", atau bahkan dua "/" sekaligus
 *   seperti "AWB11769 / 28JUL26 / 01:37WIB") -> [FIX] AMBIL HANYA SEGMEN PERTAMA
 *   sebelum "/" pertama ("AWB11835", "AWB11769") -- kode resi selalu ditulis
 *   duluan di depan, jadi tanggal/jam di belakangnya dibuang.
 * - Teks lain yang sudah bersih tanpa "/" (mis. "AWB 11791", "STT 14381",
 *   "A0111", "No09324") -> dipakai APA ADANYA.
 */
function formatResiBaru_(awbRaw) {
  if (awbRaw === null || awbRaw === undefined) return '';
  let text = String(awbRaw).trim();
  if (!text) return '';
  if (text.indexOf('/') !== -1) {
    text = text.split('/')[0].trim();
  }
  if (!text) return '';
  if (/^\d+$/.test(text)) return 'AWB ' + text;
  return text;
}

/**
 * Ambil NOMOR PO dari cell yang mengandung teks "NOMOR PO", kalau isinya
 * cuma placeholder "-" atau kosong, dianggap TIDAK ADA (return null) --
 * supaya tidak dipakai sebagai kandidat pencocokan PO yang keliru (banyak
 * PO yang sama-sama bertuliskan "-" akan salah nyangkut kalau dipaksa dipakai).
 */
function extractNomorPOSJNew_(dataValues) {
  const cells = findCellsByTextContains_(dataValues, 'NOMOR PO');
  if (cells.length === 0) return null;
  const row = dataValues[cells[0].row - 1] || [];
  for (let c = cells[0].col; c < row.length; c++) {
    const v = row[c];
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      const text = String(v).trim();
      if (text === '-') return null;
      return text;
    }
  }
  return null;
}

/**
 * Parse SATU sheet SURAT JALAN NEW jadi daftar entri per (item x koli).
 */
function parseSuratJalanNewSheet_(sheet, dataValues, masterData) {
  const header = detectSuratJalanNewHeader_(dataValues);
  if (!header) {
    Logger.log('  [WARNING] Sheet "' + sheet.getName() + '" -- header tabel item ("ITEM NAME" + "TOTAL") tidak ketemu, dilewati.');
    return [];
  }

  const { headerRow, itemNameCol, koliStartCol, koliEndCol } = header;
  const blockWidth = koliEndCol - koliStartCol + 1;

  const labelRows = findSuratJalanNewLabelRows_(dataValues, headerRow, koliStartCol);
  if (!labelRows.tanggalRow) {
    Logger.log('  [WARNING] Sheet "' + sheet.getName() + '" -- baris label "Tanggal Kirim" tidak ketemu, TANGGAL DAN JAM PENGIRIMAN akan kosong utk entri dari sheet ini.');
  }
  if (!labelRows.awbRow) {
    Logger.log('  [WARNING] Sheet "' + sheet.getName() + '" -- baris label "Awb / Resi" tidak ketemu, RESI akan kosong utk entri dari sheet ini.');
  }

  const beratRowFull = labelRows.beratRow ? getRowValuesMergedAwareSJ_(sheet, labelRows.beratRow, koliStartCol, blockWidth) : [];
  const awbRowFull = labelRows.awbRow ? getRowValuesMergedAwareSJ_(sheet, labelRows.awbRow, koliStartCol, blockWidth) : [];
  const tanggalRowFull = labelRows.tanggalRow ? getRowValuesMergedAwareSJ_(sheet, labelRows.tanggalRow, koliStartCol, blockWidth) : [];

  const koliHeaderTexts = sheet.getRange(headerRow, koliStartCol, 1, blockWidth).getValues()[0];
  const koliHeaderBg = sheet.getRange(headerRow, koliStartCol, 1, blockWidth).getBackgrounds()[0];

  // Kolom koli yang VALID = header-nya tidak kosong (apapun isinya -- teks bebas).
  const koliCols = [];
  for (let i = 0; i < blockWidth; i++) {
    const raw = koliHeaderTexts[i];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    koliCols.push({
      offset: i,
      nomorKoli: String(raw).trim(), // TEKS APA ADANYA -- dipakai utk kolom NOMOR KOLI output
      isReject: isWarnaRejectSJNew_(koliHeaderBg[i]),
    });
  }
  if (koliCols.length === 0) {
    Logger.log('  [WARNING] Sheet "' + sheet.getName() + '" -- tidak ada kolom nomor koli yang terisi.');
    return [];
  }

  const itemsStartRow = headerRow + 1;
  const lastRow = sheet.getLastRow();
  const numItemRows = lastRow - itemsStartRow + 1;
  if (numItemRows <= 0) return [];

  const itemNames = sheet.getRange(itemsStartRow, itemNameCol, numItemRows, 1).getValues();
  const qtyBlock = sheet.getRange(itemsStartRow, koliStartCol, numItemRows, blockWidth).getValues();

  const entries = [];

  for (let r = 0; r < itemNames.length; r++) {
    const itemNameRaw = itemNames[r][0];
    if (!itemNameRaw || String(itemNameRaw).trim() === '') continue;

    // ITEM NAME di sheet ini sudah format standar (mis. "BEIGE 24S PDK M"),
    // tetap lewat jalur standardisasi Modul 1 supaya penulisan yang meleset
    // dari Master tetap tercatat (bukan dipakai diam-diam apa adanya).
    const parsedRaw = deriveKey2FromItem_(normalizeText_(itemNameRaw));
    const mapped = mapItemName_(parsedRaw.key2, parsedRaw.lenganCode, parsedRaw.size, masterData);

    koliCols.forEach(function (kc) {
      const qty = qtyBlock[r][kc.offset];
      if (!(Number(qty) > 0)) return;

      const tglRaw = labelRows.tanggalRow ? tanggalRowFull[kc.offset] : '';
      const awbRaw = labelRows.awbRow ? awbRowFull[kc.offset] : '';
      const beratRaw = labelRows.beratRow ? beratRowFull[kc.offset] : '';

      entries.push({
        nomorKoli: kc.nomorKoli,
        itemStandard: mapped.matched ? mapped.item : (String(itemNameRaw).trim() + ' (TIDAK DITEMUKAN DI MASTER)'),
        matched: mapped.matched,
        method: mapped.method,
        note: mapped.note,
        qty: Number(qty),
        tglPengiriman: tglRaw || '',
        resi: formatResiBaru_(awbRaw),
        beratKgKoli: beratRaw ? String(beratRaw).trim() : '',
        sheetAsal: sheet.getName(),
        tipe: kc.isReject ? 'reject' : 'shipped',
      });
    });
  }

  return entries;
}

/**
 * ============================================================
 * FUNGSI UTAMA (dipanggil Modul 5) -- TANDA TANGAN TIDAK BERUBAH:
 * parseSuratJalan_(spreadsheetUrl, masterMap) -> { nomorPO, entries }
 * ============================================================
 * Cari SEMUA sheet yang namanya MENGANDUNG "SURAT JALAN NEW", parse
 * masing-masing, gabungkan entri-nya.
 */
function parseSuratJalan_(spreadsheetUrl, masterMap) {
  const ss = SpreadsheetApp.openByUrl(spreadsheetUrl);
  const sheetList = findAllSheetsByPartialName_(ss, CONFIG_MODUL3.SURAT_JALAN_SHEET_NAME);
  if (sheetList.length === 0) {
    throw new Error('Tidak ada sheet yang namanya mengandung "' + CONFIG_MODUL3.SURAT_JALAN_SHEET_NAME + '" di: ' + spreadsheetUrl);
  }

  Logger.log('  Ditemukan ' + sheetList.length + ' sheet SURAT JALAN NEW: ' + sheetList.map(function (s) { return '"' + s.getName() + '"'; }).join(', '));

  let nomorPO = null;
  const entries = [];

  sheetList.forEach(function (sheet) {
    const dataValues = sheet.getDataRange().getValues();
    if (!nomorPO) nomorPO = extractNomorPOSJNew_(dataValues);

    const hasil = parseSuratJalanNewSheet_(sheet, dataValues, masterMap);
    entries.push.apply(entries, hasil);
    Logger.log('  Sheet "' + sheet.getName() + '" -> ' + hasil.length + ' entri (' +
      hasil.filter(function (e) { return e.tipe === 'reject'; }).length + ' reject).');
  });

  return { nomorPO: nomorPO, entries: entries };
}

/**
 * ============================================================
 * FUNGSI DEBUG & TES
 * ============================================================
 */
function debugDeteksiSuratJalanNew(spreadsheetUrl) {
  const ss = SpreadsheetApp.openByUrl(spreadsheetUrl || CONFIG_MODUL3.CONTOH_PO_SHEET_URL);
  const sheetList = findAllSheetsByPartialName_(ss, CONFIG_MODUL3.SURAT_JALAN_SHEET_NAME);
  if (sheetList.length === 0) {
    Logger.log('Tidak ada sheet SURAT JALAN NEW ditemukan.');
    return;
  }
  sheetList.forEach(function (sheet) {
    Logger.log('===== Sheet "' + sheet.getName() + '" =====');
    const dataValues = sheet.getDataRange().getValues();
    const header = detectSuratJalanNewHeader_(dataValues);
    if (!header) {
      Logger.log('  Header TIDAK terdeteksi.');
      return;
    }
    Logger.log('  headerRow: ' + header.headerRow + ' | itemNameCol: ' + header.itemNameCol + ' | totalCol: ' + header.totalCol + ' | koliStartCol: ' + header.koliStartCol + ' | koliEndCol: ' + header.koliEndCol);
    const labelRows = findSuratJalanNewLabelRows_(dataValues, header.headerRow, header.koliStartCol);
    Logger.log('  beratRow: ' + labelRows.beratRow + ' | awbRow: ' + labelRows.awbRow + ' | tanggalRow: ' + labelRows.tanggalRow);
  });
}

function testParseSuratJalan() {
  const masterMap = loadItemMasterMap_();
  const hasil = parseSuratJalan_(CONFIG_MODUL3.CONTOH_PO_SHEET_URL, masterMap);

  Logger.log('Nomor PO (dari sheet, opsional): ' + hasil.nomorPO);
  Logger.log('Total entri: ' + hasil.entries.length);

  const shippedCount = hasil.entries.filter(function (e) { return e.tipe === 'shipped'; }).length;
  const rejectCount = hasil.entries.filter(function (e) { return e.tipe === 'reject'; }).length;
  Logger.log('Breakdown tipe -> shipped: ' + shippedCount + ', reject: ' + rejectCount);

  const byMethod = { exact: 0, alias: 0, fuzzy: 0, key_synonym: 0, key_synonym_unordered: 0, none: 0 };
  hasil.entries.forEach(function (e) { byMethod[e.method] = (byMethod[e.method] || 0) + 1; });
  Logger.log('Breakdown metode matching -> ' + JSON.stringify(byMethod));

  Logger.log('Contoh 10 entri pertama:');
  hasil.entries.slice(0, 10).forEach(function (e) {
    Logger.log('Koli "' + e.nomorKoli + '" | ' + e.itemStandard + ' | Qty: ' + e.qty + ' | [' + e.method + '] | tipe: ' + e.tipe + ' | tgl: ' + e.tglPengiriman + ' | resi: ' + e.resi);
  });

  const gagalMatch = hasil.entries.filter(function (e) { return !e.matched; });
  if (gagalMatch.length > 0) {
    Logger.log('--- Contoh entri yang GAGAL total mapping (max 10) ---');
    gagalMatch.slice(0, 10).forEach(function (e) {
      Logger.log('Koli "' + e.nomorKoli + '" | ' + e.itemStandard);
    });
  }
}