/**
 * ============================================================
 * DATA TRACKING VENDOR TO DC -- APPS SCRIPT (GABUNGAN 6 MODUL)
 * ============================================================
 * File ini adalah gabungan modul1.js s/d modul6.js menjadi SATU file,
 * TANPA mengubah satu baris logika pun -- cuma menyatukan file supaya
 * lebih mudah dicari/di-backup. Urutan bagian di bawah SENGAJA dijaga
 * sama seperti urutan modul aslinya (1 -> 6), karena beberapa fungsi di
 * modul belakangan memang memanggil fungsi dari modul sebelumnya (semua
 * file dalam 1 project Apps Script otomatis berbagi 1 scope global,
 * jadi urutan section di sini murni untuk kemudahan membaca, bukan
 * soal wajib urutan eksekusi).
 *
 * Kalau butuh versi per-modul lagi (mis. untuk dokumentasi terpisah),
 * lihat riwayat file modul1.js s/d modul6.js sebelum digabung.
 *
 * DAFTAR ISI (cari pakai Ctrl+F ke tanda ===== nya):
 *   [1] MODUL 1 - ITEM NAME MAPPER
 *   [2] MODUL 2 - REPORT HARIAN PARSER
 *   [3] MODUL 3 - SURAT JALAN NEW PARSER
 *   [4] MODUL 4 - INTRANSIT / TERFULFILL MATCHER
 *   [5] MODUL 5 - ORCHESTRATOR
 *   [6] MODUL 6 - WEB APP ENDPOINT (UPDATE STATUS STOCK)
 * ============================================================
 */


// ================================================================
// BERKAS ASLI: modul1.js
// ================================================================
/**
 * ============================================================
 * MODUL 1 - ITEM NAME MAPPER (modul1 - itemnamemapper)
 * ============================================================
 * [VERSI PERBAIKAN LANJUTAN]
 * PERUBAHAN vs versi yang kamu paste:
 * - buildKey2Guess_() PUNYA 2 BUG yang ditemukan lewat simulasi:
 *   1. Kode default "24S" TERUS dipaksa ditambahkan meskipun ada marker
 *      kategori (KID/TUNIK/RIB/WK MYNO) yang ketemu. Ini SALAH untuk
 *      kategori WK MYNO dan RIB, yang di Master Item Name TIDAK PERNAH
 *      punya kode angka sama sekali (mis. key2 aslinya "ABU MISTY WK MYNO",
 *      BUKAN "ABU MISTY WK MYNO 24S"). Akibatnya SEMUA item kategori
 *      WK MYNO gagal exact-match, dan bahkan gagal fuzzy-match juga
 *      (karena tambahan " 24S" bikin panjang teks beda >3 karakter dari
 *      versi asli, kelewat dari threshold toleransi fuzzy) -- alhasil
 *      SELURUH data WK MYNO berpotensi hilang/gagal ke-tracking.
 *   2. Posisi sisip marker ("sebelum token terakhir") cuma benar KALAU
 *      token terakhir itu memang kode (24S/30S). Kalau tidak ada kode
 *      sama sekali (kasus WK MYNO/RIB), logika lama malah nyisipin
 *      marker DI TENGAH-TENGAH kata warna (mis. "ABU WK MYNO MISTY"),
 *      bukan di paling akhir ("ABU MISTY WK MYNO").
 *   PERBAIKAN: (1) kode default CUMA ditambahkan kalau TIDAK ADA marker
 *   ketemu sama sekali (item reguler selalu butuh kode, tapi begitu ada
 *   marker, kita percaya teks aslinya apa adanya -- di semua contoh nyata,
 *   kalau memang butuh kode, kodenya sudah pasti tertulis bareng markernya).
 *   (2) posisi sisip marker sekarang CEK DULU apakah token terakhir
 *   benar-benar kode -- kalau iya, sisip sebelum kode (di tengah);
 *   kalau tidak, taruh marker di PALING AKHIR. Sudah divalidasi lewat
 *   10 skenario (lama + baru) dan semuanya lolos.
 *
 * Fungsi: mencocokkan nama item dari sheet SURAT JALAN
 * (format tidak standar, mis. "HITAM 24S" + LENGAN "PANJANG")
 * ke nama item standar di sheet MASTER ITEM NAME
 * (kolom ITEM, mis. "HITAM 24S PJG M").
 *
 * STRATEGI 3 LAPIS (dari paling aman ke paling "menebak"):
 * 1. EXACT MATCH   - string sama persis (setelah dinormalisasi)
 * 2. ALIAS MATCH   - pakai tabel alias manual (sheet "ALIAS") untuk
 *                    singkatan/istilah yang konsisten (mis. BOTOL -> BTL)
 * 3. FUZZY MATCH   - toleransi typo asli (mis. CINAMON -> CINNAMON),
 *                    pakai jarak edit (Levenshtein), HANYA dibandingkan
 *                    dengan kandidat yang lengan+size-nya SAMA PERSIS,
 *                    supaya tidak salah nyasar ke item lain.
 *                    Hasil fuzzy match DITANDAI (fuzzy:true) supaya
 *                    tetap bisa dicek manual, bukan dipercaya buta.
 *
 * CARA PAKAI SEMENTARA (testing):
 * 1. Buka file DATA TRACKING HASIL AKHIR
 * 2. Extensions > Apps Script
 * 3. Paste kode ini
 * 4. (Opsional) Buat sheet baru "ALIAS" di file Master Item Name,
 *    isi 2 kolom: ALIAS | GANTI KE
 * 5. Jalankan fungsi testMapItemName() untuk uji coba
 * ============================================================
 */

