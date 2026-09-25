/**
 * ============================================================
 * MODUL 2 - REPORT HARIAN PARSER
 * ============================================================
 * [VERSI PERBAIKAN]
 * PERUBAHAN vs versi sebelumnya:
 * - parseReportHarian_() sekarang JUGA mengembalikan `matched` dan `mapNote`
 *   per baris item, supaya Modul 5 bisa mencatat item yang GAGAL dipetakan
 *   ke sheet "UNMATCHED ITEMS" (sebelumnya item gagal mapping dari REPORT
 *   HARIAN dipakai apa adanya secara diam-diam, tanpa pernah tercatat di
 *   mana pun -- ini yang menyebabkan nama item aneh/tidak standar seperti
 *   "... KID KID ..." muncul di ON PRODUCTION / DATA TRACKING tanpa
 *   ketahuan sumber masalahnya).
 *
 * Fungsi: membaca sheet "REPORT HARIAN" dari sebuah file PO,
 * lalu mengambil per baris item: TARGET (QTY), FINISH GOOD (TOTAL),
 * REJECT (TOTAL) -- WALAUPUN posisi kolomnya beda-beda tiap file.
 *
 * PENDEKATAN:
 * 1. Cari banner section "TARGET" / "FINISH GOOD" / "REJECT" di baris header
 *    (termasuk kalau itu berupa merged cell / banner lebar).
 * 2. Di dalam rentang kolom banner itu, cari sub-header "QTY" (untuk TARGET)
 *    atau "TOTAL" (untuk FINISH GOOD & REJECT).
 * 3. Cari baris header tabel item (kolom "KATEGORI", "WARNA", "ITEM").
 * 4. Loop tiap baris item, ambil value di kolom yang sudah ketemu di atas.
 *
 * CARA PAKAI (testing):
 * 1. Buka file DATA TRACKING INVENTORY 2026 > Extensions > Apps Script
 *    (pastikan file ini container-bound, sama seperti Modul 1)
 * 2. Tambah file baru "modul2.gs", paste kode ini
 * 3. Jalankan testParseReportHarian()
 * 4. Cek hasilnya di Log eksekusi
 * ============================================================
 */

const CONFIG_MODUL2 = {
  // Ganti dengan salah satu link PO untuk testing
  CONTOH_PO_SHEET_URL: 'https://docs.google.com/spreadsheets/d/1GF3AtPnqgBNHtF8MN7vncj59euVL1yjAFo8isG3bglA/edit',
  REPORT_HARIAN_SHEET_NAME: 'REPORT HARIAN', // ganti kalau nama tab beda
  MAX_HEADER_ROWS_SCAN: 20, // jumlah baris teratas yang discan untuk cari banner/header
};

/**
 * Cari SEMUA sheet yang NAMANYA MENGANDUNG kata kunci tertentu (bisa lebih dari 1).
 * Berguna untuk kasus seperti "SURAT JALAN" dan "SURAT JALAN TAHAP 2" yang
 * SAMA-SAMA harus diproses, bukan cuma salah satu.
 */
function findAllSheetsByPartialName_(ss, keyword) {
  const kw = normalizeText_(keyword);
  const sheets = ss.getSheets();
  const hasil = [];
  for (let i = 0; i < sheets.length; i++) {
    const name = normalizeText_(sheets[i].getName());
    if (name.indexOf(kw) !== -1) {
      hasil.push(sheets[i]);
    }
  }
  return hasil;
}

/**
 * Cari sheet yang NAMANYA MENGANDUNG kata kunci tertentu (bukan harus persis sama).
 * Berguna karena nama tab kadang ada prefix angka, mis. "10 REPORT HARIAN".
 * Kalau ada lebih dari satu yang cocok, ambil yang pertama ketemu.
 */
function findSheetByPartialName_(ss, keyword) {
  const kw = normalizeText_(keyword);
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const name = normalizeText_(sheets[i].getName());
    if (name.indexOf(kw) !== -1) {
      return sheets[i];
    }
  }
  return null;
}

