// Shared print-slip renderer for both the admin orders inbox and the POS
// register. Loaded via `<script src="/admin/print-slip.js">` from both
// admin/index.html and admin/pos.html so a single implementation stays in
// sync — otherwise the manual-reprint button in the admin inbox and the
// POS's ring-up print would fork over time.
//
// The renderer is CHANNEL-AWARE:
//   - order.order_channel === 'online' → the original slip: big pickup
//     code, wait estimate, "Pay at pickup".
//   - order.order_channel === 'pos' + dining_option 'takeout' → same big
//     pickup code + wait estimate, but the "Pay at pickup" line is dropped
//     (already handled at the register). Discount + cash tendered + change
//     lines appear when relevant. Cashier name in the meta.
//   - order.order_channel === 'pos' + dining_option 'dine_in' → the pickup
//     code demotes to a small "Ticket #NNNN" in the header meta, the
//     "Ready in N min" block becomes a bold DINE-IN label + cashier name,
//     no wait estimate.
//   - order._voided === true → red "VOIDED" watermark, items shown with
//     strikethrough, total rendered as `— VOID —`. Kitchen knows the
//     order was rung then cancelled and shouldn't be prepared.
//
// The caller passes its own i18n function so the file has no dependency
// on either page's LANG_STRINGS dict.
//   window.buildPrintSlip(order, { t: (key, params) => "..." })