const CONFIG = {
  MASTER_ITEM_SHEET_URL: 'https://docs.google.com/spreadsheets/d/1gNvg9N0TUc9CCuIHyTty-2owoV8wTZAnKYCayQc6KHc/edit',
  MASTER_ITEM_SHEET_NAME: 'MASTER ITEM NAME', // dicari exact match dulu, lalu fallback partial
  ALIAS_SHEET_NAME: 'ALIAS', // opsional -- kalau tidak ada, alias step dilewati
  FUZZY_MAX_DISTANCE: 3, // toleransi jarak edit maksimal untuk fuzzy match
};

/**
 * Normalisasi teks: uppercase, trim, rapikan spasi ganda.
 */
function normalizeText_(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Petakan kata LENGAN dari SURAT JALAN ke kode singkat yang dipakai
 * di kolom ITEM master (PDK / PJG).
 */
function mapLenganToCode_(lenganRaw) {
  const lengan = normalizeText_(lenganRaw);
  if (lengan.startsWith('PANJANG') || lengan === 'PJG') return 'PJG';
  if (lengan.startsWith('PENDEK') || lengan === 'PDK') return 'PDK';
  return lengan;
}

/**
 * Daftar "marker kategori" yang bisa nempel di nama item ATAU kolom lengan,
 * dan perlu disisipkan ke posisi yang benar di nama item standar.
 * Urutan array menentukan prioritas kalau ada beberapa yang cocok (jarang terjadi).
 */
const CATEGORY_MARKERS_ = [
  { words: ['KID', 'KIDS', 'ANAK'], canonical: 'KID' },
  { words: ['TUNIK'], canonical: 'TUNIK' },
  { words: ['RIB'], canonical: 'RIB' },
  { words: ['WK MYNO', 'WANGKY MYNO'], canonical: 'WK MYNO' }, // frasa 2 kata, ditangani khusus di bawah
];

/**
 * Cari & buang marker kategori (KID/TUNIK/RIB/WK MYNO/ANAK, dll) dari sebuah teks,
 * di manapun posisinya (depan/tengah/belakang). Mengembalikan teks yang sudah
 * dibersihkan + marker apa yang ketemu (kalau ada).
 *
 * @return {Object} { marker: string|null, cleaned: string }
 */
function extractMarkerAndClean_(text) {
  const words = normalizeText_(text).split(' ').filter(function (w) { return w !== ''; });
  let markerFound = null;
  const cleanedWords = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let matchedThisWord = false;

    if (!markerFound) {
      // Cek frasa 2 kata dulu (mis. "WK MYNO") sebelum cek kata tunggal
      if (w === 'WK' && words[i + 1] === 'MYNO') {
        markerFound = 'WK MYNO';
        i++; // skip juga kata "MYNO"
        matchedThisWord = true;
      } else if (w === 'WANGKY' && words[i + 1] === 'MYNO') {
        markerFound = 'WK MYNO';
        i++;
        matchedThisWord = true;
      } else {
        for (let m = 0; m < CATEGORY_MARKERS_.length; m++) {
          const def = CATEGORY_MARKERS_[m];
          if (def.words.indexOf(w) !== -1) {
            markerFound = def.canonical;
            matchedThisWord = true;
            break;
          }
        }
      }
    }

    if (!matchedThisWord) cleanedWords.push(w);
  }

  return { marker: markerFound, cleaned: cleanedWords.join(' ').trim() };
}

/**
 * Bangun "key2Guess" yang benar dari nama item + lengan mentah, dengan aturan:
 * 1. Cari marker kategori (KID/TUNIK/RIB/WK MYNO/ANAK) di NAMA ITEM ATAU LENGAN,
 *    di manapun posisinya -- buang dari teks aslinya.
 * 2. [FIX] Kode default "24S" HANYA ditambahkan kalau TIDAK ADA marker ketemu
 *    sama sekali (item reguler/polos). Kalau ADA marker, JANGAN paksa nambah
 *    kode -- beberapa kategori (WK MYNO, RIB) memang tidak pernah pakai kode
 *    angka sama sekali di Master Item Name, dan untuk kategori yang memang
 *    butuh kode (KID/TUNIK), kodenya sudah pasti tertulis bareng teks aslinya.
 * 3. [FIX] Kalau ada marker, CEK DULU apakah token terakhir (setelah langkah 2)
 *    benar-benar kode (24S/30S):
 *    - KALAU IYA: sisipkan marker SEBELUM kode (di tengah).
 *      Contoh: "HITAM 24S" + marker KID -> "HITAM KID 24S"
 *    - KALAU TIDAK: taruh marker di PALING AKHIR (bukan di tengah kata warna).
 *      Contoh: "ABU MISTY" + marker WK MYNO -> "ABU MISTY WK MYNO"
 *      (BUKAN "ABU WK MYNO MISTY" yang salah)
 *
 * @return {Object} { key2Guess: string, lenganCleaned: string }
 */