/**
 * Cari semua cell yang cocok dengan teks tertentu (exact match, case-insensitive)
 * di dalam area data. Return array of {row, col} (1-indexed, sesuai Sheets).
 */
function findCellsByText_(dataValues, targetText) {
  const target = normalizeText_(targetText);
  const found = [];
  for (let r = 0; r < dataValues.length; r++) {
    for (let c = 0; c < dataValues[r].length; c++) {
      if (normalizeText_(dataValues[r][c]) === target) {
        found.push({ row: r + 1, col: c + 1 }); // 1-indexed
      }
    }
  }
  return found;
}

/**
 * Berdasarkan satu titik cell (row, col), cari rentang kolomnya kalau cell itu
 * bagian dari merged range (banner lebar). Kalau bukan merged, rentangnya cuma 1 kolom.
 */
function getMergedColSpan_(sheet, row, col) {
  const mergedRanges = sheet.getRange(row, col).getMergedRanges();
  if (mergedRanges.length > 0) {
    const range = mergedRanges[0];
    return {
      colStart: range.getColumn(),
      colEnd: range.getLastColumn()
    };
  }
  return { colStart: col, colEnd: col };
}

/**
 * Di dalam rentang kolom [colStart, colEnd], cari SEMUA kolom yang header-nya
 * mengandung kata kunci tertentu (mis. "TOTAL"), mulai dari baris banner ke bawah
 * sampai beberapa baris. Mengembalikan SEMUA kandidat (bukan cuma 1), karena
 * bisa ada beberapa kolom "TOTAL"-ish dalam satu section (mis. "TOTAL PER SIZE"
 * dan "TOTAL") -- kita akan pilih mana yang benar belakangan berdasarkan
 * cek merge cell ke data asli, bukan cuma dari nama header.
 *
 * @return {Array<number>} daftar kolom (1-indexed) yang match, urut dari kiri ke kanan
 */
function collectSubHeaderColumns_(dataValues, bannerRow, colStart, colEnd, keyword, maxRowsDown) {
  const kw = normalizeText_(keyword);
  const matches = [];

  for (let r = bannerRow - 1; r < Math.min(bannerRow - 1 + maxRowsDown, dataValues.length); r++) {
    for (let c = colStart - 1; c < colEnd; c++) {
      const cellText = normalizeText_(dataValues[r] ? dataValues[r][c] : '');
      if (!cellText) continue;
      if (cellText.indexOf(kw) !== -1) {
        matches.push(c + 1); // 1-indexed
      }
    }
  }

  // Hilangkan duplikat kolom yang sama (kalau kebetulan match di >1 baris)
  return matches.filter(function (col, idx) { return matches.indexOf(col) === idx; });
}

/**
 * Dari beberapa kandidat kolom, pilih yang PALING BENAR untuk data per-baris:
 * yaitu kolom yang cell datanya (di baris data pertama) TIDAK di-merge lintas
 * beberapa baris. Kolom yang merged lintas baris (mis. subtotal grup ukuran)
 * pasti BUKAN nilai per item, jadi kita hindari.
 *
 * @param {number} sampleDataRow - baris data pertama (1-indexed) untuk dicek merge-nya
 * @return {number|null} kolom terpilih, atau kandidat terakhir kalau semua ternyata merged
 */
function pickPerRowColumn_(sheet, candidateCols, sampleDataRow) {
  if (candidateCols.length === 0) return null;
  if (candidateCols.length === 1) return candidateCols[0];

  for (let i = 0; i < candidateCols.length; i++) {
    const col = candidateCols[i];
    const mergedRanges = sheet.getRange(sampleDataRow, col).getMergedRanges();
    const isMultiRowMerge = mergedRanges.length > 0 && mergedRanges[0].getNumRows() > 1;
    if (!isMultiRowMerge) {
      return col; // ini kolom per-baris yang asli, langsung pakai
    }
  }

  // Kalau semua kandidat ternyata merged (jarang terjadi), pakai yang terakhir sebagai fallback
  return candidateCols[candidateCols.length - 1];
}

