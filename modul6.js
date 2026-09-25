/**
 * ============================================================
 * MODUL 6 -- WEB APP ENDPOINT: UPDATE STATUS STOCK DARI DASHBOARD
 * ============================================================
 * [VERSI v2 -- MENYESUAIKAN SHEET "STATUS STOCK" 5 KOLOM]
 *
 * PERUBAHAN vs v1:
 * - Target sheet berubah dari "STATUS CRITICAL" (2 kolom: ITEM, STATUS) menjadi
 *   "STATUS STOCK" (5 kolom: ITEM | KATEGORI | WARNA | LENGAN & SIZE | STATUS).
 * - Saat MENIMPA status item yang SUDAH ADA barisnya, cuma kolom E (STATUS) yang
 *   ditulis -- kolom KATEGORI/WARNA/LENGAN & SIZE yang sudah ada TIDAK disentuh.
 * - Saat MENAMBAH baris baru untuk item yang belum pernah tercatat, kolom
 *   KATEGORI/WARNA/LENGAN & SIZE dibiarkan KOSONG (cuma ITEM + STATUS yang diisi).
 *   Ini tidak masalah secara fungsional -- Modul 5 (loadStatusStokMap_) cuma
 *   butuh kolom A (ITEM) dan E (STATUS), 3 kolom tengah itu murni informatif.
 *
 * File ini menambahkan 1 pintu masuk (doPost) supaya dashboard HTML bisa
 * MENULIS BALIK ke sheet "STATUS STOCK" -- yaitu saat tombol "Update Status
 * Stock (jadi default)" di dashboard ditekan setelah upload file Status Stock
 * (Excel) dan memilih Store + Jenis Status sebagai overlay.
 *
 * Konsepnya SAMA seperti sebelumnya:
 * - Sheet STATUS STOCK = status DEFAULT/BASELINE yang otomatis termuat oleh
 *   SEMUA orang yang buka dashboard TANPA perlu upload apapun.
 * - Kalau seseorang upload file Status Stock di dashboard, pilih Store + Jenis
 *   Status, lalu tekan tombol "Update Status Stock (jadi default)" -- maka data
 *   itu MENIMPA sheet STATUS STOCK ini (kolom STATUS-nya saja), jadi default baru.
 * - Setelah STATUS STOCK diperbarui, updateDataTracking() (Modul 5) OTOMATIS
 *   dijadwalkan jalan sendiri beberapa detik kemudian, supaya kolom STATUS TOTAL
 *   STOK di DATA TRACKING (snapshot) ikut ter-refresh.
 *
 * SYARAT: fungsi ini butuh updateDataTracking(), PROP_KEY_PROGRESS_INDEX, dan
 * PROP_KEY_ERROR_POS dari Modul 5 (Modul5_Orchestrator.gs) ada di PROJECT APPS
 * SCRIPT YANG SAMA -- karena satu project berbagi scope global antar file.
 *
 * ============================================================
 * CARA DEPLOY (WAJIB dilakukan manual, tidak bisa dari sini):
 * ============================================================
 * 1. Buka Apps Script project yang SAMA dengan Modul 1-5 (yang terikat ke
 *    spreadsheet "DATA TRACKING VENDOR TO DC").
 * 2. Tempel file ini sebagai file baru (mis. nama "Modul6_UpdateStatusStockWebApp").
 * 3. GANTI nilai SECRET_CODE_ di bawah ini dengan kode rahasia pilihan Anda
 *    sendiri (jangan pakai contoh default -- itu cuma placeholder).
 * 4. Klik Deploy > New deployment > pilih tipe "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone (supaya dashboard di browser siapapun bisa akses)
 * 5. Setelah deploy, salin URL Web App yang muncul (diakhiri /exec).
 * 6. Tempel URL itu ke konstanta STATUS_STOCK_UPDATE_URL di file HTML
 *    dashboard (cari baris yang ada tulisan STATUS_STOCK_UPDATE_URL).
 * 7. Tempel KODE RAHASIA yang sama (poin 3) ke konstanta
 *    STATUS_STOCK_UPDATE_SECRET di file HTML dashboard juga.
 *
 * CATATAN KEAMANAN JUJUR: kode rahasia ini akan tersimpan di kode JavaScript
 * dashboard, yang bisa dilihat siapapun lewat "View Page Source" browser. Ini
 * HANYA penghalang ringan (mencegah orang iseng/salah klik menimpa data),
 * BUKAN keamanan sungguhan. Kalau butuh keamanan lebih serius, perlu arsitektur
 * berbeda (login per user, dsb).
 * ============================================================
 */