function buildKey2Guess_(itemNameRaw, lenganRaw) {
  const itemResult = extractMarkerAndClean_(itemNameRaw);
  const lenganResult = extractMarkerAndClean_(lenganRaw);

  const marker = itemResult.marker || lenganResult.marker;

  let colorPart = itemResult.cleaned;
  const tokensAwal = colorPart.split(' ').filter(function (w) { return w !== ''; });
  const lastTokenAwal = tokensAwal.length > 0 ? tokensAwal[tokensAwal.length - 1] : '';
  const sudahAdaKode = (lastTokenAwal === '24S' || lastTokenAwal === '30S');

  // [FIX #1] Kode default CUMA ditambahkan kalau TIDAK ADA marker sama sekali.
  if (!marker && !sudahAdaKode) {
    colorPart = (colorPart + ' 24S').trim();
  }

  if (marker) {
    const finalTokens = colorPart.split(' ').filter(function (w) { return w !== ''; });
    const lastTokenFinal = finalTokens.length > 0 ? finalTokens[finalTokens.length - 1] : '';
    const adaKodeDiAkhir = (lastTokenFinal === '24S' || lastTokenFinal === '30S');

    // [FIX #2] Sisip sebelum kode HANYA kalau token terakhir memang kode.
    if (adaKodeDiAkhir) {
      finalTokens.splice(finalTokens.length - 1, 0, marker);
    } else {
      finalTokens.push(marker);
    }
    colorPart = finalTokens.join(' ');
  }

  return { key2Guess: colorPart, lenganCleaned: lenganResult.cleaned };
}

/**
 * Load tabel alias (kata/frasa pengganti manual) dari sheet "ALIAS" di file Master Item Name.
 * Format: kolom A = ALIAS (cara nulis di Surat Jalan, boleh 1 kata atau frasa penuh),
 *         kolom B = GANTI KE (istilah standar / KEY2 yang sesuai).
 * Kalau sheet tidak ada, kembalikan Map kosong (fitur ini opsional).
 *
 * @return {Object} { direct: Map<alias, gantiKe>, bySortedWords: Map<sortedAlias, gantiKe> }
 */
function loadAliasMap_(ss) {
  const direct = new Map();
  const bySortedWords = new Map();
  const sheet = ss.getSheetByName(CONFIG.ALIAS_SHEET_NAME);
  if (!sheet) return { direct: direct, bySortedWords: bySortedWords };

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const alias = normalizeText_(data[i][0]);
    const gantiKe = normalizeText_(data[i][1]);
    if (alias && gantiKe) {
      direct.set(alias, gantiKe);
      const sortedAlias = alias.split(' ').sort().join(' ');
      bySortedWords.set(sortedAlias, gantiKe);
    }
  }
  return { direct: direct, bySortedWords: bySortedWords };
}

/**
 * Terapkan alias ke sebuah teks. Coba beberapa cara berurutan:
 * 1. FRASA PENUH persis
 * 2. FRASA PENUH urutan kata bebas
 * 3. KATA PER KATA
 *
 * @param {Object} aliasMap - { direct: Map, bySortedWords: Map }
 */
function applyAliasSubstitution_(text, aliasMap) {
  if (aliasMap.direct.size === 0) return text;
  const normalized = normalizeText_(text);

  if (aliasMap.direct.has(normalized)) {
    return aliasMap.direct.get(normalized);
  }

  const sortedNormalized = normalized.split(' ').sort().join(' ');
  if (aliasMap.bySortedWords.has(sortedNormalized)) {
    return aliasMap.bySortedWords.get(sortedNormalized);
  }

  const words = normalized.split(' ');
  const replaced = words.map(function (w) {
    return aliasMap.direct.has(w) ? aliasMap.direct.get(w) : w;
  });
  return replaced.join(' ');
}

/**
 * Hitung jarak edit (Levenshtein distance) antara 2 string.
 */
function levenshteinDistance_(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push([i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],
          dp[i][j - 1],
          dp[i - 1][j - 1]
        );
      }
    }
  }
  return dp[m][n];
}

/**
 * Pisahkan ITEM jadi { key2, lenganCode, size }.
 */