/**
 * Cari kolom TARGET, FINISH GOOD TOTAL, dan REJECT TOTAL secara otomatis
 * berdasarkan teks banner + sub-header. Butuh objek `sheet` (bukan cuma value-nya)
 * supaya bisa cek merged range untuk tahu rentang kolom tiap banner.
 *
 * @param {number} itemHeaderRow - baris tempat header "ITEM" ditemukan. Pencarian
 *        banner dibatasi ke area SEBELUM baris ini (mis. 15 baris ke atas), supaya
 *        tidak salah nyangkut ke kotak ringkasan (mis. persentase FINISH GOOD)
 *        yang kadang ada di pojok atas sheet, jauh sebelum tabel item dimulai.
 *
 * @return {Object} { targetCol, finishGoodCol, rejectCol } (1-indexed), null kalau gagal ketemu
 */
function detectReportHarianColumns2_(sheet, dataValues, itemHeaderRow) {
  const searchRowStart = Math.max(0, itemHeaderRow - 15); // 0-indexed, batas atas area pencarian
  const searchRowEnd = itemHeaderRow; // 0-indexed exclusive, tidak termasuk baris header ITEM itu sendiri
  const searchArea = dataValues.slice(searchRowStart, searchRowEnd);
  const sampleDataRow = itemHeaderRow + 1; // baris data pertama (1-indexed), untuk cek merge

  function findBannerSpan(bannerText) {
    // Cari dulu di area terbatas (dekat tabel item)
    let cells = findCellsByText_(searchArea, bannerText);
    let rowOffset = searchRowStart; // untuk konversi balik ke row asli

    if (cells.length === 0) {
      // Fallback: kalau tidak ketemu di area terbatas, cari di seluruh sheet
      // (jaga-jaga kalau strukturnya beda dari dugaan)
      cells = findCellsByText_(dataValues, bannerText);
      rowOffset = 0;
    }
    if (cells.length === 0) return null;

    // Ambil kemunculan TERAKHIR (paling bawah/paling dekat ke tabel item),
    // karena kotak ringkasan (kalau ada) biasanya muncul lebih dulu/lebih atas.
    const last = cells[cells.length - 1];
    const actualRow = last.row + rowOffset;
    const span = getMergedColSpan_(sheet, actualRow, last.col);
    return { row: actualRow, colStart: span.colStart, colEnd: span.colEnd };
  }

  const result = { targetCol: null, finishGoodCol: null, rejectCol: null, cuttingCol: null };

  // --- TARGET ---
  const targetBanner = findBannerSpan('TARGET');
  if (targetBanner) {
    const candidates = collectSubHeaderColumns_(
      dataValues, targetBanner.row, targetBanner.colStart, targetBanner.colEnd, 'QTY', 5
    );
    result.targetCol = pickPerRowColumn_(sheet, candidates, sampleDataRow);
  }
  if (!result.targetCol) {
    // Fallback: cari header "QTY" di area terbatas dulu, baru seluruh sheet kalau masih gagal
    let qtyCells = findCellsByText_(searchArea, 'QTY');
    if (qtyCells.length > 0) {
      result.targetCol = qtyCells[qtyCells.length - 1].col;
    } else {
      qtyCells = findCellsByText_(dataValues, 'QTY');
      if (qtyCells.length > 0) result.targetCol = qtyCells[0].col;
    }
  }

  // --- CUTTING (dipakai untuk hitung rasio penyelesaian, mirip pola FINISH GOOD/REJECT) ---
  const cuttingBanner = findBannerSpan('HASIL CUTTING') || findBannerSpan('CUTTING');
  if (cuttingBanner) {
    Logger.log('Banner CUTTING ditemukan di baris ' + cuttingBanner.row + ', kolom ' + cuttingBanner.colStart + '-' + cuttingBanner.colEnd);
    // Cari kandidat dari KEDUA kata kunci -- beberapa file cuma punya "TOTAL" (per grup,
    // merged) TANPA "TOTAL PER SIZE" sama sekali, dan "QTY" itulah yang per-baris asli.
    // Jangan asumsikan "TOTAL" otomatis benar kalau cuma ketemu 1 kandidat -- selalu
    // verifikasi lewat status merge di pickPerRowColumn_.
    const candidatesTotal = collectSubHeaderColumns_(dataValues, cuttingBanner.row, cuttingBanner.colStart, cuttingBanner.colEnd, 'TOTAL', 6);
    const candidatesQty = collectSubHeaderColumns_(dataValues, cuttingBanner.row, cuttingBanner.colStart, cuttingBanner.colEnd, 'QTY', 6);
    const candidates = candidatesQty.concat(candidatesTotal); // QTY duluan -- biasanya itu yang per-baris
    Logger.log('Kandidat kolom CUTTING (QTY+TOTAL): ' + JSON.stringify(candidates));
    result.cuttingCol = pickPerRowColumn_(sheet, candidates, sampleDataRow);
  } else {
    Logger.log('Banner "CUTTING" TIDAK ditemukan sama sekali di area pencarian.');
  }

  // --- FINISH GOOD ---
  const fgBanner = findBannerSpan('FINISH GOOD');
  if (fgBanner) {
    const candidatesTotal = collectSubHeaderColumns_(dataValues, fgBanner.row, fgBanner.colStart, fgBanner.colEnd, 'TOTAL', 6);
    const candidatesQty = collectSubHeaderColumns_(dataValues, fgBanner.row, fgBanner.colStart, fgBanner.colEnd, 'QTY', 6);
    const candidates = candidatesQty.concat(candidatesTotal);
    Logger.log('Kandidat kolom FINISH GOOD (QTY+TOTAL): ' + JSON.stringify(candidates));
    result.finishGoodCol = pickPerRowColumn_(sheet, candidates, sampleDataRow);
  }

  // --- REJECT ---
  const rejectBanner = findBannerSpan('REJECT');
  if (rejectBanner) {
    const candidatesTotal = collectSubHeaderColumns_(dataValues, rejectBanner.row, rejectBanner.colStart, rejectBanner.colEnd, 'TOTAL', 6);
    const candidatesQty = collectSubHeaderColumns_(dataValues, rejectBanner.row, rejectBanner.colStart, rejectBanner.colEnd, 'QTY', 6);
    const candidates = candidatesQty.concat(candidatesTotal);
    Logger.log('Kandidat kolom REJECT (QTY+TOTAL): ' + JSON.stringify(candidates));
    result.rejectCol = pickPerRowColumn_(sheet, candidates, sampleDataRow);
  }

  return result;
}