// [WAJIB DIGANTI] Kode rahasia -- harus SAMA PERSIS dengan yang ditaruh di dashboard HTML.
const SECRET_CODE_ = 'PPIC_38';

const STATUS_STOCK_SHEET_NAME_ = 'STATUS STOCK';
const STATUS_STOCK_ITEM_COL_ = 1;   // kolom A = ITEM
const STATUS_STOCK_STATUS_COL_ = 5; // kolom E = STATUS
const META_SHEET_NAME_ = 'STATUS STOCK META';

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'Body request bukan JSON yang valid.' });
  }

  if (payload.secret !== SECRET_CODE_) {
    return jsonResponse_({ ok: false, error: 'Kode rahasia salah atau kosong.' });
  }

  const items = payload.items; // [{ itemName, status }, ...]
  const sourceStore = String(payload.sourceStore || '').trim();
  const statusTypeLabel = String(payload.statusTypeLabel || '').trim();

  if (!Array.isArray(items) || items.length === 0) {
    return jsonResponse_({ ok: false, error: 'Tidak ada data item yang dikirim.' });
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(STATUS_STOCK_SHEET_NAME_);
    if (!sheet) {
      return jsonResponse_({ ok: false, error: 'Sheet "' + STATUS_STOCK_SHEET_NAME_ + '" tidak ditemukan di spreadsheet ini.' });
    }

    // Index baris yang sudah ada, kunci pakai versi ternormalisasi (konsisten
    // dengan cara loadStatusStokMap_() di Modul 5 membaca sheet ini).
    const lastRow = sheet.getLastRow();
    const existing = lastRow >= 2 ? sheet.getRange(2, STATUS_STOCK_ITEM_COL_, lastRow - 1, 1).getValues() : [];
    const itemToRowIndex = new Map(); // normalizeText_(item) -> nomor baris asli (1-indexed)
    existing.forEach(function (row, idx) {
      const itemName = row[0];
      if (itemName && String(itemName).trim() !== '') {
        itemToRowIndex.set(normalizeText_(itemName), idx + 2);
      }
    });

    let updatedCount = 0;
    const toAppend = [];
    items.forEach(function (it) {
      const itemName = String(it.itemName || '').trim();
      const status = String(it.status || '').trim();
      if (!itemName) return;
      const key = normalizeText_(itemName);
      if (itemToRowIndex.has(key)) {
        // Item sudah ada -- HANYA timpa kolom STATUS (E), kolom KATEGORI/WARNA/
        // LENGAN & SIZE yang sudah ada TIDAK disentuh.
        sheet.getRange(itemToRowIndex.get(key), STATUS_STOCK_STATUS_COL_).setValue(status);
        updatedCount++;
      } else {
        // Item baru -- tulis ITEM + STATUS saja, kolom tengah dikosongkan.
        toAppend.push([itemName, '', '', '', status]);
      }
    });
    if (toAppend.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, 5).setValues(toAppend);
    }

    // Tulis/perbarui penanda sumber update, di sheet META terpisah supaya tidak
    // mengganggu kolom A-E milik STATUS STOCK sendiri.
    tulisMetaUpdate_(ss, sourceStore, statusTypeLabel, updatedCount + toAppend.length);

    // Jadwalkan updateDataTracking() (Modul 5) untuk jalan otomatis beberapa detik
    // lagi -- supaya kolom STATUS TOTAL STOK (snapshot) di DATA TRACKING ikut
    // ter-refresh. Dijadwalkan lewat trigger (bukan dipanggil langsung di sini)
    // supaya respons ke dashboard tetap cepat.
    jadwalkanUpdateDataTracking_();

    return jsonResponse_({
      ok: true,
      updated: updatedCount,
      appended: toAppend.length,
      total: updatedCount + toAppend.length,
      catatan: 'STATUS STOCK sudah diperbarui, dan proses refresh DATA TRACKING (Update Data Sekarang) sudah dijadwalkan jalan otomatis dalam beberapa detik -- tidak perlu dijalankan manual lagi. Untuk PO yang banyak, proses ini bisa makan waktu beberapa menit; cek Google Sheet untuk lihat progresnya.'
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message });
  }
}

