/*
 * Dota Mate: набор общих блоков интерфейса (только строки HTML, без состояния).
 * Одни и те же метрики, панели, значки, графики и пустые состояния используют дашборд, профиль и другие разделы,
 * поэтому выглядят одинаково. Стили в css/kit.css, цвета и размеры в css/tokens.css.
 * Все подписи экранируются здесь, вызывающий код передаёт обычный текст (кроме полей *Html).
 */
(function (root) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ico = function (n) { return '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"/></svg>'; };
  var TONES = { ok: 1, warn: 1, bad: 1, info: 1, accent: 1, neutral: 1 };
  var tone = function (t) { return TONES[t] ? t : 'neutral'; };
  var tipAttr = function (t) { return t ? ' data-tip="' + esc(t) + '"' : ''; };

  /** Значок состояния. tone: ok | warn | bad | info | accent | neutral. */
  function badge(t, text, tip) { return '<span class="kb kb-' + tone(t) + '"' + tipAttr(tip) + '>' + esc(text) + '</span>'; }

  /** Плитка показателя. o: {label, value, sub, tone, tip, trend:'up'|'down'}. value уже строка. */
  function metric(o) {
    return '<div class="km km-' + tone(o.tone) + '"' + tipAttr(o.tip) + ' role="listitem"><span class="km-l">' + esc(o.label) + '</span><b class="km-v">' + esc(o.value) + '</b>' +
      (o.sub ? '<span class="km-s">' + esc(o.sub) + '</span>' : '<span class="km-s"></span>') + '</div>';
  }

  /** Панель с заголовком. o: {title, meta, actionHtml, bodyHtml, cls, id, tip}. */
  function panel(o) {
    return '<section class="kp ' + (o.cls || '') + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + '><header class="kp-h"><div class="kp-t"><h2>' + esc(o.title) + '</h2>' +
      (o.meta ? '<span class="kp-m"' + tipAttr(o.metaTip) + '>' + esc(o.meta) + '</span>' : '') + '</div>' + (o.actionHtml ? '<div class="kp-a">' + o.actionHtml + '</div>' : '') + '</header><div class="kp-b">' + o.bodyHtml + '</div></section>';
  }

  function empty(o) {
    return '<div class="ke">' + (o.icon ? ico(o.icon) : '') + '<b>' + esc(o.title) + '</b>' + (o.text ? '<p>' + esc(o.text) + '</p>' : '') + (o.actionHtml ? '<div class="actions">' + o.actionHtml + '</div>' : '') + '</div>';
  }
  function skeleton(n, h) { var s = ''; for (var i = 0; i < (n || 3); i++) s += '<div class="skel" style="height:' + (h || 44) + 'px"></div>'; return '<div class="ks" aria-busy="true" role="status"><span class="sr-only">Загружаю…</span>' + s + '</div>'; }

  /** Распределение по категориям одной полосой и легендой. items: [{label, n, tone, tip}]. */
  function distribution(items, o) {
    o = o || {};
    var total = items.reduce(function (a, i) { return a + i.n; }, 0);
    if (!total) return empty({ icon: 'shield', title: o.emptyTitle || 'Пока нет данных', text: o.emptyText || '' });
    var bar = items.filter(function (i) { return i.n > 0; }).map(function (i) {
      return '<i class="kd-s kd-' + tone(i.tone) + '" style="flex:' + i.n + '"' + tipAttr(i.label + ': ' + i.n + ' из ' + total) + '></i>';
    }).join('');
    var rows = items.map(function (i) {
      var pct = Math.round(i.n / total * 100);
      return '<li' + tipAttr(i.tip) + '><span class="kd-d kd-' + tone(i.tone) + '"></span><span class="kd-n">' + esc(i.label) + '</span><b>' + i.n + '</b><span class="kd-p">' + pct + '%</span></li>';
    }).join('');
    return '<div class="kd" role="group" aria-label="' + esc(o.label || 'Распределение') + '"><div class="kd-bar">' + bar + '</div><ul class="kd-l">' + rows + '</ul></div>';
  }

  /**
   * Линейный график. values: числа (null = пропуск), o: {min, max, ref (линия), unit, fmt(v), label(i) -> подсказка, h}.
   * Рисуется inline SVG, масштабируется по ширине контейнера; у каждой точки своя подсказка.
   */
  function spark(values, o) {
    o = o || {};
    var W = 320, H = o.h || 96, pl = 30, pr = 8, pt = 10, pb = 8;
    var vs = values.filter(function (v) { return v != null; });
    if (vs.length < 2) return '';
    var lo = o.min != null ? o.min : Math.min.apply(null, vs), hi = o.max != null ? o.max : Math.max.apply(null, vs);
    if (hi === lo) { hi += 1; lo -= 1; }
    var n = values.length, fmt = o.fmt || function (v) { return String(Math.round(v * 10) / 10); };
    var x = function (i) { return pl + (W - pl - pr) * (n <= 1 ? .5 : i / (n - 1)); };
    var y = function (v) { return pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo)); };
    var d = '', pen = false, dots = '';
    values.forEach(function (v, i) {
      if (v == null) { pen = false; return; }
      d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true;
      dots += '<circle class="ks-pt" cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="3.2"' + tipAttr(o.label ? o.label(i, v) : fmt(v)) + '/>';
    });
    var grid = [hi, (hi + lo) / 2, lo].map(function (g) {
      return '<line class="ks-g" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(g).toFixed(1) + '" y2="' + y(g).toFixed(1) + '"/><text class="ks-t" x="' + (pl - 6) + '" y="' + (y(g) + 3.5).toFixed(1) + '" text-anchor="end">' + esc(fmt(g)) + '</text>';
    }).join('');
    var ref = o.ref != null && o.ref > lo && o.ref < hi ? '<line class="ks-r" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(o.ref).toFixed(1) + '" y2="' + y(o.ref).toFixed(1) + '"/>' : '';
    return '<svg class="ks-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.aria || '') + '" preserveAspectRatio="none">' + grid + ref + '<path class="ks-l" d="' + d + '"/>' + dots + '</svg>';
  }

  /** Полоса результатов матчей. items: [{win:boolean, tip}], от старых к новым. */
  function resultStrip(items, aria) {
    return '<div class="kr" role="img" aria-label="' + esc(aria) + '">' + items.map(function (i) { return '<span class="kr-c ' + (i.win ? 'w' : 'l') + '"' + tipAttr(i.tip) + '></span>'; }).join('') + '</div>';
  }

  /** Простой постраничный переключатель. data-a берётся у вызывающего кода: o.prev / o.next. */
  function pager(o) {
    var pages = Math.max(1, Math.ceil(o.total / o.size));
    if (pages <= 1) return '<div class="kg"><span class="sm">Показано ' + o.total + ' из ' + o.total + '</span></div>';
    var from = (o.page - 1) * o.size + 1, to = Math.min(o.total, o.page * o.size);
    return '<div class="kg"><span class="sm">' + from + '–' + to + ' из ' + o.total + '</span><div class="actions"><button class="btn sm2" data-a="' + esc(o.prev) + '"' + (o.page <= 1 ? ' disabled' : '') + ' aria-label="Предыдущая страница">' + ico('back') + '</button><span class="kg-n" aria-live="polite">' + o.page + ' / ' + pages + '</span><button class="btn sm2" data-a="' + esc(o.next) + '"' + (o.page >= pages ? ' disabled' : '') + ' aria-label="Следующая страница"><span class="flip">' + ico('back') + '</span></button></div></div>';
  }

  root.DMKit = { esc: esc, ico: ico, badge: badge, metric: metric, panel: panel, empty: empty, skeleton: skeleton, distribution: distribution, spark: spark, resultStrip: resultStrip, pager: pager };
  if (typeof module === 'object' && module.exports) module.exports = root.DMKit;
})(typeof self !== 'undefined' ? self : this);