(function () {
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Format an ISO timestamp in America/New_York, in a shape the ticket
  // reader expects. Falls back to raw string on invalid input.
  function nyDateTime(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      }).format(d);
    } catch (e) { return iso; }
  }

  function money(cents) {
    return '$' + ((Number(cents) || 0) / 100).toFixed(2);
  }

  function buildPrintSlip(o, opts) {
    const t = (opts && typeof opts.t === 'function') ? opts.t : function (k) { return k; };
    const isPOS      = o.order_channel === 'pos';
    const isDineIn   = isPOS && o.dining_option === 'dine_in';
    const isTakeout  = isPOS && o.dining_option === 'takeout';
    const isVoided   = !!o._voided;

    const slip = document.createElement('div');
    slip.className = 'print-slip' + (isVoided ? ' is-voided' : '');

    // ---- Header ----
    const header = document.createElement('div');
    header.className = 'print-header';
    // For POS + dine-in, demote the pickup code to a small "Ticket #NNNN".
    // For online + POS takeout, the pickup code gets its own dedicated
    // block below (unchanged behavior).
    const smallCode = isDineIn
      ? '<div>' + escapeHtml(t('print.ticketNumber', { code: o.pickup_code })) + '</div>'
      : '';
    header.innerHTML =
      '<div>' +
        '<div class="restaurant">Asian Street Gourmet · 亞洲街頭美食</div>' +
        '<div style="font-size:0.75rem;">84 Avenue O · Brooklyn 11204 · 917-723-6262</div>' +
      '</div>' +
      '<div class="meta">' +
        '<div>' + escapeHtml(nyDateTime(o.created_at)) + '</div>' +
        '<div>' + escapeHtml(t('print.orderNum', { id: o.id })) + '</div>' +
        smallCode +
        (o.cashier_name ? '<div>' + escapeHtml(t('print.cashier', { name: o.cashier_name })) + '</div>' : '') +
      '</div>';
    slip.appendChild(header);

    // ---- Voided watermark (POS-only, printed at void-reprint time) ----
    if (isVoided) {
      const vb = document.createElement('div');
      vb.className = 'voided-banner';
      vb.textContent = t('print.voided');
      slip.appendChild(vb);
    }

    // ---- Pickup-code / dining block ----
    if (isDineIn) {
      // Bold DINE-IN label replacing the pickup block. Cashier name shown
      // large — kitchen knows who to hand the food back to.
      const dineBlock = document.createElement('div');
      dineBlock.className = 'pickup-block dine-in';
      dineBlock.innerHTML =
        '<div>' +
          '<div class="pickup-label">' + escapeHtml(t('pos.dineIn')) + '</div>' +
          '<div class="pickup-code" style="font-size:1.4rem;">' + escapeHtml(o.cashier_name || '') + '</div>' +
        '</div>';
      slip.appendChild(dineBlock);
    } else {
      // Online + POS takeout: big pickup code + wait time. The
      // "Pay at pickup" line only shows for online orders (POS takeout has
      // already been rung at the register, payment is expected at counter).
      const pickup = document.createElement('div');
      pickup.className = 'pickup-block';
      const takeoutLabel = isTakeout
        ? '<div style="font-size:0.7rem;margin-top:0.2rem;text-transform:uppercase;letter-spacing:0.15em;">' + escapeHtml(t('pos.takeout')) + '</div>'
        : '<div style="font-size:0.7rem;margin-top:0.2rem;text-transform:uppercase;letter-spacing:0.15em;">' + escapeHtml(t('print.payAtPickup')) + '</div>';
      pickup.innerHTML =
        '<div>' +
          '<div class="pickup-label">' + escapeHtml(t('print.pickupCode')) + '</div>' +
          '<div class="pickup-code">' + escapeHtml(o.pickup_code) + '</div>' +
        '</div>' +
        '<div class="pickup-wait">' +
          '<div>' + escapeHtml(t('print.readyIn', { n: o.estimated_wait_min })) + '</div>' +
          takeoutLabel +
        '</div>';
      slip.appendChild(pickup);
    }

    // ---- Customer info row (walk-in-friendly) ----
    if (o.customer_name || o.customer_phone || o.customer_email) {
      const cust = document.createElement('div');
      cust.className = 'customer-row';
      let custHtml = '<span class="name">' + escapeHtml(o.customer_name || '') + '</span>';
      if (o.customer_phone) custHtml += ' · <span class="phone">' + escapeHtml(o.customer_phone) + '</span>';
      if (o.customer_email) custHtml += ' · ' + escapeHtml(o.customer_email);
      cust.innerHTML = custHtml;
      slip.appendChild(cust);
    }

    // ---- Item table ----
    const table = document.createElement('table');
    table.className = 'items';
    let rows = '<thead><tr><th>' + escapeHtml(t('print.colCode')) + '</th><th>' + escapeHtml(t('print.colQty')) + '</th><th>' + escapeHtml(t('print.colItem')) + '</th><th style="text-align:right;">' + escapeHtml(t('print.colPrice')) + '</th></tr></thead><tbody>';
    (o.items || []).forEach(function (it) {
      const rowStyle = isVoided ? 'style="text-decoration:line-through; color:#888;"' : '';
      rows +=
        '<tr ' + rowStyle + '>' +
          '<td class="code">' + escapeHtml(it.menu_code) + '</td>' +
          '<td class="qty">×' + it.quantity + '</td>' +
          '<td><span class="zh" style="font-family:\'Noto Serif TC\',serif;">' + escapeHtml(it.name_zh) + '</span> · ' + escapeHtml(it.name_en) + '</td>' +
          '<td class="price">' + money(it.line_total_cents) + '</td>' +
        '</tr>';
    });
    rows += '</tbody>';
    table.innerHTML = rows;
    slip.appendChild(table);

    // ---- Customer notes ----
    if (o.notes && String(o.notes).trim()) {
      const n = document.createElement('div');
      n.className = 'notes-block';
      n.innerHTML = '<div class="label">' + escapeHtml(t('print.customerNotes')) + '</div>' + escapeHtml(o.notes);
      slip.appendChild(n);
    }

    // ---- Totals block (subtotal / discount / tax / total, plus POS cash) ----
    const totalsWrap = document.createElement('div');
    totalsWrap.className = 'totals-wrap';
    // Show a subtotal line whenever there's a discount to report; otherwise
    // the single "Total" row is enough (and matches the pre-POS layout).
    const showBreakdown = (Number(o.discount_cents) || 0) > 0;
    if (showBreakdown) {
      totalsWrap.innerHTML +=
        '<div class="total-row" style="border-top:0; font-size:0.85rem;">' +
          '<span class="label">' + escapeHtml(t('print.subtotal')) + '</span>' +
          '<span class="amount">' + money(o.subtotal_cents) + '</span>' +
        '</div>';
      const pctLabel = (o.discount_pct != null)
        ? ' (' + o.discount_pct + '%)' : '';
      totalsWrap.innerHTML +=
        '<div class="total-row" style="border-top:0; font-size:0.85rem;">' +
          '<span class="label">' + escapeHtml(t('print.discount')) + escapeHtml(pctLabel) + '</span>' +
          '<span class="amount">−' + money(o.discount_cents) + '</span>' +
        '</div>';
      if ((Number(o.tax_cents) || 0) > 0) {
        totalsWrap.innerHTML +=
          '<div class="total-row" style="border-top:0; font-size:0.85rem;">' +
            '<span class="label">' + escapeHtml(t('print.tax')) + '</span>' +
            '<span class="amount">' + money(o.tax_cents) + '</span>' +
          '</div>';
      }
    }
    totalsWrap.innerHTML +=
      '<div class="total-row">' +
        '<span class="label">' + escapeHtml(t('print.total')) + '</span>' +
        '<span class="amount">' + (isVoided ? escapeHtml(t('print.voidTotal')) : money(o.total_cents)) + '</span>' +
      '</div>';
    // Cash tendered + change — only rendered when the cashier filled it in.
    if (o.cash_tendered_cents != null && !isVoided) {
      totalsWrap.innerHTML +=
        '<div class="total-row" style="border-top:0; font-size:0.85rem;">' +
          '<span class="label">' + escapeHtml(t('print.cashTendered')) + '</span>' +
          '<span class="amount">' + money(o.cash_tendered_cents) + '</span>' +
        '</div>' +
        '<div class="total-row" style="border-top:0; font-size:0.85rem; font-weight:600;">' +
          '<span class="label">' + escapeHtml(t('print.change')) + '</span>' +
          '<span class="amount">' + money(o.change_cents != null ? o.change_cents : Math.max(0, (o.cash_tendered_cents || 0) - (o.total_cents || 0))) + '</span>' +
        '</div>';
    }
    slip.appendChild(totalsWrap);

    // ---- Footer ----
    const footer = document.createElement('div');
    footer.className = 'footer';
    footer.innerHTML = escapeHtml(t('print.footer'));
    slip.appendChild(footer);

    return slip;
  }

  // Expose on window so both admin dashboards can use it without ES-module
  // plumbing.
  window.buildPrintSlip = buildPrintSlip;
})();