const SIZE_TOKENS_ = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];
function deriveKey2FromItem_(itemNorm) {
  const tokens = itemNorm.split(' ').filter(function (t) { return t !== ''; });
  let size = '';
  if (tokens.length > 0 && SIZE_TOKENS_.indexOf(tokens[tokens.length - 1]) !== -1) {
    size = tokens.pop();
  }
  let lenganCode = '';
  if (tokens.length > 0) {
    const lastTok = tokens[tokens.length - 1];
    if (lastTok === 'PDK' || lastTok === 'PENDEK') {
      lenganCode = 'PDK';
      tokens.pop();
    } else if (lastTok === 'PJG' || lastTok === 'PANJANG') {
      lenganCode = 'PJG';
      tokens.pop();
    }
  }
  return { key2: tokens.join(' '), lenganCode: lenganCode, size: size };
}

/**
 * Load seluruh data Master Item Name ke dalam struktur untuk pencarian.
 * SKEMA SHEET (4 kolom): KATEGORI | WARNA | KEY | ITEM
 */
function loadItemMasterMap_() {
  const ss = SpreadsheetApp.openByUrl(CONFIG.MASTER_ITEM_SHEET_URL);
  const sheet = ss.getSheetByName(CONFIG.MASTER_ITEM_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + CONFIG.MASTER_ITEM_SHEET_NAME + '" tidak ditemukan di file Master Item Name.');
  }

  const data = sheet.getDataRange().getValues();
  const exactMap = new Map();
  const entries = [];
  const synonymMap = new Map();
  const synonymSetMap = new Map();
  const warnaEntriesMap = new Map();

  function sortedWords_(text) {
    return normalizeText_(text).split(' ').sort().join(' ');
  }

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const kategori = row[0];
    const warna    = row[1];
    const keyCol   = row[2];
    const item     = row[3];

    if (!item) continue;

    const itemNorm = normalizeText_(item);
    const derived = deriveKey2FromItem_(itemNorm);
    const key2Norm = derived.key2;

    const searchKey = normalizeText_(key2Norm + ' ' + derived.lenganCode + ' ' + derived.size);
    const entryData = { item: item, kategori: kategori, warna: warna, key2: key2Norm, lenganCode: derived.lenganCode, size: derived.size };
    exactMap.set(searchKey, entryData);
    entries.push(entryData);

    if (keyCol) {
      String(keyCol).split(',').forEach(function (tok) {
        const t = normalizeText_(tok);
        if (!t) return;
        synonymMap.set(t, key2Norm);
        synonymSetMap.set(sortedWords_(t), key2Norm);
      });
    }
    if (warna) {
      const w = normalizeText_(warna);
      synonymMap.set(w, key2Norm);
      synonymSetMap.set(sortedWords_(w), key2Norm);
      warnaEntriesMap.set(w, key2Norm);
    }
  }

  const aliasMap = loadAliasMap_(ss);
  const warnaEntries = Array.from(warnaEntriesMap.entries()).map(function (pair) {
    return { warna: pair[0], key2: pair[1] };
  });

  return { exactMap: exactMap, entries: entries, synonymMap: synonymMap, synonymSetMap: synonymSetMap, aliasMap: aliasMap, warnaEntries: warnaEntries };
}

/**
 * Fungsi utama: cocokkan 1 baris data dari SURAT JALAN ke nama item standar.
 */
