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