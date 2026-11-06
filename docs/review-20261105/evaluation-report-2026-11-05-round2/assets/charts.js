/* CodeLens v2.0 第二轮测评报告图表
 * 数据全部来自本轮实测（见 HTML / Markdown 报告表格）；无动画，SVG 渲染，便于静态预览与打印。
 */
(function () {
  'use strict';

  if (typeof echarts === 'undefined') {
    console.warn('[report] echarts 未加载，图表跳过');
    return;
  }

  var rootStyle = getComputedStyle(document.documentElement);
  var cssVar = function (name, fallback) {
    var v = rootStyle.getPropertyValue(name);
    return (v && v.trim()) || fallback;
  };

  var INK = cssVar('--ink', '#14181f');
  var MUTED = cssVar('--muted', '#5c6675');
  var RULE = cssVar('--rule', '#e3e7ed');
  var ACCENT = cssVar('--accent', '#1565c0');
  var ACCENT2 = cssVar('--accent2', '#d9782d');
  var BG2 = cssVar('--bg2', '#ffffff');
  var FONT = cssVar('--font', '"Segoe UI", sans-serif');

  var AXIS_LABEL = { color: MUTED, fontFamily: FONT, fontSize: 12 };
  var TOOLTIP = {
    appendToBody: true,
    backgroundColor: BG2,
    borderColor: RULE,
    textStyle: { color: INK, fontFamily: FONT, fontSize: 12 },
  };
  var GRID = { left: 8, right: 20, top: 40, bottom: 8, containLabel: true };

  function baseOption(extra) {
    var opt = {
      animation: false,
      textStyle: { fontFamily: FONT, color: INK },
      grid: GRID,
      tooltip: TOOLTIP,
    };
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) opt[k] = extra[k];
    }
    return opt;
  }

  function init(id) {
    var el = document.getElementById(id);
    if (!el) {
      console.warn('[report] 缺少图表容器 #' + id);
      return null;
    }
    return echarts.init(el, null, { renderer: 'svg' });
  }

  var charts = [];

  /* 图 1 · 零配置首跑关键时延：真实 NVIDIA vs 确定性 mock（毫秒） */
  (function () {
    var chart = init('chart-chain');
    if (!chart) return;
    chart.setOption(baseOption({
      legend: { top: 4, textStyle: { color: MUTED, fontFamily: FONT, fontSize: 12 } },
      tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', valueFormatter: function (v) { return v + ' ms'; } }),
      xAxis: {
        type: 'category',
        data: ['首事件', '首正文', '整轮（含审批）'],
        axisLabel: AXIS_LABEL,
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        name: '毫秒',
        nameTextStyle: { color: MUTED, fontFamily: FONT, fontSize: 12 },
        axisLabel: AXIS_LABEL,
        splitLine: { lineStyle: { color: RULE } },
      },
      series: [
        {
          name: '真实 NVIDIA（6.68 s 成功轮）',
          type: 'bar',
          barMaxWidth: 42,
          itemStyle: { color: ACCENT },
          data: [1508, 6285, 6680],
        },
        {
          name: 'mock 链路（确定性）',
          type: 'bar',
          barMaxWidth: 42,
          itemStyle: { color: ACCENT2 },
          data: [1691, 8300, 8300],
        },
      ],
    }));
    charts.push(chart);
  })();

  /* 图 2 · 故障注入到可读错误出现的耗时（秒） */
  (function () {
    var chart = init('chart-fault');
    if (!chart) return;
    chart.setOption(baseOption({
      grid: { left: 8, right: 55, top: 20, bottom: 8, containLabel: true },
      tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', valueFormatter: function (v) { return v + ' s'; } }),
      xAxis: {
        type: 'value',
        name: '秒',
        nameTextStyle: { color: MUTED, fontFamily: FONT, fontSize: 12 },
        axisLabel: AXIS_LABEL,
        splitLine: { lineStyle: { color: RULE } },
        min: 0,
        max: 4.5,
      },
      yAxis: {
        type: 'category',
        data: ['超时（1.5 s 配置）', '模型不存在', '错误 Key'],
        axisLabel: AXIS_LABEL,
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
      },
      series: [
        {
          type: 'bar',
          name: '到达时间',
          barMaxWidth: 22,
          itemStyle: { color: ACCENT2 },
          label: {
            show: true,
            position: 'right',
            formatter: function (p) { return p.value.toFixed(2) + ' s'; },
            color: INK,
            fontFamily: FONT,
            fontSize: 12,
            fontWeight: 700,
          },
          data: [3.919, 1.294, 1.086],
        },
      ],
    }));
    charts.push(chart);
  })();

  /* 图 3 · CJK 字体产物改前 / 改后（MB） */
  (function () {
    var chart = init('chart-fonts');
    if (!chart) return;
    chart.setOption(baseOption({
      grid: { left: 8, right: 45, top: 20, bottom: 8, containLabel: true },
      tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', valueFormatter: function (v) { return v + ' MB'; } }),
      xAxis: {
        type: 'category',
        data: ['改前（3 字重）', '改后（2 字重）'],
        axisLabel: AXIS_LABEL,
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        name: 'MB',
        nameTextStyle: { color: MUTED, fontFamily: FONT, fontSize: 12 },
        axisLabel: AXIS_LABEL,
        splitLine: { lineStyle: { color: RULE } },
        max: 18,
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 56,
          data: [
            { value: 16.76, itemStyle: { color: ACCENT2 } },
            { value: 10.73, itemStyle: { color: ACCENT } },
          ],
          label: {
            show: true,
            position: 'top',
            formatter: function (p) { return p.value + ' MB'; },
            color: INK,
            fontFamily: FONT,
            fontSize: 12,
            fontWeight: 700,
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: MUTED, type: 'dashed' },
            label: { formatter: '−36%', color: ACCENT, fontFamily: FONT, fontSize: 12 },
            data: [{ yAxis: 10.73 }],
          },
        },
      ],
    }));
    charts.push(chart);
  })();

  /* 图 4 · 同机启动到 /api/health 200（5 次，秒） */
  (function () {
    var chart = init('chart-boot');
    if (!chart) return;
    chart.setOption(baseOption({
      tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', valueFormatter: function (v) { return v + ' s'; } }),
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: ['#1', '#2', '#3', '#4', '#5'],
        axisLabel: AXIS_LABEL,
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        name: '秒',
        nameTextStyle: { color: MUTED, fontFamily: FONT, fontSize: 12 },
        axisLabel: AXIS_LABEL,
        splitLine: { lineStyle: { color: RULE } },
        min: 40,
        max: 48,
      },
      series: [
        {
          name: '启动 → 健康检查 200',
          type: 'line',
          symbolSize: 7,
          itemStyle: { color: ACCENT },
          lineStyle: { width: 2 },
          areaStyle: { color: 'rgba(21,101,192,0.08)' },
          label: {
            show: true,
            position: 'top',
            formatter: function (p) { return p.value + ' s'; },
            color: MUTED,
            fontFamily: FONT,
            fontSize: 11,
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: ACCENT2, type: 'dashed' },
            label: { formatter: '同机空启动基线 6.9 s（不在本图区间）', color: ACCENT2, fontFamily: FONT, fontSize: 11 },
            data: [{ yAxis: 40 }],
          },
          data: [45.597, 45.897, 46.724, 42.404, 44.89],
        },
      ],
    }));
    charts.push(chart);
  })();

  /* 图 5 · 测试通过 / 失败 / 跳过分布（用例数） */
  (function () {
    var chart = init('chart-tests');
    if (!chart) return;
    chart.setOption(baseOption({
      legend: { top: 4, textStyle: { color: MUTED, fontFamily: FONT, fontSize: 12 } },
      tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', axisPointer: { type: 'shadow' } }),
      xAxis: {
        type: 'category',
        data: ['server（88 文件）', 'client（9 文件）'],
        axisLabel: AXIS_LABEL,
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        name: '用例数',
        nameTextStyle: { color: MUTED, fontFamily: FONT, fontSize: 12 },
        axisLabel: AXIS_LABEL,
        splitLine: { lineStyle: { color: RULE } },
      },
      series: [
        {
          name: '通过',
          type: 'bar',
          stack: 'total',
          barMaxWidth: 56,
          itemStyle: { color: ACCENT },
          label: { show: true, color: '#fff', fontFamily: FONT, fontSize: 12, fontWeight: 700 },
          data: [920, 62],
        },
        {
          name: '失败',
          type: 'bar',
          stack: 'total',
          barMaxWidth: 56,
          itemStyle: { color: '#c0392b' },
          label: { show: true, color: '#fff', fontFamily: FONT, fontSize: 12, fontWeight: 700 },
          data: [0, 0],
        },
        {
          name: '跳过',
          type: 'bar',
          stack: 'total',
          barMaxWidth: 56,
          itemStyle: { color: '#9aa4b2' },
          label: { show: true, color: '#fff', fontFamily: FONT, fontSize: 12, fontWeight: 700 },
          data: [3, 0],
        },
      ],
    }));
    charts.push(chart);
  })();

  /* 图 6 · R3 早事件与中止时延（改后实测，毫秒；改前该场景无任何事件） */
  (function () {
    var chart = init('chart-stage');
    if (!chart) return;
    chart.setOption(baseOption({
      grid: { left: 8, right: 60, top: 20, bottom: 8, containLabel: true },
      tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', valueFormatter: function (v) { return v + ' ms'; } }),
      xAxis: {
        type: 'value',
        name: '毫秒',
        nameTextStyle: { color: MUTED, fontFamily: FONT, fontSize: 12 },
        axisLabel: AXIS_LABEL,
        splitLine: { lineStyle: { color: RULE } },
        min: 0,
        max: 30,
      },
      yAxis: {
        type: 'category',
        data: ['服务端 connecting 回执', '客户端观测到首个 stage 帧', '中止 → 上游取消请求'],
        axisLabel: AXIS_LABEL,
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 24,
          itemStyle: { color: ACCENT },
          label: {
            show: true,
            position: 'right',
            formatter: function (p) { return p.value + ' ms'; },
            color: INK,
            fontFamily: FONT,
            fontSize: 12,
            fontWeight: 700,
          },
          data: [0, 26, 11],
        },
      ],
    }));
    charts.push(chart);
  })();

  /* 图 7 · R4 假绿对照：同一把错误 Key，旧 GET /models vs 新最小生成探测 */
  (function () {
    var chart = init('chart-health');
    if (!chart) return;
    chart.setOption(baseOption({
      grid: { left: 8, right: 130, top: 20, bottom: 8, containLabel: true },
      tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', valueFormatter: function (v) { return v + ' ms'; } }),
      xAxis: {
        type: 'value',
        name: '毫秒',
        nameTextStyle: { color: MUTED, fontFamily: FONT, fontSize: 12 },
        axisLabel: AXIS_LABEL,
        splitLine: { lineStyle: { color: RULE } },
        max: 10000,
      },
      yAxis: {
        type: 'category',
        data: ['旧自检 GET /models', '新探测 POST /chat/completions'],
        axisLabel: AXIS_LABEL,
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 26,
          label: {
            show: true,
            position: 'right',
            formatter: function (p) { return p.value + ' ms · ' + (p.dataIndex === 0 ? 'HTTP 200（假绿）' : 'HTTP 401（auth_failed）'); },
            color: INK,
            fontFamily: FONT,
            fontSize: 12,
            fontWeight: 700,
          },
          data: [
            { value: 8704, itemStyle: { color: ACCENT2 } },
            { value: 577, itemStyle: { color: ACCENT } },
          ],
        },
      ],
    }));
    charts.push(chart);
  })();

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      charts.forEach(function (c) { c.resize(); });
    }, 120);
  });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      charts.forEach(function (c) { c.resize(); });
    });
  }
})();