function mapItemName_(itemNameRaw, lenganRaw, sizeRaw, masterData) {
  const exactMap = masterData.exactMap;
  const synonymMap = masterData.synonymMap;
  const synonymSetMap = masterData.synonymSetMap;
  const aliasMap = masterData.aliasMap;
  const entries = masterData.entries;
  const warnaEntries = masterData.warnaEntries || [];

  const size = normalizeText_(sizeRaw);

  const built = buildKey2Guess_(itemNameRaw, lenganRaw);
  const key2Guess = built.key2Guess;
  const lenganCode = mapLenganToCode_(built.lenganCleaned);

  function resolveKey2_(key2Text) {
    const withLengan = normalizeText_(key2Text + ' ' + lenganCode + ' ' + size);
    if (exactMap.has(withLengan)) return exactMap.get(withLengan).item;

    const withoutLengan = normalizeText_(key2Text + ' ' + size);
    if (exactMap.has(withoutLengan)) return exactMap.get(withoutLengan).item;

    return null;
  }

  const searchKey = normalizeText_(key2Guess + ' ' + lenganCode + ' ' + size);
  const exactResult = resolveKey2_(key2Guess);
  if (exactResult) {
    return { matched: true, item: exactResult, method: 'exact', note: '' };
  }

  if (synonymMap.has(key2Guess)) {
    const resolvedKey2 = synonymMap.get(key2Guess);
    const hasil = resolveKey2_(resolvedKey2);
    if (hasil) {
      return { matched: true, item: hasil, method: 'key_synonym', note: 'sinonim KEY: "' + itemNameRaw + '" -> "' + resolvedKey2 + '"' };
    }
  }

  const sortedGuess = key2Guess.split(' ').sort().join(' ');
  if (synonymSetMap.has(sortedGuess)) {
    const resolvedKey2 = synonymSetMap.get(sortedGuess);
    const hasil = resolveKey2_(resolvedKey2);
    if (hasil) {
      return { matched: true, item: hasil, method: 'key_synonym_unordered', note: 'sinonim KEY (urutan beda): "' + itemNameRaw + '" -> "' + resolvedKey2 + '"' };
    }
  }

  const key2Aliased = applyAliasSubstitution_(key2Guess, aliasMap);
  if (key2Aliased !== key2Guess) {
    const hasil = resolveKey2_(key2Aliased);
    if (hasil) {
      return { matched: true, item: hasil, method: 'alias', note: 'via alias manual: "' + key2Guess + '" -> "' + key2Aliased + '"' };
    }
  }

  let bestCandidate = null;
  let bestDistance = Infinity;
  let bestSource = null;

  for (let i = 0; i < warnaEntries.length; i++) {
    const w = warnaEntries[i];
    if (w.warna.charAt(0) !== key2Guess.charAt(0)) continue;
    if (Math.abs(w.warna.length - key2Guess.length) > 3) continue;

    const dist = levenshteinDistance_(key2Guess, w.warna);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestCandidate = w.key2;
      bestSource = 'warna: "' + w.warna + '"';
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.lenganCode !== lenganCode || e.size !== size) continue;
    if (e.key2.charAt(0) !== key2Guess.charAt(0)) continue;
    if (Math.abs(e.key2.length - key2Guess.length) > 3) continue;

    const dist = levenshteinDistance_(key2Guess, e.key2);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestCandidate = e.key2;
      bestSource = 'key2: "' + e.key2 + '"';
    }
  }

  if (bestCandidate && bestDistance <= CONFIG.FUZZY_MAX_DISTANCE) {
    const fuzzyResult = resolveKey2_(bestCandidate);
    if (fuzzyResult) {
      return {
        matched: true,
        item: fuzzyResult,
        method: 'fuzzy',
        note: 'fuzzy match (jarak edit: ' + bestDistance + ', dibandingkan ke ' + bestSource + ') dari "' + itemNameRaw + '" -- TOLONG DICEK ULANG'
      };
    }
  }

  return {
    matched: false,
    item: itemNameRaw + ' ' + lenganRaw + ' ' + sizeRaw + ' (TIDAK DITEMUKAN DI MASTER)',
    method: 'none',
    note: 'searchKey dicoba: "' + searchKey + '"'
  };
}

/**
 * ============================================================
 * FUNGSI CEK WARNA
 * ============================================================
 */
function cekWarnaMaster(daftarWarnaDicek) {
  const ss = SpreadsheetApp.openByUrl(CONFIG.MASTER_ITEM_SHEET_URL);
  const sheet = ss.getSheetByName(CONFIG.MASTER_ITEM_SHEET_NAME);
  const data = sheet.getDataRange().getValues();

  const uniqueWarna = new Map();
  const uniqueKey2 = new Map();
  for (let i = 1; i < data.length; i++) {
    const warna = data[i][1];
    const key2 = data[i][3];
    if (warna) uniqueWarna.set(normalizeText_(warna), warna);
    if (key2) uniqueKey2.set(normalizeText_(key2), key2);
  }

  daftarWarnaDicek.forEach(function (query) {
    const q = normalizeText_(query);
    Logger.log('===== CEK: "' + query + '" =====');

    if (uniqueWarna.has(q)) {
      Logger.log('  -> DITEMUKAN sebagai WARNA sendiri: "' + uniqueWarna.get(q) + '"');
    }
    if (uniqueKey2.has(q)) {
      Logger.log('  -> DITEMUKAN sebagai KEY2 sendiri: "' + uniqueKey2.get(q) + '"');
    }
    if (!uniqueWarna.has(q) && !uniqueKey2.has(q)) {
      Logger.log('  -> TIDAK DITEMUKAN persis. Kandidat mirip (jarak edit terdekat):');
      const semuaKandidat = Array.from(uniqueWarna.values()).concat(Array.from(uniqueKey2.values()));
      const withDist = semuaKandidat.map(function (c) {
        return { text: c, dist: levenshteinDistance_(q, normalizeText_(c)) };
      });
      withDist.sort(function (a, b) { return a.dist - b.dist; });
      const seen = new Set();
      let shown = 0;
      for (let i = 0; i < withDist.length && shown < 5; i++) {
        if (seen.has(withDist[i].text)) continue;
        seen.add(withDist[i].text);
        Logger.log('     - "' + withDist[i].text + '" (jarak edit: ' + withDist[i].dist + ')');
        shown++;
      }
    }
  });
}

/**
 * ============================================================
 * FUNGSI TES
 * ============================================================
 */