/**
 * Cari baris & kolom header tabel item. Primary key-nya adalah kolom "ITEM"
 * (karena di sheet REPORT HARIAN, nilai ITEM sudah dalam format standar yang
 * sama persis dengan Master Item Name -- tidak perlu mapping tambahan).
 * KATEGORI dan WARNA sifatnya opsional, cuma untuk informasi tambahan kalau ada.
 *
 * @return {Object} { headerRow, itemCol, kategoriCol (bisa null), warnaCol (bisa null) }
 */
function detectItemTableHeader_(dataValues) {
  const itemCells = findCellsByText_(dataValues, 'ITEM');
  if (itemCells.length === 0) {
    throw new Error('Header "ITEM" tidak ditemukan di sheet REPORT HARIAN.');
  }
  const headerRow = itemCells[0].row;
  const itemCol = itemCells[0].col;

  // KATEGORI & WARNA opsional -- cari di baris header yang sama kalau ada
  let kategoriCol = null, warnaCol = null;
  const rowValues = dataValues[headerRow - 1];
  for (let c = 0; c < rowValues.length; c++) {
    const text = normalizeText_(rowValues[c]);
    if (text === 'KATEGORI') kategoriCol = c + 1;
    if (text === 'WARNA') warnaCol = c + 1;
  }

  return { headerRow, itemCol, kategoriCol, warnaCol };
}