/**
 * Jadwalkan updateDataTracking() (fungsi utama Modul 5) untuk jalan otomatis
 * 2 detik lagi lewat trigger sekali-jalan. Supaya SATU PENEKANAN tombol "Update
 * Status Stock" di dashboard langsung membereskan KEDUA langkah (update STATUS
 * STOCK + refresh DATA TRACKING), tanpa perlu buka Google Sheet dan jalankan
 * menu manual lagi.
 *
 * Kalau kebetulan ada proses updateDataTracking() lain yang SEDANG berjalan/
 * tertunda (progress index tersimpan dari sesi sebelumnya), reset dulu supaya
 * proses baru ini mulai dari AWAL secara bersih -- bukan menyambung dari titik
 * lama yang datanya sudah beda (karena STATUS STOCK barusan berubah).
 */
function jadwalkanUpdateDataTracking_() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'updateDataTracking') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Pakai konstanta ASLI dari Modul 5 (PROP_KEY_PROGRESS_INDEX/PROP_KEY_ERROR_POS)
  // -- karena satu project Apps Script berbagi scope global antar file.
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_KEY_PROGRESS_INDEX);
  props.deleteProperty(PROP_KEY_ERROR_POS);

  ScriptApp.newTrigger('updateDataTracking')
    .timeBased()
    .after(2 * 1000) // 2 detik lagi
    .create();
}

function tulisMetaUpdate_(ss, sourceStore, statusTypeLabel, jumlahItem) {
  let metaSheet = ss.getSheetByName(META_SHEET_NAME_);
  if (!metaSheet) {
    metaSheet = ss.insertSheet(META_SHEET_NAME_);
    metaSheet.getRange(1, 1, 1, 2).setValues([['KEY', 'VALUE']]);
    metaSheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  }
  const rows = [
    ['SUMBER_STORE', sourceStore],
    ['JENIS_STATUS', statusTypeLabel],
    ['JUMLAH_ITEM', jumlahItem],
    ['WAKTU_UPDATE', new Date().toISOString()],
  ];
  if (metaSheet.getLastRow() > 1) {
    metaSheet.getRange(2, 1, metaSheet.getLastRow() - 1, 2).clearContent();
  }
  metaSheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Dipanggil dashboard lewat GET (tanpa parameter apapun) setiap kali dashboard
 * dibuka/refresh, supaya penanda "status default sekarang dari Store apa" (hasil
 * push terakhir dari file Status Stock yang di-upload) kelihatan di browser
 * SIAPAPUN -- bukan cuma di browser orang yang menekan tombol Update tadi.
 */
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const metaSheet = ss.getSheetByName(META_SHEET_NAME_);
    if (!metaSheet || metaSheet.getLastRow() < 2) {
      return jsonResponse_({ ok: true, store: '', statusTypeLabel: '', itemCount: 0, updatedAt: '' });
    }
    const rows = metaSheet.getRange(2, 1, metaSheet.getLastRow() - 1, 2).getValues();
    const map = {};
    rows.forEach(function (row) { map[row[0]] = row[1]; });
    return jsonResponse_({
      ok: true,
      store: String(map['SUMBER_STORE'] || ''),
      statusTypeLabel: String(map['JENIS_STATUS'] || ''),
      itemCount: Number(map['JUMLAH_ITEM'] || 0),
      updatedAt: map['WAKTU_UPDATE'] ? new Date(map['WAKTU_UPDATE']).toISOString() : '',
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message });
  }
}

// Opsional: buat tes manual dari editor Apps Script (jalankan fungsi ini sendiri
// utk cek koneksi ke sheet tanpa perlu deploy Web App dulu).
function tesManual_updateStatusStock() {
  const fakeEvent = {
    postData: {
      contents: JSON.stringify({
        secret: SECRET_CODE_,
        sourceStore: 'TOTAL STOCK',
        statusTypeLabel: 'Status Total Stok (WIP + OD + OH)',
        items: [
          { itemName: 'CONTOH ITEM TES 24S PDK M', status: 'CRITICAL LVL 2' }
        ]
      })
    }
  };
  const result = doPost(fakeEvent);
  Logger.log(result.getContent());
}