function testMapItemName() {
  const masterData = loadItemMasterMap_();
  Logger.log('Total entri exact di master: ' + masterData.exactMap.size);
  Logger.log('Total sinonim dari kolom KEY: ' + masterData.synonymMap.size);
  Logger.log('Total WARNA unik (buat fuzzy): ' + masterData.warnaEntries.length);
  Logger.log('Total alias manual: ' + masterData.aliasMap.direct.size);

  const contohTes = [
    { itemName: 'HITAM 24S', lengan: 'PANJANG', size: 'M' },
    { itemName: 'CREAM 24S', lengan: 'PENDEK', size: 'L' },
    { itemName: 'HIJAU BOTOL 24S', lengan: 'PENDEK', size: '2XL' },
    { itemName: 'CINAMON 24S', lengan: 'PANJANG', size: 'S' },
    { itemName: 'FANTA 24S', lengan: 'PENDEK', size: 'M' },
    { itemName: 'KUNING BUSUK 24S', lengan: 'PANJANG', size: 'L' },
    { itemName: 'GREEN TNI 24S', lengan: 'PENDEK', size: 'XL' },
    { itemName: 'HITAM 24S', lengan: 'PDK KIDS', size: 'XS' },
    { itemName: 'HITAM KID 24S', lengan: 'PDK KID', size: 'XS' },
    { itemName: 'KIDS TOSCA 24S', lengan: 'PENDEK', size: 'S' },
    { itemName: 'CREAM ANAK 24S', lengan: 'PENDEK', size: 'XS' },
    { itemName: 'BLUSH RED', lengan: 'PANJANG', size: 'L' },
    { itemName: 'FUCIHA 24S', lengan: 'PENDEK', size: 'L' },
    { itemName: 'FUCHCIA 24S', lengan: 'PENDEK', size: 'M' },
    { itemName: 'ABU MISTY WK MYNO', lengan: 'PENDEK', size: 'S' },
    { itemName: 'HIJAU TNI WK MYNO', lengan: 'PANJANG', size: 'M' },
    { itemName: 'ABU TUA RIB', lengan: 'PANJANG', size: 'S' },
    { itemName: 'HITAM RIB', lengan: 'PANJANG', size: 'L' },
  ];

  contohTes.forEach(function (t) {
    const hasil = mapItemName_(t.itemName, t.lengan, t.size, masterData);
    Logger.log(
      'INPUT: ' + t.itemName + ' | ' + t.lengan + ' | ' + t.size +
      ' --> [' + hasil.method + '] ' + (hasil.matched ? hasil.item : 'GAGAL: ' + hasil.item) +
      (hasil.note ? ' (' + hasil.note + ')' : '')
    );
  });

  Logger.log('--- Tes khusus kasus REPORT HARIAN (lengan kata penuh, sudah nempel di ITEM) ---');
  const contohReportHarian = [
    'MERAH CABE 24S KID PANJANG M',
    'TURKIS 24S KID PANJANG M',
    'TURKIS 24S PENDEK S',
    'COKLAT SUSU TUNIK 24S PANJANG L',
    'ABU MISTY WK MYNO PENDEK S'
  ];
  contohReportHarian.forEach(function (itemTeksLengkap) {
    const parsed = deriveKey2FromItem_(normalizeText_(itemTeksLengkap));
    const hasil = mapItemName_(parsed.key2, parsed.lenganCode, parsed.size, masterData);
    Logger.log(
      'INPUT: "' + itemTeksLengkap + '" -> key2="' + parsed.key2 + '", lengan="' + parsed.lenganCode + '", size="' + parsed.size + '"' +
      ' --> [' + hasil.method + '] ' + (hasil.matched ? hasil.item : 'GAGAL: ' + hasil.item)
    );
  });
}

function testCekWarnaMaster() {
  cekWarnaMaster([
    'FUCHSIA',
    'HIJAU BOTOL SPECIAL',
    'HIJAU FUJI',
    'HONEY',
    'HIJAU TNI WK MYNO'
  ]);
}

// ================================================================
// BERKAS ASLI: modul2.js
// ================================================================
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

// ================================================================
// BERKAS ASLI: modul3.js
// ================================================================
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