/**
 * Fungsi utama Modul 2: parse sheet REPORT HARIAN dari 1 file PO.
 *
 * @param {string} spreadsheetUrl - link Google Sheet PO
 * @param {Object} masterData - hasil loadItemMasterMap_() dari Modul 1, dipakai untuk
 *        menstandarkan nama ITEM (Report Harian tidak selalu sudah pakai nama standar)
 * @return {Array} daftar {item, itemRaw, matched, mapNote, target, cutting, finishGood, reject, wip}
 *         [PERBAIKAN] item sekarang selalu disertai `matched` (boolean) dan `mapNote`
 *         (alasan gagal kalau matched=false) supaya pemanggil (Modul 5) bisa
 *         mencatat kegagalan ini ke sheet UNMATCHED ITEMS, bukan diam-diam
 *         dipakai apa adanya tanpa jejak.
 */
function parseReportHarian_(spreadsheetUrl, masterData) {
  const ss = SpreadsheetApp.openByUrl(spreadsheetUrl);
  const sheet = findSheetByPartialName_(ss, CONFIG_MODUL2.REPORT_HARIAN_SHEET_NAME);
  if (!sheet) {
    throw new Error('Tidak ada sheet yang namanya mengandung "' + CONFIG_MODUL2.REPORT_HARIAN_SHEET_NAME + '" di: ' + spreadsheetUrl);
  }

  const dataValues = sheet.getDataRange().getValues();

  const itemHeader = detectItemTableHeader_(dataValues);
  const cols = detectReportHarianColumns2_(sheet, dataValues, itemHeader.headerRow);

  Logger.log('Sheet ditemukan: "' + sheet.getName() + '"');
  Logger.log('Header tabel item di baris ' + itemHeader.headerRow + ' -> ITEM col ' + itemHeader.itemCol);
  Logger.log('Kolom terdeteksi -> TARGET: ' + cols.targetCol + ', CUTTING: ' + cols.cuttingCol + ', FINISH GOOD: ' + cols.finishGoodCol + ', REJECT: ' + cols.rejectCol);

  if (!cols.targetCol || !cols.finishGoodCol || !cols.rejectCol) {
    throw new Error('Gagal mendeteksi salah satu kolom (TARGET/FINISH GOOD/REJECT). Cek nama header di sheet.');
  }

  let jumlahDistandarkan = 0;
  let jumlahGagal = 0;
  const results = [];
  for (let r = itemHeader.headerRow; r < dataValues.length; r++) { // mulai dari baris setelah header
    const row = dataValues[r];
    const itemNameRaw = row[itemHeader.itemCol - 1];

    if (!itemNameRaw || String(itemNameRaw).trim() === '') continue; // lewati baris kosong

    // --- Standardisasi nama item lewat Modul 1 (SAMA seperti Surat Jalan) ---
    // ITEM di Report Harian TIDAK selalu sudah standar (mis. "HIJAU BOTOL" padahal
    // master-nya "HIJAU BTL") -- jadi harus lewat proses pencocokan yang sama,
    // bukan dipakai mentah-mentah.
    const itemRawTrimmed = String(itemNameRaw).trim();
    const parsedRaw = deriveKey2FromItem_(normalizeText_(itemNameRaw));
    const mapped = mapItemName_(parsedRaw.key2, parsedRaw.lenganCode, parsedRaw.size, masterData);
    const itemNameFinal = mapped.matched ? mapped.item : itemRawTrimmed;
    if (mapped.matched && mapped.method !== 'exact') {
      jumlahDistandarkan++;
    }
    if (!mapped.matched) {
      jumlahGagal++;
      Logger.log('  [WARNING] ITEM Report Harian gagal distandarkan, dipakai apa adanya: "' + itemNameRaw + '" (' + mapped.note + ')');
    }

    const target = Number(row[cols.targetCol - 1]) || 0;
    const cutting = cols.cuttingCol ? (Number(row[cols.cuttingCol - 1]) || 0) : 0;
    const finishGood = Number(row[cols.finishGoodCol - 1]) || 0;
    const reject = Number(row[cols.rejectCol - 1]) || 0;
    const wip = Math.max(0, target - (finishGood + reject)); // WIP tidak boleh minus -- kalau produksi (FG+Reject) melebihi target, anggap WIP = 0

    results.push({
      item: itemNameFinal, // ITEM = primary key untuk digabung dengan sheet lain (sudah standar KALAU matched=true)
      itemRaw: itemRawTrimmed, // NEW: teks asli persis dari sheet, untuk keperluan log/QA
      matched: mapped.matched, // NEW
      mapNote: mapped.note,    // NEW: alasan/detail kalau gagal (atau kosong kalau berhasil)
      target: target,
      cutting: cutting,
      finishGood: finishGood,
      reject: reject,
      wip: wip
    });
  }

  if (jumlahDistandarkan > 0) {
    Logger.log('  -> ' + jumlahDistandarkan + ' nama ITEM di Report Harian berhasil distandarkan (tidak sama persis dengan master, tapi ketemu via sinonim/fuzzy).');
  }
  if (jumlahGagal > 0) {
    Logger.log('  -> ' + jumlahGagal + ' nama ITEM di Report Harian GAGAL distandarkan sama sekali (akan dicatat ke UNMATCHED ITEMS oleh Modul 5).');
  }

  return results;
}

