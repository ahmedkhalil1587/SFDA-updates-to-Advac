/* =========================================================
   SFDA ⇄ Advac HIS comparison core (no DOM — usable in Node too)
   ========================================================= */
(function (root) {
  'use strict';

  const EMPTY_CODES = new Set(['', 'NULL', 'NONE', 'NAN', 'N/A', 'NA', '-', '0', 'NO SFDA CODE', 'NO CODE']);

  const str = v => (v === null || v === undefined) ? '' : String(v).trim();
  const normCode = v => {
    const s = str(v).toUpperCase().replace(/\s+/g, '');
    return EMPTY_CODES.has(s) ? '' : s;
  };
  const normGtin = v => {
    const s = str(v).replace(/\D/g, '').replace(/^0+/, '');
    return s.length >= 6 ? s : '';
  };
  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  };
  const r2 = n => Math.round(n * 100) / 100;

  /* pick a value from a row trying several header names (case-insensitive) */
  function getter(headers) {
    const map = {};
    headers.forEach(h => { map[String(h).trim().toLowerCase()] = h; });
    return (row, ...names) => {
      for (const n of names) {
        const k = map[n.toLowerCase()];
        if (k !== undefined && row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
      }
      return '';
    };
  }

  /* detect file type from its header row */
  function detectType(headers) {
    const h = headers.map(x => String(x).trim().toLowerCase());
    if (h.includes('itm_cd')) return 'his';
    if (h.includes('oldregisternumber')) return 'drugs';
    if (h.includes('registernumber') && (h.includes('drugtype') || h.includes('domainen'))) return 'herbal';
    if (h.includes('registernumber') && h.includes('price')) return 'drugs';
    if (h.includes('registernumber')) return 'herbal';
    return null;
  }

  /* pack count written in the HIS trade name, e.g. "...TABLETS-30", "30TABS", "5 AMP" */
  const UNIT_RX = /(\d+)\s*(?:TABS?|TABLETS?|TAB\.|CAPS?|CAPSULES?|CAPLETS?|AMPS?|AMPOULES?|SACHETS?|SACH|SUPPS?|SUPPOSITOR(?:Y|IES)|PCS|PIECES|VIALS?|PENS?|STRIPS?|LOZENGES?|LOZ|EFF)\b/;
  function packFromName(name) {
    const s = str(name).toUpperCase();
    let m = s.match(/[-–]\s*(\d{1,4})\s*$/);
    if (m) return parseInt(m[1], 10);
    m = s.match(UNIT_RX);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  /* ------------------------------------------------------- */
  function compare(hisRows, drugRows, herbRows, opts) {
    opts = Object.assign({ tolerancePct: 50, minDiff: 0.05 }, opts || {});

    /* ---- SFDA drugs indexes ---- */
    const dHead = drugRows.length ? Object.keys(drugRows[0]) : [];
    const gd = getter(dHead);
    const byNew = new Map(), byOld = new Map(), byGtin = new Map();
    drugRows.forEach(r => {
      const rec = {
        code: normCode(gd(r, 'registerNumber')),
        codeRaw: str(gd(r, 'registerNumber')),
        old: normCode(gd(r, 'oldRegisterNumber')),
        gtin: normGtin(gd(r, 'gtin')),
        gtinRaw: str(gd(r, 'gtin')),
        name: str(gd(r, 'tradeName')),
        sci: str(gd(r, 'scientificName')),
        pack: num(gd(r, 'packageSize')),
        size: num(gd(r, 'size')),
        sizeUnit: str(gd(r, 'sizeUnit.nameEn')),
        packType: str(gd(r, 'packageType.nameEn')),
        price: num(gd(r, 'price')),
        descCode: str(gd(r, 'descriptionCode')),
      };
      if (!rec.code) return;
      byNew.set(rec.code, rec);
      if (rec.old) { if (!byOld.has(rec.old)) byOld.set(rec.old, []); byOld.get(rec.old).push(rec); }
      if (rec.gtin) { if (!byGtin.has(rec.gtin)) byGtin.set(rec.gtin, []); byGtin.get(rec.gtin).push(rec); }
    });

    /* ---- SFDA herbal index ---- */
    const hbHead = herbRows.length ? Object.keys(herbRows[0]) : [];
    const ghb = getter(hbHead);
    const herb = new Map();
    herbRows.forEach(r => {
      const c = normCode(ghb(r, 'registerNumber'));
      if (c) herb.set(c, { code: c, name: str(ghb(r, 'tradeName')), type: str(ghb(r, 'drugType')) });
    });

    /* ---- HIS items (dedupe by ITM_CD, sum quantity) ---- */
    const hHead = hisRows.length ? Object.keys(hisRows[0]) : [];
    const gh = getter(hHead);
    const items = new Map();
    hisRows.forEach(r => {
      const id = str(gh(r, 'ITM_CD'));
      if (!id) return;
      const q = num(gh(r, 'Quantity', 'QTY', 'BAL', 'QONH1')) || 0;
      if (items.has(id)) { items.get(id).qty += q; return; }
      items.set(id, {
        id,
        codeRaw: str(gh(r, 'RegisterNumber', 'HM_NO')),
        code: normCode(gh(r, 'RegisterNumber', 'HM_NO')),
        gtinRaw: str(gh(r, 'GTIN')),
        gtin: normGtin(gh(r, 'GTIN')),
        name: str(gh(r, 'Trade Name', 'ITM_NM_EN')),
        sci: str(gh(r, 'ScientificName', 'ITM_BNM_AR')),
        price: num(gh(r, 'Public price', 'SPRC6')),
        group: str(gh(r, 'GenericOrBrand', 'SRV_CD')),
        qty: q,
      });
    });

    const res = {
      items: [], codeUpdates: [], gtinCodeSuggest: [], ambiguous: [], herbal: [], current: [],
      notFound: [], noCode: [], priceConfirmed: [], priceReview: [], priceNoSfda: [], gtinDiff: [],
      stats: {},
    };

    items.forEach(it => {
      let rec = null, status = '', note = '';

      if (it.code && byNew.has(it.code)) {
        rec = byNew.get(it.code); status = 'current';
        res.current.push(Object.assign({ rec }, it));
      } else if (it.code && byOld.has(it.code)) {
        const list = byOld.get(it.code);
        if (list.length === 1) {
          rec = list[0]; status = 'old';
          res.codeUpdates.push(Object.assign({ rec, newCode: rec.codeRaw }, it));
        } else {
          status = 'ambiguous';
          note = 'الكود القديم مرتبط بأكثر من كود جديد: ' + list.map(x => x.codeRaw).join(' / ');
          res.ambiguous.push(Object.assign({ candidates: list, note }, it));
        }
      } else if (it.code && herb.has(it.code)) {
        status = 'herbal';
        res.herbal.push(Object.assign({ hrec: herb.get(it.code) }, it));
      } else if (it.gtin && byGtin.has(it.gtin)) {
        const list = byGtin.get(it.gtin);
        if (list.length === 1) {
          rec = list[0]; status = 'gtin';
          res.gtinCodeSuggest.push(Object.assign({ rec, newCode: rec.codeRaw }, it));
        } else {
          status = 'ambiguous';
          note = 'الباركود مرتبط بأكثر من كود SFDA: ' + list.map(x => x.codeRaw).join(' / ');
          res.ambiguous.push(Object.assign({ candidates: list, note }, it));
        }
      } else if (!it.code) {
        status = 'nocode'; res.noCode.push(it);
      } else {
        status = 'notfound'; res.notFound.push(it);
      }

      it.status = status;
      it.rec = rec;
      res.items.push(it);

      /* ---- price + GTIN checks on resolved SFDA drug record ---- */
      if (!rec) return;

      if (rec.gtin && it.gtin !== rec.gtin) {
        res.gtinDiff.push(Object.assign({ rec }, it));
      }

      if (rec.price === null) { res.priceNoSfda.push(Object.assign({ rec }, it)); return; }
      const hp = it.price === null ? 0 : it.price;
      const sp = r2(rec.price);
      const diff = r2(sp - hp);
      if (Math.abs(diff) < Math.max(0.01, opts.minDiff)) return;

      const namePack = packFromName(it.name);
      const gtinEq = !!(rec.gtin && it.gtin === rec.gtin);
      let packState = 'unknown';
      if (namePack !== null && rec.pack !== null) packState = (namePack === rec.pack) ? 'match' : 'mismatch';
      const pct = hp > 0 ? (diff / hp) * 100 : null;

      const reasons = [];
      if (status === 'gtin') reasons.push('الكود مقترح من الباركود ولم يُحدَّث بعد');
      if (packState === 'mismatch') reasons.push(`حجم العلبة مختلف (الاسم ${namePack} / SFDA ${rec.pack})`);
      if (packState === 'unknown' && !gtinEq) reasons.push('لا يمكن تأكيد حجم العلبة (الاسم بدون عدد والباركود مختلف)');
      if (pct === null) reasons.push('سعر النظام صفر أو فارغ');
      else if (Math.abs(pct) > opts.tolerancePct) reasons.push(`فرق السعر كبير ${pct.toFixed(0)}%`);
      if (rec.pack && hp > 0 && Math.abs(hp * rec.pack - sp) / sp < 0.03 && rec.pack > 1)
        reasons.push('سعر النظام يساوي سعر الوحدة (السعر ÷ حجم العلبة)');

      const row = Object.assign({ rec, sp, hp, diff, pct, namePack, packState, gtinEq, reasons }, it);
      if (reasons.length === 0) res.priceConfirmed.push(row); else res.priceReview.push(row);
    });

    res.stats = {
      total: res.items.length,
      current: res.current.length,
      codeUpdates: res.codeUpdates.length,
      gtinCodeSuggest: res.gtinCodeSuggest.length,
      ambiguous: res.ambiguous.length,
      herbal: res.herbal.length,
      notFound: res.notFound.length,
      noCode: res.noCode.length,
      priceConfirmed: res.priceConfirmed.length,
      priceReview: res.priceReview.length,
      gtinDiff: res.gtinDiff.length,
      sfdaDrugs: byNew.size,
      sfdaHerbal: herb.size,
    };
    return res;
  }

  /* ---- SQL builders ---- */
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  const fmtPrice = n => (Math.round(n * 100) / 100).toFixed(2);

  function sqlCodeUpdates(rows) {
    const seen = new Set(), out = [];
    rows.forEach(r => {
      const key = r.codeRaw + '→' + r.newCode;
      if (seen.has(key)) return; seen.add(key);
      out.push(`UPDATE AZITMS SET HM_NO = ${q(r.newCode)} WHERE HM_NO = ${q(r.codeRaw)};  -- ${r.name.replace(/[\r\n]/g, ' ')}`);
    });
    return out;
  }
  function sqlCodeByItem(rows) {
    return rows.map(r => `UPDATE AZITMS SET HM_NO = ${q(r.newCode)} WHERE ITM_CD = ${q(r.id)};  -- ${r.name.replace(/[\r\n]/g, ' ')} (كان: ${r.codeRaw || 'فارغ'})`);
  }
  function sqlPrices(rows) {
    return rows.map(r => `UPDATE AZITMS SET SPRC6 = ${fmtPrice(r.sp)} WHERE ITM_CD = ${q(r.id)};  -- ${r.name.replace(/[\r\n]/g, ' ')} | ${r.hp} → ${fmtPrice(r.sp)}`);
  }
  function sqlGtin(rows) {
    return rows.map(r => `UPDATE AZITMS SET GTIN = ${q(r.rec.gtinRaw)} WHERE ITM_CD = ${q(r.id)};  -- ${r.name.replace(/[\r\n]/g, ' ')} (كان: ${r.gtinRaw || 'فارغ'})`);
  }

  const api = { compare, detectType, packFromName, normCode, normGtin, sqlCodeUpdates, sqlCodeByItem, sqlPrices, sqlGtin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SFDACore = api;
})(typeof window !== 'undefined' ? window : globalThis);