// ================================================================
// BERKAS ASLI: modul4.js
// ================================================================
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

  let vendorCol = null, jumlahKoliCol = null, shippingCol = null, ketHppCol = null;

  for (let c = 0; c < rowValues.length; c++) {
    const text = normalizeText_(rowValues[c]);
    if (!text) continue;
    if (text === 'VENDOR') vendorCol = c + 1;
    if (text.indexOf('KOLI') !== -1) jumlahKoliCol = c + 1;
    if (text.indexOf('SHIPPING') !== -1) shippingCol = c + 1;
    // [BARU] kolom "Ket Hpp" -- template baru di sheet INTRANSIT, checkbox per PO,
    // dipakai bareng LINK HPP di sheet DASHBOARD untuk menentukan STATUS HPP gabungan.
    if (text.indexOf('HPP') !== -1) ketHppCol = c + 1;
  }

  const scanStartCol = nomorPOCol + 1;

  return { headerRow, nomorPOCol, vendorCol, jumlahKoliCol, shippingCol, ketHppCol, scanStartCol };
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
    // [BARU] "Ket Hpp" -- checkbox TRUE/FALSE per PO (bukan per koli). null kalau
    // kolomnya tidak ada di sheet ini (template lama) atau selnya bukan boolean valid.
    const ketHppRaw = header.ketHppCol ? dataValues[startRow0][header.ketHppCol - 1] : '';
    const ketHpp = isBooleanValue_(ketHppRaw) ? toBooleanValue_(ketHppRaw) : null;

    const blockKoliStatusMap = parseKoliStatusInBlock_(dataValues, startRow0, endRow0, header.scanStartCol);

    if (!groupedMap.has(matchKey)) {
      groupedMap.set(matchKey, {
        vendor: vendor,
        nomorPORaw: normalizedPO,
        matchKey: matchKey,
        jumlahKoli: jumlahKoli,
        ketHpp: ketHpp,
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
 * STATUS HPP -- v4: GABUNGAN 2 SUMBER (DASHBOARD + INTRANSIT "Ket Hpp")
 * ============================================================
 * [BARU v4 -- arahan 25/9/2026] STATUS HPP sekarang menggabungkan DUA sinyal,
 * karena mengandalkan salah satunya saja terbukti bisa salah:
 * 1. Sheet DASHBOARD (file INBOUND): kolom LINK HPP TERISI atau KOSONG per PO
 *    (bukan cuma "ada barisnya" seperti versi v3 -- itu yang ternyata salah).
 * 2. Sheet INTRANSIT (file INBOUND): kolom baru "Ket Hpp" (checkbox per PO,
 *    BUKAN per koli -- dibaca dari baris pertama tiap blok PO, sama seperti
 *    VENDOR/JUMLAH KOLI).
 *
 * Aturan gabungannya:
 *   - DASHBOARD bilang ADA (LINK HPP terisi) DAN Ket Hpp tercentang TRUE
 *       -> 'ADA HPP'
 *   - DASHBOARD bilang TIDAK ADA (LINK HPP kosong) DAN Ket Hpp TIDAK
 *     tercentang FALSE
 *       -> 'BELUM ADA HPP'
 *   - SELAIN itu (dua sinyal tidak sepakat, atau salah satu/keduanya tidak
 *     ketemu sama sekali) -> 'CEK HPP' (perlu dicek manual, bukan ditebak).
 */

const CONFIG_MODUL4_HPP = {
  DASHBOARD_SHEET_NAME: 'DASHBOARD',
  NOMOR_PO_HEADER_TEXT: 'NOMOR PO',
  LINK_HPP_HEADER_TEXT: 'LINK HPP',
};

/**
 * [v4] Load daftar PO dari sheet DASHBOARD, SEKARANG JUGA merekam apakah
 * kolom LINK HPP terisi atau kosong per PO (bukan cuma kehadiran baris).
 */
function loadHppStatusData_() {
  const ss = SpreadsheetApp.openByUrl(CONFIG_MODUL4.INBOUND_SHEET_URL);
  const sheet = findSheetByPartialName_(ss, CONFIG_MODUL4_HPP.DASHBOARD_SHEET_NAME);
  if (!sheet) {
    Logger.log('  [INFO HPP] Sheet "' + CONFIG_MODUL4_HPP.DASHBOARD_SHEET_NAME + '" tidak ditemukan -- sisi DASHBOARD utk STATUS HPP akan kosong (fallback ke CEK HPP).');
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

  // [BARU v4] cari kolom LINK HPP di baris header yang sama.
  let linkHppCol = null;
  const headerRowValues = dataValues[headerRow - 1] || [];
  for (let c = 0; c < headerRowValues.length; c++) {
    if (normalizeText_(headerRowValues[c]).indexOf(CONFIG_MODUL4_HPP.LINK_HPP_HEADER_TEXT) !== -1) {
      linkHppCol = c + 1;
      break;
    }
  }
  if (!linkHppCol) {
    Logger.log('  [WARNING HPP] Header "LINK HPP" tidak ditemukan di sheet DASHBOARD -- sisi DASHBOARD akan dianggap tidak ketemu (CEK HPP) utk semua PO.');
  }

  const result = [];
  for (let r = headerRow; r < dataValues.length; r++) {
    const nomorPORaw = dataValues[r][nomorPOCol - 1];
    if (!nomorPORaw || String(nomorPORaw).trim() === '') continue;
    const nomorPOText = String(nomorPORaw).trim();
    const linkHppVal = linkHppCol ? dataValues[r][linkHppCol - 1] : '';
    const hasLinkHpp = linkHppVal !== null && linkHppVal !== undefined && String(linkHppVal).trim() !== '';

    result.push({
      matchKey: stripNonAlnum_(normalizePOForGrouping_(nomorPOText)),
      nomorPORaw: nomorPOText,
      hasLinkHpp: hasLinkHpp, // [BARU v4]
    });
  }

  const jumlahTerisi = result.filter(function (r) { return r.hasLinkHpp; }).length;
  Logger.log('  Sheet DASHBOARD (HPP): ' + result.length + ' baris PO terbaca, ' + jumlahTerisi + ' dengan LINK HPP terisi.');
  return result;
}

/**
 * Cari 1 entri di sebuah daftar {matchKey,...} yang paling cocok dengan salah
 * satu kandidat nomor PO (pencocokan prefix dua arah, overlap terpanjang).
 * Dipakai untuk sisi DASHBOARD maupun sisi INTRANSIT pada getHppStatusGabungan_.
 */
function findBestMatchGeneric_(daftar, candidatePOs) {
  const uniqueCandidates = (candidatePOs || [])
    .map(function (c) { return c ? String(c).trim() : ''; })
    .filter(function (c) { return c !== ''; })
    .filter(function (c, idx, arr) { return arr.indexOf(c) === idx; });

  for (let i = 0; i < uniqueCandidates.length; i++) {
    const target = stripNonAlnum_(uniqueCandidates[i]);
    if (!target) continue;
    let bestMatch = null, bestLength = -1;
    for (let j = 0; j < daftar.length; j++) {
      const candidate = daftar[j].matchKey;
      if (!candidate) continue;
      const isPrefixForward = target.indexOf(candidate) === 0;
      const isPrefixBackward = !isPrefixForward && candidate.indexOf(target) === 0;
      if (isPrefixForward || isPrefixBackward) {
        const overlapLength = Math.min(candidate.length, target.length);
        if (overlapLength > bestLength) { bestLength = overlapLength; bestMatch = daftar[j]; }
      }
    }
    if (bestMatch) return { match: bestMatch, matchedUsing: uniqueCandidates[i] };
  }
  return { match: null, matchedUsing: null };
}

/**
 * [BARU v4] Gabungkan sinyal DASHBOARD (LINK HPP) + INTRANSIT (Ket Hpp) jadi
 * satu STATUS HPP akhir: 'ADA HPP' / 'BELUM ADA HPP' / 'CEK HPP'.
 * Lihat penjelasan aturan gabungan di komentar bagian atas section ini.
 */
function getHppStatusGabungan_(hppData, intransitData, candidatePOs) {
  const dash = findBestMatchGeneric_(hppData, candidatePOs);
  const intr = findBestMatchGeneric_(intransitData, candidatePOs);

  const dashAda = dash.match ? dash.match.hasLinkHpp : null; // true/false/null (null = PO tidak ketemu di DASHBOARD)
  const ketHpp = intr.match ? intr.match.ketHpp : null;      // true/false/null (null = PO/kolom tidak ketemu di INTRANSIT)

  let status;
  if (dashAda === true && ketHpp === true) status = 'ADA HPP';
  else if (dashAda === false && ketHpp === false) status = 'BELUM ADA HPP';
  else status = 'CEK HPP';

  return {
    status: status,
    dashboardAda: dashAda,
    intransitKetHpp: ketHpp,
    matchedUsingDashboard: dash.matchedUsing,
    matchedUsingIntransit: intr.matchedUsing,
  };
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

  Logger.log('=== CEK STATUS HPP (gabungan DASHBOARD + INTRANSIT "Ket Hpp") ===');
  const hasilHpp = getHppStatusGabungan_(hppData, intransitData, kandidat);
  Logger.log('  DASHBOARD (LINK HPP terisi?): ' + hasilHpp.dashboardAda + ' (cocok lewat "' + hasilHpp.matchedUsingDashboard + '")');
  Logger.log('  INTRANSIT (Ket Hpp tercentang?): ' + hasilHpp.intransitKetHpp + ' (cocok lewat "' + hasilHpp.matchedUsingIntransit + '")');
  Logger.log('  => STATUS HPP AKHIR: ' + hasilHpp.status);
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

// ================================================================
// BERKAS ASLI: modul5.js
// ================================================================
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

  // [BARU v4] Status HPP -- gabungan DASHBOARD (LINK HPP) + INTRANSIT (Ket Hpp),
  // hasilnya salah satu dari 'ADA HPP' / 'BELUM ADA HPP' / 'CEK HPP' (lihat Modul 4).
  const hppResult = getHppStatusGabungan_(hppData || [], intransitData || [], candidates);
  const statusHppStr = hppResult.status;
  Logger.log('  [HPP] PO "' + nomorPO + '" -> ' + statusHppStr +
    ' (DASHBOARD LINK HPP terisi: ' + hppResult.dashboardAda + ' via "' + hppResult.matchedUsingDashboard + '"' +
    ', INTRANSIT Ket Hpp: ' + hppResult.intransitKetHpp + ' via "' + hppResult.matchedUsingIntransit + '")');

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

// ================================================================
// BERKAS ASLI: modul6.js
// ================================================================
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