/**
 * ============================================================
 * FUNGSI DEBUG - jalankan ini kalau testParseReportHarian() error
 * ============================================================
 * Menampilkan isi asli 20 baris x 15 kolom pertama sheet REPORT HARIAN
 * supaya kita bisa lihat persis di mana posisi header KATEGORI/WARNA/ITEM
 * dan kenapa tidak terdeteksi otomatis.
 */
function debugDumpReportHarian() {
  const ss = SpreadsheetApp.openByUrl(CONFIG_MODUL2.CONTOH_PO_SHEET_URL);

  Logger.log('Daftar semua nama tab di file ini:');
  ss.getSheets().forEach(function (s) {
    Logger.log('  - "' + s.getName() + '"');
  });

  const sheet = findSheetByPartialName_(ss, CONFIG_MODUL2.REPORT_HARIAN_SHEET_NAME);
  if (!sheet) {
    Logger.log('Tidak ada sheet yang namanya mengandung "' + CONFIG_MODUL2.REPORT_HARIAN_SHEET_NAME + '". Lihat daftar tab di atas untuk nama yang benar.');
    return;
  }

  const maxRow = Math.min(20, sheet.getLastRow());
  const maxCol = Math.min(15, sheet.getLastColumn());
  const values = sheet.getRange(1, 1, maxRow, maxCol).getValues();

  Logger.log('--- Isi 20 baris x 15 kolom pertama sheet "' + sheet.getName() + '" ---');
  for (let r = 0; r < values.length; r++) {
    const rowText = values[r].map(function (v, i) {
      return '[' + (i + 1) + ']=' + JSON.stringify(v);
    }).join(' | ');
    Logger.log('Baris ' + (r + 1) + ': ' + rowText);
  }
}

/**
 * ============================================================
 * FUNGSI TES
 * ============================================================
 */
function testParseReportHarian() {
  const masterData = loadItemMasterMap_(); // dari Modul 1 -- dibutuhkan untuk standardisasi nama ITEM
  const hasil = parseReportHarian_(CONFIG_MODUL2.CONTOH_PO_SHEET_URL, masterData);
  Logger.log('Total baris item terbaca: ' + hasil.length);
  Logger.log('Contoh 5 baris pertama:');
  hasil.slice(0, 5).forEach(function (row) {
    Logger.log(
      row.item + ' | Target: ' + row.target +
      ' | FG: ' + row.finishGood +
      ' | Reject: ' + row.reject +
      ' | WIP: ' + row.wip +
      ' | matched: ' + row.matched
    );
  });

  const gagal = hasil.filter(function (r) { return !r.matched; });
  if (gagal.length > 0) {
    Logger.log('--- Item REPORT HARIAN yang GAGAL dipetakan (max 10) ---');
    gagal.slice(0, 10).forEach(function (r) {
      Logger.log('"' + r.itemRaw + '" -> ' + r.mapNote);
    });
  }
}