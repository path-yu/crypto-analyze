// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: 指标脚本 · Signal Suite
function __create(__pine) {
  const C = __pine.candles
  const n = C.length
  let __index = 0
  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }
  const __h_is_green = __pine.makeRing(2)
  const __h_is_red = __pine.makeRing(2)
  let same_session = NaN
  let is_green = NaN
  let is_red = NaN
  let prev_green = NaN
  let prev_red = NaN
  let prev_high = NaN
  let prev_low = NaN
  let combo_low = NaN
  let combo_high = NaN
  let raw_buy = NaN
  let raw_sell = NaN
  let valid_buy = NaN
  let valid_sell = NaN
  let mem_buy = NaN
  let mem_sell = NaN
  let break_buy_sl = NaN
  let break_sell_sl = NaN
  let allow_plot = NaN
  let final_buy = NaN
  let final_sell = NaN
  let is_new_buy = NaN
  let is_new_sell = NaN
  let hitTP1 = NaN
  let hitTP2 = NaN
  let hitTP3 = NaN
  let plot_buy = NaN
  let plot_sell = NaN
  let paint_green = NaN
  let paint_red = NaN
  let is_gray = NaN
  let b_color = NaN
  const grp_mode = "Trading Mode"
  const en_scalping = __pine.input.bool("en_scalping", false, { title: "Enable Scalping?", group: grp_mode })
  const en_slope_filter = en_scalping
  const en_sl_blocking = (!en_scalping)
  const grp_targets = "Target System (Active only when Scalping is ON)"
  const en_targets = __pine.input.bool("en_targets", true, { title: "Show Live Target Boxes & Labels", group: grp_targets })
  const rr1 = __pine.input.float("rr1", 1, { title: "Target 1 — Risk/Reward", group: grp_targets, minval: 0, step: 0.5 })
  const rr2 = __pine.input.float("rr2", 2, { title: "Target 2 — Risk/Reward", group: grp_targets, minval: 0, step: 0.5 })
  const rr3 = __pine.input.float("rr3", 3, { title: "Target 3 — Risk/Reward", group: grp_targets, minval: 0, step: 0.5 })
  const grp_visuals = "Visual Settings"
  const buy_color = __pine.input.color("buy_color", __pine.color.new("#089981", 0), { title: "Buy Signal Color", group: grp_visuals })
  const sell_color = __pine.input.color("sell_color", __pine.color.new("#f23645", 0), { title: "Sell Signal Color", group: grp_visuals })
  const en_bar_color = __pine.input.bool("en_bar_color", true, { title: "Enable Bar Coloring", group: grp_visuals })
  const en_static_sl = __pine.input.bool("en_static_sl", true, { title: "Enable Static SL & Gray Drawdown", group: grp_visuals })
  let signal_state = 0
  let last_buy_price = NaN
  let last_sell_price = NaN
  let active_sl = NaN
  let sl_type = 0
  let static_sl = NaN
  let static_sl_type = 0
  let live_entry = NaN
  let live_sl = NaN
  let live_tp1 = NaN
  let live_tp2 = NaN
  let live_tp3 = NaN
  let live_dir = 0
  let live_start = NaN
  let live_active = false
  let live_end_idx = NaN
  let trade_high = NaN
  let trade_low = NaN
  let max_sl_heat = NaN
  let tp1_reached = false
  let box_sl = __pine.box.new(NaN, NaN, NaN, NaN)
  let box_tp = __pine.box.new(NaN, NaN, NaN, NaN)
  let lbl_tp3 = __pine.label.new(NaN, NaN)
  let lbl_tp2 = __pine.label.new(NaN, NaN)
  let lbl_tp1 = __pine.label.new(NaN, NaN)
  let lbl_entry = __pine.label.new(NaN, NaN)
  let lbl_sl = __pine.label.new(NaN, NaN)
  let visual_state = 0
  const meta = {"kind":"indicator","config":{"title":"Supreme Buy/Sell Signal Indicator V2 by chaitu50c","shorttitle":"Supreme V2","overlay":true,"max_boxes_count":500,"max_labels_count":500},"inputs":[{"name":"en_scalping","type":"bool","title":"Enable Scalping?","default":false},{"name":"en_targets","type":"bool","title":"Show Live Target Boxes & Labels","default":true},{"name":"rr1","type":"float","title":"Target 1 — Risk/Reward","minval":0,"step":0.5,"default":1},{"name":"rr2","type":"float","title":"Target 2 — Risk/Reward","minval":0,"step":0.5,"default":2},{"name":"rr3","type":"float","title":"Target 3 — Risk/Reward","minval":0,"step":0.5,"default":3},{"name":"buy_color","type":"color","title":"Buy Signal Color"},{"name":"sell_color","type":"color","title":"Sell Signal Color"},{"name":"en_bar_color","type":"bool","title":"Enable Bar Coloring","default":true},{"name":"en_static_sl","type":"bool","title":"Enable Static SL & Gray Drawdown","default":true}],"plotTitles":[],"alerts":[]}
  const plots = {}
  const markers = []
  const barColor = []

  function step(index, ctx) {
    __index = index
    __ctx = ctx
    let __ind_buy = NaN
    let __ind_sell = NaN
    let __ind_sl = NaN
    let __ind_tp = NaN
    same_session = (!(__index === 0))
    is_green = __pine.gt(C.close[__index], C.open[__index]); __pine.push(__h_is_green, is_green)
    is_red = __pine.lt(C.close[__index], C.open[__index]); __pine.push(__h_is_red, is_red)
    prev_green = __pine.hist(__h_is_green, 1)
    prev_red = __pine.hist(__h_is_red, 1)
    prev_high = __pine.at(C.high, __index, 1)
    prev_low = __pine.at(C.low, __index, 1)
    combo_low = Math.min(C.low[__index], prev_low)
    combo_high = Math.max(C.high[__index], prev_high)
    raw_buy = (((same_session && prev_green) && is_green) && __pine.gt(C.close[__index], prev_high))
    raw_sell = (((same_session && prev_red) && is_red) && __pine.lt(C.close[__index], prev_low))
    if ((__index === 0)) {
      signal_state = 0
      last_buy_price = NaN
      last_sell_price = NaN
    }
    valid_buy = (raw_buy && __pine.neq(signal_state, 1))
    valid_sell = (raw_sell && __pine.neq(signal_state, (-1)))
    mem_buy = valid_buy
    if ((en_slope_filter && (!__pine.isNa(last_buy_price)))) {
      mem_buy = (valid_buy && __pine.gt(C.close[__index], last_buy_price))
    }
    mem_sell = valid_sell
    if ((en_slope_filter && (!__pine.isNa(last_sell_price)))) {
      mem_sell = (valid_sell && __pine.lt(C.close[__index], last_sell_price))
    }
    if (valid_buy) {
      signal_state = 1
      last_buy_price = C.close[__index]
    }
    else if (valid_sell) {
      signal_state = (-1)
      last_sell_price = C.close[__index]
    }
    if ((__index === 0)) {
      active_sl = NaN
      sl_type = 0
    }
    break_buy_sl = (__pine.eq(sl_type, 1) && __pine.lt(C.close[__index], active_sl))
    break_sell_sl = (__pine.eq(sl_type, (-1)) && __pine.gt(C.close[__index], active_sl))
    if (break_buy_sl) {
      active_sl = NaN
      sl_type = 0
    }
    else if (break_sell_sl) {
      active_sl = NaN
      sl_type = 0
    }
    allow_plot = ((!en_sl_blocking) || __pine.isNa(active_sl))
    final_buy = (mem_buy && allow_plot)
    final_sell = (mem_sell && allow_plot)
    if ((final_buy && en_sl_blocking)) {
      active_sl = combo_low
      sl_type = 1
    }
    else if ((final_sell && en_sl_blocking)) {
      active_sl = combo_high
      sl_type = (-1)
    }
    if ((__index === 0)) {
      static_sl = NaN
      static_sl_type = 0
    }
    if ((!en_sl_blocking)) {
      if ((final_buy && __pine.neq(static_sl_type, 1))) {
        static_sl = combo_low
        static_sl_type = 1
      }
      else if ((final_sell && __pine.neq(static_sl_type, (-1)))) {
        static_sl = combo_high
        static_sl_type = (-1)
      }
    } else {
      static_sl = NaN
      static_sl_type = 0
    }
    is_new_buy = (final_buy && __pine.neq(live_dir, 1))
    is_new_sell = (final_sell && __pine.neq(live_dir, (-1)))
    if ((__index === 0)) {
      live_active = false
      live_dir = 0
      tp1_reached = false
    }
    if ((is_new_buy && (!en_sl_blocking))) {
      live_dir = 1
      live_entry = C.close[__index]
      live_sl = combo_low
      let risk = Math.max(Math.abs((C.close[__index] - live_sl)), __pine.ctx.mintick)
      let tp1_base = (risk * rr1)
      let tp2_base = (tp1_base + (risk * (rr2 - rr1)))
      let tp3_base = (tp1_base + (risk * (rr3 - rr1)))
      live_tp1 = (C.close[__index] + tp1_base)
      live_tp2 = (C.close[__index] + tp2_base)
      live_tp3 = (C.close[__index] + tp3_base)
      live_start = __index
      live_active = true
      live_end_idx = (__index + 4)
      trade_high = C.close[__index]
      trade_low = C.close[__index]
      max_sl_heat = (-Math.max(Math.abs((C.close[__index] - live_sl)), __pine.ctx.mintick))
      tp1_reached = false
    }
    if ((is_new_sell && (!en_sl_blocking))) {
      live_dir = (-1)
      live_entry = C.close[__index]
      live_sl = combo_high
      let risk = Math.max(Math.abs((C.close[__index] - live_sl)), __pine.ctx.mintick)
      let tp1_base = (risk * rr1)
      let tp2_base = (tp1_base + (risk * (rr2 - rr1)))
      let tp3_base = (tp1_base + (risk * (rr3 - rr1)))
      live_tp1 = (C.close[__index] - tp1_base)
      live_tp2 = (C.close[__index] - tp2_base)
      live_tp3 = (C.close[__index] - tp3_base)
      live_start = __index
      live_active = true
      live_end_idx = (__index + 4)
      trade_high = C.close[__index]
      trade_low = C.close[__index]
      max_sl_heat = (-Math.max(Math.abs((C.close[__index] - live_sl)), __pine.ctx.mintick))
      tp1_reached = false
    }
    if ((live_active && (!en_sl_blocking))) {
      trade_high = Math.max(trade_high, C.high[__index])
      trade_low = Math.min(trade_low, C.low[__index])
      if ((__pine.gt(__index, live_start) && (!tp1_reached))) {
        let sl_dist = ((__pine.eq(live_dir, 1)) ? ((live_sl - C.low[__index])) : ((C.high[__index] - live_sl)))
        max_sl_heat = Math.max(max_sl_heat, sl_dist)
      }
      if (((__pine.eq(live_dir, 1) && final_sell) || (__pine.eq(live_dir, (-1)) && final_buy))) {
        live_active = false
      }
    }
    hitTP1 = false
    hitTP2 = false
    hitTP3 = false
    if (((__pine.neq(live_dir, 0) && (!(is_new_buy || is_new_sell))) && (!en_sl_blocking))) {
      if (__pine.eq(live_dir, 1)) {
        hitTP1 = __pine.ge(trade_high, live_tp1)
        hitTP2 = __pine.ge(trade_high, live_tp2)
        hitTP3 = __pine.ge(trade_high, live_tp3)
      }
      else if (__pine.eq(live_dir, (-1))) {
        hitTP1 = __pine.le(trade_low, live_tp1)
        hitTP2 = __pine.le(trade_low, live_tp2)
        hitTP3 = __pine.le(trade_low, live_tp3)
      }
      if (hitTP1) {
        tp1_reached = true
      }
      if (live_active) {
        live_end_idx = (__index + 4)
      }
    }
    if (((__pine.neq(live_dir, 0) && en_targets) && (!en_sl_blocking))) {
      let c_sl_bg = __pine.color.new(__pine.color.red, 85)
      let c_tp_bg = __pine.color.new(__pine.color.green, 85)
      let sl_pts = Math.abs((live_entry - live_sl))
      let tp1_pts = Math.abs((live_tp1 - live_entry))
      let tp2_pts = Math.abs((live_tp2 - live_entry))
      let tp3_pts = Math.abs((live_tp3 - live_entry))
      ;__pine.box.set_lefttop(box_sl, live_start, live_entry)
      ;__pine.box.set_rightbottom(box_sl, live_end_idx, live_sl)
      ;__pine.box.set_bgcolor(box_sl, c_sl_bg)
      ;__pine.box.set_border_color(box_sl, __pine.color.new(__pine.color.red, 100))
      ;__pine.box.set_lefttop(box_tp, live_start, live_tp3)
      ;__pine.box.set_rightbottom(box_tp, live_end_idx, live_entry)
      ;__pine.box.set_bgcolor(box_tp, c_tp_bg)
      ;__pine.box.set_border_color(box_tp, __pine.color.new(__pine.color.green, 100))
      let tp3_text = ((((("TP3 ▸ " + __pine.str.tostring(live_tp3, __pine.format.mintick)) + " (+") + __pine.str.tostring(tp3_pts, __pine.format.mintick)) + ")") + ((hitTP3) ? (" ✔") : ("")))
      ;__pine.label.set_xy(lbl_tp3, live_end_idx, live_tp3)
      ;__pine.label.set_text(lbl_tp3, tp3_text)
      ;__pine.label.set_color(lbl_tp3, __pine.color.new(__pine.color.green, 10))
      ;__pine.label.set_style(lbl_tp3, 'style_label_left')
      ;__pine.label.set_textcolor(lbl_tp3, __pine.color.white)
      ;__pine.label.set_size(lbl_tp3, 'small')
      let tp2_text = ((((("TP2 ▸ " + __pine.str.tostring(live_tp2, __pine.format.mintick)) + " (+") + __pine.str.tostring(tp2_pts, __pine.format.mintick)) + ")") + ((hitTP2) ? (" ✔") : ("")))
      ;__pine.label.set_xy(lbl_tp2, live_end_idx, live_tp2)
      ;__pine.label.set_text(lbl_tp2, tp2_text)
      ;__pine.label.set_color(lbl_tp2, __pine.color.new(__pine.color.green, 10))
      ;__pine.label.set_style(lbl_tp2, 'style_label_left')
      ;__pine.label.set_textcolor(lbl_tp2, __pine.color.white)
      ;__pine.label.set_size(lbl_tp2, 'small')
      let tp1_text = ((((("TP1 ▸ " + __pine.str.tostring(live_tp1, __pine.format.mintick)) + " (+") + __pine.str.tostring(tp1_pts, __pine.format.mintick)) + ")") + ((hitTP1) ? (" ✔") : ("")))
      ;__pine.label.set_xy(lbl_tp1, live_end_idx, live_tp1)
      ;__pine.label.set_text(lbl_tp1, tp1_text)
      ;__pine.label.set_color(lbl_tp1, __pine.color.new(__pine.color.green, 10))
      ;__pine.label.set_style(lbl_tp1, 'style_label_left')
      ;__pine.label.set_textcolor(lbl_tp1, __pine.color.white)
      ;__pine.label.set_size(lbl_tp1, 'small')
      ;__pine.label.set_xy(lbl_entry, live_end_idx, live_entry)
      ;__pine.label.set_text(lbl_entry, ("Entry ▸ " + __pine.str.tostring(live_entry, __pine.format.mintick)))
      ;__pine.label.set_color(lbl_entry, __pine.color.new(__pine.color.green, 30))
      ;__pine.label.set_style(lbl_entry, 'style_label_left')
      ;__pine.label.set_textcolor(lbl_entry, __pine.color.white)
      ;__pine.label.set_size(lbl_entry, 'small')
      let dyn_sl_text = ""
      let sl_label_color = __pine.color.new(__pine.color.red, 20)
      let sl_text_color = __pine.color.white
      if ((live_active && (!tp1_reached))) {
        let live_dist = ((__pine.eq(live_dir, 1)) ? ((live_sl - C.close[__index])) : ((C.close[__index] - live_sl)))
        let sign = ((__pine.gt(live_dist, 0)) ? ("+") : (""))
        dyn_sl_text = (((" ≈ [" + sign) + __pine.str.tostring(live_dist, __pine.format.mintick)) + "]")
        let is_in_drawdown = ((__pine.eq(live_dir, 1) && __pine.lt(C.close[__index], live_entry)) || (__pine.eq(live_dir, (-1)) && __pine.gt(C.close[__index], live_entry)))
        if (is_in_drawdown) {
          sl_label_color = __pine.color.new(__pine.color.yellow, 20)
          sl_text_color = __pine.color.black
        }
      } else {
        let sign = ((__pine.gt(max_sl_heat, 0)) ? ("+") : (""))
        dyn_sl_text = (((" ≈ [" + sign) + __pine.str.tostring(max_sl_heat, __pine.format.mintick)) + "]")
      }
      ;__pine.label.set_xy(lbl_sl, live_end_idx, live_sl)
      ;__pine.label.set_text(lbl_sl, ((((("✗ SL ▸ " + __pine.str.tostring(live_sl, __pine.format.mintick)) + " (-") + __pine.str.tostring(sl_pts, __pine.format.mintick)) + ")") + dyn_sl_text))
      ;__pine.label.set_color(lbl_sl, sl_label_color)
      ;__pine.label.set_style(lbl_sl, 'style_label_left')
      ;__pine.label.set_textcolor(lbl_sl, sl_text_color)
      ;__pine.label.set_size(lbl_sl, 'small')
    } else {
      ;__pine.box.set_lefttop(box_sl, NaN, NaN)
      ;__pine.box.set_lefttop(box_tp, NaN, NaN)
      ;__pine.label.set_xy(lbl_tp3, NaN, NaN)
      ;__pine.label.set_xy(lbl_tp2, NaN, NaN)
      ;__pine.label.set_xy(lbl_tp1, NaN, NaN)
      ;__pine.label.set_xy(lbl_entry, NaN, NaN)
      ;__pine.label.set_xy(lbl_sl, NaN, NaN)
    }
    if ((__index === 0)) {
      visual_state = 0
    }
    plot_buy = final_buy
    plot_sell = final_sell
    if (en_scalping) {
      plot_buy = (final_buy && __pine.neq(visual_state, 1))
      plot_sell = (final_sell && __pine.neq(visual_state, (-1)))
    }
    if (final_buy) {
      visual_state = 1
    }
    else if (final_sell) {
      visual_state = (-1)
    }
    ;__pine.mark(markers, ((plot_buy) ? (C.low[__index]) : (NaN)), "Buy Signal", "belowbar", __index); __ind_buy = ((plot_buy) ? (C.low[__index]) : (NaN))
    ;__pine.mark(markers, ((plot_sell) ? (C.high[__index]) : (NaN)), "Sell Signal", "abovebar", __index); __ind_sell = ((plot_sell) ? (C.high[__index]) : (NaN))
    ;__pine.plot(plots, active_sl, "Active Stop Loss Line", __index); __ind_sl = active_sl
    ;__pine.plot(plots, (((en_static_sl && (!en_sl_blocking))) ? (static_sl) : (NaN)), "Static Baseline SL", __index)
    paint_green = (break_sell_sl && (!final_buy))
    paint_red = (break_buy_sl && (!final_sell))
    is_gray = ((en_static_sl && (!en_sl_blocking)) && ((__pine.eq(static_sl_type, 1) && __pine.lt(C.close[__index], static_sl)) || (__pine.eq(static_sl_type, (-1)) && __pine.gt(C.close[__index], static_sl))))
    b_color = NaN
    if (en_bar_color) {
      if (en_sl_blocking) {
        b_color = ((paint_green) ? (buy_color) : (((paint_red) ? (sell_color) : (NaN))))
      } else {
        b_color = ((__pine.eq(visual_state, 1)) ? (buy_color) : (((__pine.eq(visual_state, (-1))) ? (sell_color) : (NaN))))
        if (is_gray) {
          b_color = __pine.color.gray
        }
      }
    }
    ;__pine.barColor(barColor, b_color, __index)
    return {
      imbaTrendLine: NaN,
      tsotTrendValue: NaN,
      canLong: !__pine.isNa(__ind_buy),
      canShort: !__pine.isNa(__ind_sell),
      atrLongStop: NaN,
      atrShortStop: NaN,
      obStopLoss: __ind_sl,
      obTakeProfit: __ind_tp,
      obRisk: (!__pine.isNa(__ind_sl) && !__pine.isNa(__ind_buy)) ? Math.abs(C.close[__index] - __ind_sl) : NaN,
    }
  }

  return { step, meta, plots, markers, barColor }
}
globalThis.__pineProgram = { create: __create }
