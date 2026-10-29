/**
 * dsh-prompt-bar 浏览器半。手写 __ModuleLoader__ 模块，**不经过任何构建工具**——
 * 少一套工具链，就少一处会随 DSH 升级而坏的地方（沿用 dsh-batrunner-logs 的做法）。
 *
 * 定档形态 = 原型 A 方案（原生同族）：
 *  - 会话区顶部常驻一行，内容是本会话**第一条**提问；右侧两个图标：复制 / 折叠展开。
 *  - 面板内嵌在常驻条下方（不是浮层）：展开时会把会话流整体往下推，收起即恢复。
 *  - 面板列出我发起的**每一条**提问（不含模型回答），每条右侧一个复制图标。
 *  - 点折叠图标、点面板标题栏的关闭，或点面板外任意区域 → 收起；Esc 同样收起。
 *
 * 挂法（兼容性优先，三件事分开看）：
 *  1) **生命周期与权限**走官方槽位：注册进 conversation.session.header.actions，条目本身只渲染
 *     一个 display:none 的锚点（照抄 dsh-rewind-plugin 的 "renders portals only" 路子），
 *     不跟官方标题抢地方。
 *  2) **位置**走 createPortal：真正的条渲染在 `[data-conversation-content]`（会话正文）的第一个
 *     子节点位置。正文是 flex column，`.scrollBody` 占 flex:1，所以我们插进去的 flex:none 一行
 *     天然把消息区往下挤；面板展开 = 这一行变高 = 消息区再矮一点。这正是 A 方案要的效果，
 *     而且常驻条在滚动容器外面，滚多远都不会被滚走。
 *     选正文而不选 header：header 带 data-window-drag（Windows 上是窗口拖拽区），往里塞按钮
 *     还要额外处理 -webkit-app-region；正文没有这层麻烦。
 *  3) **取数据**两份对照着用：
 *     - 权威那份走官方远程接口 ctx.remote.session.page：从这篇会话日志的**尾巴**往前一页页翻（throughSeq 当游标），
 *       翻到 hasMore=false 才算完，所以能翻到真正的第一条。挑法跟官方聊天视图一致：user/message 且
 *       data.source.kind === 'user'（注入的上下文、唤醒模型的 context 是别的 source，不算），再排掉被后来的
 *       surfaceOp.replace 顶掉的那些旧版本。界面点「加载更早」只会放大聊天窗口，动不了这份结果，
 *       所以第一条提问不会变。读史在浏览器这边做，不需要宿主配合——之前那版走宿主 RPC，
 *       结果 ctx.sessionQuery 在我们这个挂载层级拿不到（它是给 agent 层的插件用的），列表就只能退回窗口那份。
 *     - 窗口那份走官方读接口：ctx.sessions.binding(id) 拿 Session 快照（blank / pendingSubmissions），
 *       再从 ctx.get('uiConversation').binding(binding).target('chat') 读快照里的节点，
 *       只取 kind==='user' | 'steering'。这份是**分页窗口**里的，会话一长就只剩近期一段，
 *       只用来在翻页读史还没成功时顶着，以及让刚发出去的那条立刻出现。
 *     两份按 seq 归并；pendingSubmissions（按了发送还没落库的本地回声）负责"回车瞬间常驻条就出现"。
 *     订阅 chat target 会顺带 activate 该 target，而 blank 会话一旦被 activate 会让 phase 从 blank 变
 *     active、新会话的 Hero 界面消失——所以**只有非 blank 才订阅**，blank 期间只挂 Session 快照订阅。
 *  4) **只在「对话」标签生效**：判据是聊天流容器 [data-chat-flow] 在不在这一篇正文里（它由聊天视图自己渲染，
 *     切到「轨迹」就被整块换掉）。不在时就宿主也摘掉、什么都不渲染，一点位置都不给轨迹的内容占。
 *
 * 降级路径（升级后仍可用）：槽位不存在 → 整个插件静默跳过；正文锚点找不到 → 直接在槽位里内联渲染；
 * uiConversation / writeClipboard 取不到 → 分别退回 Session 快照 / 原生剪贴板。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-bar',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var ReactDOM = require('react-dom');
    var primitives = try_require('@deepseek-ai/dsh-client-ui-primitives');

    function try_require(id) {
      try { return require(id); } catch (e) { return void 0; }
    }

    var createElement = React.createElement;
    var SLOT = 'conversation.session.header.actions';
    var NS = 'dsh-prompt-bar';
    var STYLE_ID = 'dsh-prompt-bar';
    var CHAT_VIEW = 'chat';
    var ANCHOR_ATTR = 'data-prompt-bar-anchor';
    var HOST_ATTR = 'data-prompt-bar';
    var REATTACH_MS = 800;      // 宿主被官方重挂（切会话、正文重建）后的重新挂靠节奏
    var COPIED_FEEDBACK_MS = 1400;
    var PAGE_MESSAGES = 500;      // 每页最多取多少条消息：跟官方加载器取同一个数（它也是 500）
    var PAGE_TIMEOUT_MS = 20000;  // 单页读史超时
    var MAX_PAGES = 50;           // 最多翻这么多页（约 10000 条消息），再长的会话也不至于无限翻下去
    var LOADER_MAX_ROUNDS = 40;   // 兜底走官方「加载更早」时最多点几下（每下约 500 条消息）
    var REFRESH_DEBOUNCE_MS = 350;
    var MAX_PROMPTS = 400;      // 面板最多列多少条提问，超出在面板脚上给一句提示
    var JUMP_POLL_MS = 90;      // 跳转落点的轮询间隔
    var JUMP_MAX_TRIES = 60;    // 最多轮询多久（约 5.4 秒）；还够不着就当这条的正文已被压缩工程抹掉

    // ---------------------------------------------------------------- 文案

    // 键写成 'panel.title' 这种带点的**整串扁平键**：字典查找是 `dict[key]`，不做点号逐层下钻
    // （见 dsh-client-locale 的 lookup），嵌套对象反而取不到。{n}/{time} 这类花括号占位由
    // translate 用第二个参数代入，是官方支持的写法。
    var DICT = {
      zh: {
        'bar.label': '首条提问',
        'bar.copy': '复制第一条提问',
        'bar.expand': '展开全部提问',
        'bar.collapse': '收起全部提问',
        'panel.title': '全部提问',
        'panel.count': '共 {n} 条',
        'panel.close': '收起面板',
        'panel.esc': '收起',
        'panel.outside': '点击面板外的区域同样收起',
        'panel.copyHint': '复制 = 原文写入剪贴板',
        'panel.copy': '复制这条提问',
        'panel.copied': '已复制',
        'panel.meta': '{time} · {chars} 字符',
        'panel.sending': '发送中',
        'panel.more': '会话太长，只列出前 {n} 条',
        'panel.jump': '跳到这条提问所在的位置（更早的会自动加载）',
        'jump.working': '正在加载更早的消息…',
        'jump.failed': '这条太早，原文已被压缩掉了，跳不到它',
        'bar.incomplete': '不完整',
        'bar.incomplete.note': '完整列表没读到，现在显示的只是这个会话页已经加载的那一段（{why}）。',
        'why.no-api': '这个版本的界面没有 ctx.remote.session.page 可用',
        'why.query-unavailable': '宿主的会话查询服务取不到',
        'why.read-failed': '翻页读这篇会话的历史失败',
        'why.bad-contract': '两边接口不一致',
        'why.timeout': '读历史超时',
        'why.no-response': '宿主没回话',
        'set.open': '选择常驻条外观',
        'set.close': '收起外观选择',
        'theme.title': '外观',
        'theme.reset': '恢复默认',
        'theme.pick': '换成这套外观',
        'theme.current': '当前在用',
        'theme.motion': '外观特效（徽标呼吸、悬停光带，只有部分外观带）',
        'theme.sweep': '悬停时有一道光带扫过',
        'theme.indigo': '亮一 · 靛青纸',
        'theme.blush': '亮二 · 桃腮',
        'theme.mint': '亮三 · 薄荷纸',
        'theme.iris': '亮四 · 藕荷',
        'theme.ink': '甲 · 墨玉分层',
        'theme.phos': '乙 · 磷光终端',
        'theme.tide': '丁 · 潮汐',
        'theme.ember': '戊 · 熔金',
        'theme.dusk': '己 · 夜紫',
        'theme.band': '辛 · 半边色带',
        'theme.applied': '选完立刻生效，不用重启'
      },
      en: {
        'bar.label': 'First prompt',
        'bar.copy': 'Copy the first prompt',
        'bar.expand': 'Show all prompts',
        'bar.collapse': 'Hide all prompts',
        'panel.title': 'All prompts',
        'panel.count': '{n} in total',
        'panel.close': 'Collapse the panel',
        'panel.esc': 'to collapse',
        'panel.outside': 'Clicking outside the panel collapses it too',
        'panel.copyHint': 'Copy puts the exact text on the clipboard',
        'panel.copy': 'Copy this prompt',
        'panel.copied': 'Copied',
        'panel.meta': '{time} · {chars} characters',
        'panel.sending': 'sending',
        'panel.more': 'Session is long — showing the first {n} only',
        'panel.jump': 'Jump to this prompt in the conversation (older ones load on demand)',
        'jump.working': 'Loading older messages…',
        'jump.failed': 'This prompt is too old — its text was compacted away, there is nothing to jump to',
        'bar.incomplete': 'incomplete',
        'bar.incomplete.note': 'The full list could not be read, so this is only the part the conversation page has loaded ({why}).',
        'why.no-api': 'this build has no ctx.remote.session.page to call',
        'why.query-unavailable': 'the host session-query service is unavailable',
        'why.read-failed': 'paging through this session history failed',
        'why.bad-contract': 'the two halves disagree on the response shape',
        'why.timeout': 'reading the history timed out',
        'why.no-response': 'the host sent no answer',
        'set.open': 'Pick a look for the bar',
        'set.close': 'Hide the look picker',
        'theme.title': 'Appearance',
        'theme.reset': 'Reset',
        'theme.pick': 'Use this look',
        'theme.current': 'in use',
        'theme.motion': 'Look effects (badge glow, hover sweep; only some looks have them)',
        'theme.sweep': 'A band of light sweeps across on hover',
        'theme.indigo': 'Light 1 · Indigo Paper',
        'theme.blush': 'Light 2 · Blush',
        'theme.mint': 'Light 3 · Mint Paper',
        'theme.iris': 'Light 4 · Lilac',
        'theme.ink': 'A · Ink Layers',
        'theme.phos': 'B · Phosphor Terminal',
        'theme.tide': 'D · Tide',
        'theme.ember': 'E · Ember',
        'theme.dusk': 'F · Night Violet',
        'theme.band': 'H · Half Band',
        'theme.applied': 'Takes effect right away — no restart'
      }
    };

    // ---------------------------------------------------------------- 样式
    // 色板直接抄原型 A（深色）：插件自带一组 --fpb-* 变量，值全是写死的十六进制。
    // 为什么不去借用 DSH 主题变量：试过，借用 --dsw-alias-* 时这些变量在某些主题状态下
    // 取不到有效值，浏览器只能退回到"跟正文色走"，于是徽标、左边框全成了灰白色，
    // 完全看不出重点。自带色板还有个好处：不受宿主主题版本变动影响，将来 DSH 换主题令牌也不牵连。
    // 想跟着自己的主题走：在用户样式里覆盖 --fpb-acc 等变量即可，规则本身不用改。
    var ACC_VARS = [
      '--fpb-acc:#7fd1c0',                 // 原型 --acc：左边框、徽标、计数、focus 描边
      '--fpb-acc-dim:#3f6f62',             // 原型 --accdim：当前条目的序号底
      '--fpb-acc-text:#cfeee2',            // 原型 .ic.on / .item.cur .no 的文字
      '--fpb-acc-wash:rgba(127,209,192,.16)',  // 展开态图标底（半透明，深浅底都能垫）
      '--fpb-chip:#2a2f2f',                // 原型 --chip：序号/计数徽标的底
      '--fpb-no-bg:#2a2a30',               // 原型 .no 的底
      '--fpb-no-text:#8b8b95',             // 原型 .no 的字
      '--fpb-bar-bg:#1c1c1f',              // 原型 --bar
      '--fpb-bar-line:#33333a',            // 原型 --barline / --pline
      '--fpb-panel-bg:#222226',            // 原型 --panel
      '--fpb-item-line:#2e2e34',           // 原型 --il：条目分隔
      '--fpb-cur:#242b29',                 // 原型 --cur：当前条目底
      '--fpb-text:#e9e9ec',                // 原型 .txt
      '--fpb-text-dim:#8d8f96',            // 原型 .lbl / .ic
      '--fpb-text-faint:#5b5d63',          // 原型 .meta
      '--fpb-q:#d4d5db',                   // 原型 .item .q
      '--fpb-hover:rgba(255,255,255,.07)', // 图标 hover 底
      '--fpb-warn:#e0a45c',                // 「不完整」小牌：琥珀色，和青绿重点区分开
      '--fpb-warn-wash:rgba(224,164,92,.12)',
      '--fpb-warn-line:rgba(224,164,92,.45)'
    ].join(';') + ';';

    // ---------------------------------------------------------------- 八套外观
    // 对应原型 prototypes/bar-skins.html 的甲…辛。每套只做两件事：覆盖那组 --fpb-* 变量，
    // 再加几条装饰规则（底色渐变、左线、徽标、面板底色）。DOM 与功能一律不动，
    // 所以切外观就是换个 class，即选即生效、不用重启；特效另有开关（见 fpb-motion）。
    var THEMES = [
      {
        id: 'indigo', label: 'theme.indigo', accent: '#23558f', light: true, sweep: true,
        preview: 'linear-gradient(180deg,#edf3fb,#e2ebf6)',
        vars: '--fpb-bar-bg:#e6eef8;--fpb-bar-line:#c4d5ea;--fpb-acc:#23558f;--fpb-acc-dim:#9db2cc;--fpb-acc-text:#1c4575;--fpb-acc-wash:rgba(35,85,143,.14);--fpb-chip:rgba(35,85,143,.13);--fpb-no-bg:#d8e4f1;--fpb-no-text:#6b7887;--fpb-panel-bg:#eff4fa;--fpb-item-line:#dbe5f0;--fpb-cur:rgba(35,85,143,.1);--fpb-text:#17222f;--fpb-text-dim:#56626f;--fpb-text-faint:#6f7b88;--fpb-q:#222d3a;--fpb-hover:rgba(35,85,143,.1);--fpb-warn:#8a5a12;--fpb-warn-wash:rgba(216,150,40,.16);--fpb-warn-line:rgba(170,110,20,.42)',
        rules: [
          '.fpb-bar{border-left:0;overflow:hidden;padding-left:14px;background:linear-gradient(180deg,#edf3fb,#e2ebf6);box-shadow:inset 3px 0 0 #23558f,inset 6px 0 0 rgba(35,85,143,.22),inset 0 1px 0 rgba(255,255,255,.95),0 3px 9px -3px rgba(0,0,0,.5)}',
          '.fpb-bar:after{content:"";position:absolute;top:0;bottom:0;width:34%;left:-40%;pointer-events:none;background:linear-gradient(100deg,transparent,rgba(35,85,143,.38) 45%,transparent 92%);transform:translateX(0);transition:transform .75s ease}',
          '.fpb-bar:hover{border-color:#a8c4e0;background:linear-gradient(180deg,#f4f8fd,#eaf1f9);box-shadow:inset 3px 0 0 #23558f,inset 6px 0 0 rgba(35,85,143,.3),inset 0 1px 0 rgba(255,255,255,1),0 0 0 1px rgba(35,85,143,.22),0 12px 26px -14px rgba(35,85,143,.6)}',
          '.fpb-bar:hover:after{transform:translateX(330%)}',
          '.fpb-badge{box-shadow:inset 0 0 0 1px rgba(35,85,143,.3)}',
          '.fpb-panel{border-color:rgba(35,85,143,.22);background:linear-gradient(180deg,#f4f8fc,#e9f1f8)}',
          '.fpb-count{box-shadow:inset 0 0 0 1px rgba(35,85,143,.26)}',
          '.fpb-foot{border-top-color:rgba(35,85,143,.14)}'
        ]
      },
      {
        id: 'blush', label: 'theme.blush', accent: '#a8284c', light: true, sweep: true,
        preview: 'linear-gradient(180deg,#fdedf1,#f7e3e8)',
        vars: '--fpb-bar-bg:#fbe8ec;--fpb-bar-line:#eecddb;--fpb-acc:#a8284c;--fpb-acc-dim:#dda2b1;--fpb-acc-text:#8a2040;--fpb-acc-wash:rgba(168,40,76,.14);--fpb-chip:rgba(168,40,76,.13);--fpb-no-bg:#f2d9df;--fpb-no-text:#8a7077;--fpb-panel-bg:#fdf1f4;--fpb-item-line:#f0dce2;--fpb-cur:rgba(168,40,76,.1);--fpb-text:#2a1a1e;--fpb-text-dim:#6b5459;--fpb-text-faint:#83696f;--fpb-q:#38252a;--fpb-hover:rgba(168,40,76,.1);--fpb-warn:#8a5a12;--fpb-warn-wash:rgba(216,150,40,.16);--fpb-warn-line:rgba(170,110,20,.42)',
        rules: [
          '.fpb-bar{border-left:0;border-radius:11px;overflow:hidden;background:radial-gradient(130% 150% at 0% 50%,rgba(168,40,76,.16),transparent 58%),linear-gradient(180deg,#fdedf1,#f7e3e8);box-shadow:inset 0 1px 0 rgba(255,255,255,.95),0 3px 9px -3px rgba(0,0,0,.5)}',
          '.fpb-bar:before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,#c9405f,rgba(168,40,76,.2))}',
          '.fpb-bar:after{content:"";position:absolute;top:0;bottom:0;width:34%;left:-40%;pointer-events:none;background:linear-gradient(100deg,transparent,rgba(168,40,76,.38) 45%,transparent 92%);transform:translateX(0);transition:transform .75s ease}',
          '.fpb-bar:hover{border-color:#e6b9c6;background:radial-gradient(130% 150% at 0% 50%,rgba(168,40,76,.22),transparent 58%),linear-gradient(180deg,#fef4f7,#fae9ee);box-shadow:inset 0 1px 0 rgba(255,255,255,1),0 0 0 1px rgba(168,40,76,.28),0 12px 26px -14px rgba(168,40,76,.55)}',
          '.fpb-bar:hover:after{transform:translateX(330%)}',
          '.fpb-badge{border-radius:8px;box-shadow:inset 0 0 0 1px rgba(168,40,76,.3)}',
          '.fpb-panel{border-color:rgba(168,40,76,.2);background:linear-gradient(180deg,#fef6f8,#f8e9ee)}',
          '.fpb-count{box-shadow:inset 0 0 0 1px rgba(168,40,76,.28)}',
          '.fpb-foot{border-top-color:rgba(168,40,76,.14)}'
        ]
      },
      {
        id: 'mint', label: 'theme.mint', accent: '#267157', light: true, sweep: false,
        preview: 'linear-gradient(180deg,#ebf5ef,#dfeee5)',
        vars: '--fpb-bar-bg:#e4f1ea;--fpb-bar-line:#bfe0d2;--fpb-acc:#267157;--fpb-acc-dim:#8fc3af;--fpb-acc-text:#1f5c46;--fpb-acc-wash:rgba(38,113,87,.15);--fpb-chip:rgba(38,113,87,.14);--fpb-no-bg:#d6e8de;--fpb-no-text:#6a7d74;--fpb-panel-bg:#eef6f1;--fpb-item-line:#d8e8df;--fpb-cur:rgba(38,113,87,.1);--fpb-text:#1a2722;--fpb-text-dim:#55685f;--fpb-text-faint:#6d8078;--fpb-q:#26362f;--fpb-hover:rgba(38,113,87,.11);--fpb-warn:#8a5a12;--fpb-warn-wash:rgba(216,150,40,.16);--fpb-warn-line:rgba(170,110,20,.42)',
        rules: [
          '.fpb-bar{border:1px solid rgba(38,113,87,.34);border-radius:12px;overflow:hidden;background:linear-gradient(180deg,#ebf5ef,#dfeee5);box-shadow:0 0 0 1px rgba(38,113,87,.08),0 8px 20px -14px rgba(38,113,87,.55)}',
          '.fpb-bar:before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,#2f8b6c,rgba(38,113,87,.22))}',
          '.fpb-bar:hover{background:linear-gradient(180deg,#f1f9f4,#e6f2ea);box-shadow:0 0 0 1px rgba(38,113,87,.14),0 14px 28px -16px rgba(38,113,87,.65)}',
          '.fpb-badge{border-radius:8px;box-shadow:inset 0 0 0 1px rgba(38,113,87,.32)}',
          '.fpb-panel{border-color:rgba(38,113,87,.24);background:linear-gradient(180deg,#f2f9f5,#eaf4ee)}',
          '.fpb-count{box-shadow:inset 0 0 0 1px rgba(38,113,87,.3)}',
          '.fpb-foot{border-top-color:rgba(38,113,87,.16)}'
        ]
      },
      {
        id: 'iris', label: 'theme.iris', accent: '#5f42a3', light: true, sweep: false,
        preview: 'linear-gradient(120deg,#f8f4fe,#f4edfb)',
        vars: '--fpb-bar-bg:#f2ecfa;--fpb-bar-line:#ddd1ee;--fpb-acc:#5f42a3;--fpb-acc-dim:#b39ddc;--fpb-acc-text:#4d3588;--fpb-acc-wash:rgba(95,66,163,.14);--fpb-chip:rgba(95,66,163,.13);--fpb-no-bg:#e7def3;--fpb-no-text:#77707f;--fpb-panel-bg:#f7f3fc;--fpb-item-line:#e6ddf1;--fpb-cur:rgba(95,66,163,.1);--fpb-text:#221d29;--fpb-text-dim:#615a6b;--fpb-text-faint:#7a7384;--fpb-q:#2f2838;--fpb-hover:rgba(95,66,163,.1);--fpb-warn:#8a5a12;--fpb-warn-wash:rgba(216,150,40,.16);--fpb-warn-line:rgba(170,110,20,.42)',
        rules: [
          '.fpb-bar{border-left:0;overflow:hidden;background:linear-gradient(120deg,#f8f4fe,#eee5f9 55%,#f4edfb);box-shadow:inset 0 1px 0 rgba(255,255,255,.95),0 3px 9px -3px rgba(0,0,0,.5)}',
          '.fpb-bar:before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,#7a5cc4,rgba(95,66,163,.2))}',
          '.fpb-bar:hover{border-color:#cbb6ea;background:linear-gradient(120deg,#fbf8ff,#f3ebfc 55%,#f8f2fd);box-shadow:inset 0 1px 0 rgba(255,255,255,1),0 0 0 1px rgba(95,66,163,.26),0 11px 24px -13px rgba(95,66,163,.5)}',
          '.fpb-badge{border-radius:11px;padding:0 8px;box-shadow:inset 0 0 0 1px rgba(95,66,163,.3)}',
          '.fpb-panel{border-color:rgba(95,66,163,.22);background:linear-gradient(120deg,#faf7ff,#f2ebfa)}',
          '.fpb-count{box-shadow:inset 0 0 0 1px rgba(95,66,163,.28)}',
          '.fpb-foot{border-top-color:rgba(95,66,163,.14)}'
        ]
      },
      {
        id: 'ink', label: 'theme.ink', accent: '#7fd1c0',
        preview: 'linear-gradient(180deg,#23262d,#15171a)',
        vars: '--fpb-bar-bg:#1b1c20;--fpb-bar-line:#34373e;--fpb-acc:#7fd1c0;--fpb-acc-dim:#3f6f62;--fpb-acc-text:#cfeee2;--fpb-acc-wash:rgba(127,209,192,.16);--fpb-chip:#262e2c;--fpb-no-bg:#26282e;--fpb-no-text:#8b8b95;--fpb-panel-bg:#1e2024;--fpb-item-line:#2c2f35;--fpb-cur:#232b29;--fpb-text:#ececf1;--fpb-text-dim:#909298;--fpb-text-faint:#5c5e64;--fpb-q:#d6d8de',
        rules: [
          '.fpb-bar{position:relative;overflow:hidden;background:linear-gradient(180deg,#23262d,#1a1c21 52%,#15171a);border-color:#3b3f48 #34373e #2a2d33;border-left:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 -1px 0 rgba(0,0,0,.4),0 1px 0 rgba(0,0,0,.45)}',
          '.fpb-bar:before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,#7fd1c0,rgba(127,209,192,.22))}',
          '.fpb-bar:hover{background:linear-gradient(180deg,#282c34,#1e2126 52%,#181a1e);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),inset 0 -1px 0 rgba(0,0,0,.4),0 0 0 1px rgba(127,209,192,.18),0 10px 22px -14px rgba(127,209,192,.5)}',
          '.fpb-badge{background:linear-gradient(180deg,#2f3a37,#242c2a);color:#8fe6d4;box-shadow:inset 0 0 0 1px rgba(127,209,192,.3),0 0 12px -4px rgba(127,209,192,.55)}',
          '.fpb-panel{background:linear-gradient(180deg,#22242a,#1c1e22 18%,#191b1e);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}',
          '.fpb-count{background:linear-gradient(180deg,#2f3a37,#252d2b);box-shadow:inset 0 0 0 1px rgba(127,209,192,.22)}'
        ]
      },
      {
        id: 'phos', label: 'theme.phos', accent: '#d8b45f',
        preview: 'linear-gradient(180deg,#181a1d,#111215)',
        vars: '--fpb-bar-bg:#131417;--fpb-bar-line:#2b2d31;--fpb-acc:#d8b45f;--fpb-acc-dim:#4a3d1e;--fpb-acc-text:#f4d68f;--fpb-acc-wash:rgba(216,180,95,.14);--fpb-chip:#201d15;--fpb-no-bg:#1f2023;--fpb-no-text:#8a8a92;--fpb-panel-bg:#15171a;--fpb-item-line:#232529;--fpb-cur:#211d13;--fpb-text:#e8e5dc;--fpb-text-dim:#8b8d92;--fpb-text-faint:#585a60;--fpb-q:#d5d3ca;--fpb-hover:rgba(216,180,95,.12)',
        rules: [
          '.fpb-bar{position:relative;border-left:0;border-radius:8px;overflow:hidden;font-family:"Cascadia Mono","Cascadia Code",Consolas,monospace;background:repeating-linear-gradient(180deg,rgba(232,229,220,.035) 0 1px,transparent 1px 3px),linear-gradient(180deg,#181a1d,#111215);box-shadow:inset 0 0 26px -14px rgba(216,180,95,.45),0 1px 0 rgba(0,0,0,.5)}',
          '.fpb-bar:before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#e8c977,#b9903f);box-shadow:0 0 12px rgba(216,180,95,.45)}',
          '.fpb-bar:hover{background:repeating-linear-gradient(180deg,rgba(232,229,220,.05) 0 1px,transparent 1px 3px),linear-gradient(180deg,#1c1f22,#141618);box-shadow:inset 0 0 26px -12px rgba(216,180,95,.6),0 0 0 1px rgba(216,180,95,.22)}',
          '.fpb-text{font-size:13.5px}',
          '.fpb-label{font-size:11.5px;letter-spacing:.12em}',
          '.fpb-badge{border-radius:4px;background:#1f1c14;color:#f0c96a;text-shadow:0 0 9px rgba(216,180,95,.75);animation:fpb-breathe 2.6s ease-in-out infinite alternate}',
          '.fpb-ic.fpb-ok{animation:fpb-flash .5s ease-out}',
          '.fpb-panel{font-family:"Cascadia Mono","Cascadia Code",Consolas,monospace}',
          '.fpb-item.fpb-cur{background:linear-gradient(90deg,rgba(216,180,95,.1),transparent 62%)}',
          '.fpb-count{border:1px solid rgba(216,180,95,.32);background:transparent;color:#e3c179}',
          '.fpb-no{border-radius:4px}',
          '.fpb-cur .fpb-no{background:#3a3117;color:#f0c96a}'
        ]
      },
      {
        id: 'tide', label: 'theme.tide', accent: '#6cc7e8',
        preview: 'linear-gradient(90deg,#14293b,#242236)',
        vars: '--fpb-bar-bg:#1a212a;--fpb-bar-line:#2c3742;--fpb-acc:#6cc7e8;--fpb-acc-dim:#2f5766;--fpb-acc-text:#cfeaf5;--fpb-acc-wash:rgba(108,199,232,.16);--fpb-chip:#1f3340;--fpb-no-bg:#232a33;--fpb-no-text:#8b9098;--fpb-panel-bg:#181f27;--fpb-item-line:#242c35;--fpb-cur:#1c2a33;--fpb-text:#e7eff5;--fpb-text-dim:#8ea0ad;--fpb-text-faint:#5c6b76;--fpb-q:#d0dce5',
        rules: [
          '.fpb-bar{position:relative;overflow:hidden;background:linear-gradient(90deg,#14293b,#1b2734 44%,#242236);border-color:#31404d #2c3742 #262f39;border-left:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),inset 0 -1px 0 rgba(0,0,0,.42),0 1px 0 rgba(0,0,0,.45)}',
          '.fpb-bar:before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,#8ad7f2,rgba(108,199,232,.2))}',
          '.fpb-bar:hover{background:linear-gradient(90deg,#173044,#1f2c3b 44%,#292640);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 -1px 0 rgba(0,0,0,.42),0 0 0 1px rgba(108,199,232,.2),0 10px 22px -14px rgba(108,199,232,.55)}',
          '.fpb-badge{background:linear-gradient(180deg,#22404f,#1c3341);color:#9adcf5;box-shadow:inset 0 0 0 1px rgba(108,199,232,.3),0 0 12px -4px rgba(108,199,232,.6)}',
          '.fpb-panel{background:linear-gradient(90deg,#16222c,#182029 55%,#1d1e2a);box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}',
          '.fpb-count{background:linear-gradient(180deg,#22404f,#1d3442);box-shadow:inset 0 0 0 1px rgba(108,199,232,.22)}'
        ]
      },
      {
        id: 'ember', label: 'theme.ember', accent: '#e8b45f',
        preview: 'linear-gradient(180deg,#36231a,#1a1110)',
        vars: '--fpb-bar-bg:#241713;--fpb-bar-line:#3d2820;--fpb-acc:#e8b45f;--fpb-acc-dim:#5a3d1d;--fpb-acc-text:#f6d9a0;--fpb-acc-wash:rgba(232,180,95,.16);--fpb-chip:#3a2717;--fpb-no-bg:#2c201a;--fpb-no-text:#9a8b81;--fpb-panel-bg:#221915;--fpb-item-line:#33231b;--fpb-cur:#2f2116;--fpb-text:#f2e9e0;--fpb-text-dim:#ad9a8d;--fpb-text-faint:#736156;--fpb-q:#e5d7c9;--fpb-warn:#f0904a;--fpb-warn-wash:rgba(240,144,74,.16);--fpb-warn-line:rgba(240,144,74,.5)',
        rules: [
          '.fpb-bar{position:relative;overflow:hidden;background:linear-gradient(180deg,#36231a,#241713 58%,#1a1110);border-color:#4f3223 #3d2820 #2a1a15;border-left:0;box-shadow:inset 0 1px 0 rgba(255,231,199,.12),inset 0 -1px 0 rgba(0,0,0,.45),0 1px 0 rgba(0,0,0,.5)}',
          '.fpb-bar:before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,#f3cd85,rgba(232,180,95,.22))}',
          '.fpb-bar:hover{background:linear-gradient(180deg,#40291e,#2a1b15 58%,#1e1312);box-shadow:inset 0 1px 0 rgba(255,231,199,.16),inset 0 -1px 0 rgba(0,0,0,.45),0 0 0 1px rgba(232,180,95,.22),0 10px 22px -14px rgba(232,180,95,.55)}',
          '.fpb-badge{background:linear-gradient(180deg,#4a3018,#392412);color:#f3cd85;box-shadow:inset 0 0 0 1px rgba(232,180,95,.34),0 0 12px -4px rgba(232,180,95,.6)}',
          '.fpb-panel{background:linear-gradient(180deg,#2a1d17,#221915 22%,#1d1412);box-shadow:inset 0 1px 0 rgba(255,231,199,.09)}',
          '.fpb-count{background:linear-gradient(180deg,#4a3018,#3a2513);color:#f3cd85;box-shadow:inset 0 0 0 1px rgba(232,180,95,.26)}',
          '.fpb-cur .fpb-no{background:#5a3d1d;color:#f6d9a0}'
        ]
      },
      {
        id: 'dusk', label: 'theme.dusk', accent: '#a692ea',
        preview: 'linear-gradient(120deg,#26193b,#14242e)',
        vars: '--fpb-bar-bg:#1c1e2f;--fpb-bar-line:#332b49;--fpb-acc:#a692ea;--fpb-acc-dim:#463a6b;--fpb-acc-text:#d9ccf8;--fpb-acc-wash:rgba(166,146,234,.16);--fpb-chip:#2e2547;--fpb-no-bg:#262237;--fpb-no-text:#8f89a0;--fpb-panel-bg:#1b1826;--fpb-item-line:#292438;--fpb-cur:#262038;--fpb-text:#ece9f6;--fpb-text-dim:#9d95b0;--fpb-text-faint:#686178;--fpb-q:#dcd6ea',
        rules: [
          '.fpb-bar{position:relative;overflow:hidden;background:linear-gradient(120deg,#26193b,#1d1e2f 52%,#14242e);border-color:#3c3257 #332b49 #2a2438;border-left:0;box-shadow:inset 0 1px 0 rgba(230,222,255,.09),inset 0 -1px 0 rgba(0,0,0,.42),0 1px 0 rgba(0,0,0,.45)}',
          '.fpb-bar:before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:3px;border-radius:0 3px 3px 0;background:linear-gradient(180deg,#c3b1f7,rgba(166,146,234,.2))}',
          '.fpb-bar:hover{background:linear-gradient(120deg,#2e1f47,#22233a 52%,#182b37);box-shadow:inset 0 1px 0 rgba(230,222,255,.12),inset 0 -1px 0 rgba(0,0,0,.42),0 0 0 1px rgba(166,146,234,.2),0 10px 22px -14px rgba(166,146,234,.55)}',
          '.fpb-badge{background:linear-gradient(180deg,#372c58,#2b2245);color:#c9b8f6;box-shadow:inset 0 0 0 1px rgba(166,146,234,.32),0 0 12px -4px rgba(166,146,234,.6)}',
          '.fpb-panel{background:linear-gradient(120deg,#221a34,#1b1826 55%,#16212b);box-shadow:inset 0 1px 0 rgba(230,222,255,.07)}',
          '.fpb-count{background:linear-gradient(180deg,#372c58,#2c2347);box-shadow:inset 0 0 0 1px rgba(166,146,234,.24)}'
        ]
      },
      {
        id: 'band', label: 'theme.band', accent: '#7fd1c0',
        preview: 'linear-gradient(90deg,#4fa594,#17191c)',
        vars: '--fpb-bar-bg:#17191c;--fpb-bar-line:#2b3232;--fpb-acc:#7fd1c0;--fpb-acc-dim:#3f6f62;--fpb-acc-text:#d6f2e9;--fpb-acc-wash:rgba(127,209,192,.18);--fpb-chip:#7fd1c0;--fpb-no-bg:#232629;--fpb-no-text:#8b9098;--fpb-panel-bg:#1a1d1f;--fpb-item-line:#252a2b;--fpb-cur:#1f2624;--fpb-text:#eef3f1;--fpb-text-dim:#93a49f;--fpb-text-faint:#617069;--fpb-q:#d6e4de',
        rules: [
          '.fpb-bar{position:relative;border-left:0;padding-left:14px;overflow:hidden;background:linear-gradient(90deg,rgba(127,209,192,.26),rgba(127,209,192,.11) 22%,rgba(127,209,192,.03) 40%,rgba(255,255,255,.02) 62%,transparent),#17191c;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),inset 0 -1px 0 rgba(0,0,0,.4)}',
          '.fpb-bar:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,#9ce4d4,#4fa594)}',
          '.fpb-bar:hover{background:linear-gradient(90deg,rgba(127,209,192,.34),rgba(127,209,192,.15) 24%,rgba(127,209,192,.04) 44%,rgba(255,255,255,.03) 66%,transparent),#1a1d20;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 -1px 0 rgba(0,0,0,.4),0 0 0 1px rgba(127,209,192,.16),0 10px 22px -14px rgba(127,209,192,.5)}',
          '.fpb-badge{background:linear-gradient(180deg,#8fdcc9,#63bda9);color:#10231f;font-weight:700;box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 3px 10px -4px rgba(127,209,192,.7)}',
          '.fpb-panel{background:linear-gradient(90deg,rgba(127,209,192,.12),rgba(127,209,192,.04) 26%,rgba(127,209,192,0) 46%),#1a1d1f}',
          '.fpb-count{background:linear-gradient(180deg,#8fdcc9,#63bda9);color:#10231f}',
          '.fpb-cur .fpb-no{background:var(--fpb-acc-dim);color:#d6f2e9}'
        ]
      }
    ];
    var DEFAULT_THEME = 'ink';   // 甲 · 墨玉分层：插件最初的视觉，也是"恢复默认"的落点

    // 亮色外观要在根节点上多打一个 fpb-lt 标记，样式里那组"跟主题走"的补丁靠它生效。
    function isLightTheme(id) {
      for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return !!THEMES[i].light;
      return false;
    }

    var THEME_CSS = [];
    for (var theme_i = 0; theme_i < THEMES.length; theme_i++) {
      var theme = THEMES[theme_i];
      var scope = '[' + HOST_ATTR + '] .fpb-root.fpb-t-' + theme.id + (theme.light ? '.fpb-lt' : '');
      THEME_CSS.push(scope + '{' + theme.vars + '}');
      for (var rule_i = 0; rule_i < theme.rules.length; rule_i++) THEME_CSS.push(scope + ' ' + theme.rules[rule_i]);
    }

    var STYLE = [
      '[' + HOST_ATTR + ']{display:flex;flex-direction:column;align-items:center;' + ACC_VARS + '}',
      '[' + HOST_ATTR + '=""]{flex:none;box-sizing:border-box;padding:8px 20px 0;-webkit-app-region:no-drag}',
      // 降级路径：找不到会话正文锚点时只能内联在标题区的动作簇里，给个体面的宽度。
      '[' + HOST_ATTR + '="inline"]{width:38vw;min-width:240px;max-width:520px}',
      '[' + HOST_ATTR + '] .fpb-root{min-width:0;width:100%;max-width:var(--dsh-composer-card-max-width,100%);display:flex;flex-direction:column;gap:8px}',
      '[' + HOST_ATTR + '] .fpb-bar{display:flex;align-items:center;gap:12px;min-height:40px;box-sizing:border-box;padding:0 6px 0 10px;background:var(--fpb-bar-bg);border:1px solid var(--fpb-bar-line);border-left:3px solid var(--fpb-acc);border-radius:9px;position:relative;transition:background .16s,border-color .16s,box-shadow .16s}',
      '[' + HOST_ATTR + '] .fpb-badge{flex:none;display:grid;place-items:center;min-width:22px;height:22px;padding:0 5px;border-radius:6px;background:var(--fpb-chip);color:var(--fpb-acc);font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}',
      '[' + HOST_ATTR + '] .fpb-label{flex:none;font-size:12.5px;color:var(--fpb-text-dim)}',
      '[' + HOST_ATTR + '] .fpb-flag{flex:none;padding:1px 8px;border-radius:20px;background:var(--fpb-warn-wash);border:1px solid var(--fpb-warn-line);color:var(--fpb-warn);font-size:11.5px;line-height:18px;white-space:nowrap;cursor:help}',
      // 跳转进行中的牌跟"不完整"牌同一个形状，换成当前外观的主色系，表示"在忙"而不是"有问题"。
      '[' + HOST_ATTR + '] .fpb-flag.fpb-wait{background:var(--fpb-acc-wash);border-color:var(--fpb-acc-dim);color:var(--fpb-acc-text);cursor:default}',
      '[' + HOST_ATTR + '] .fpb-text{flex:1;min-width:0;font-size:14.5px;line-height:20px;color:var(--fpb-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:text}',
      '[' + HOST_ATTR + '] .fpb-acts{flex:none;display:flex;gap:2px}',
      // 条上两个图标（复制 / 展开折叠）静止时就染当前外观的主色：原先走正文弱色，跟条底糊成一片，
      // 鼠标不悬停根本看不出那儿有按钮能点。颜色全取 --fpb-* 变量，十套外观自动跟手，规则本身不用动。
      '[' + HOST_ATTR + '] .fpb-ic{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--fpb-acc);cursor:pointer}',
      '[' + HOST_ATTR + '] .fpb-ic:hover{background:var(--fpb-acc-wash);color:var(--fpb-acc-text)}',
      '[' + HOST_ATTR + '] .fpb-ic:focus-visible{outline:2px solid var(--fpb-acc);outline-offset:1px}',
      '[' + HOST_ATTR + '] .fpb-ic.fpb-on{background:var(--fpb-acc-wash);color:var(--fpb-acc-text)}',
      // 展开态静止时已经有那层淡主色底（和 hover 撞色了），所以悬停改成加一圈主色描边，保证鼠标移上去永远有反馈。
      '[' + HOST_ATTR + '] .fpb-ic.fpb-on:hover{box-shadow:inset 0 0 0 1px var(--fpb-acc-dim)}',
      // 复制成功：图标本身已经从"两份纸"换成"对勾"，这里再补淡主色底提亮；phos 主题那圈金色闪光是 box-shadow 动画，不在这条里，照旧。
      '[' + HOST_ATTR + '] .fpb-ic.fpb-ok{background:var(--fpb-acc-wash);color:var(--fpb-acc-text)}',
      '[' + HOST_ATTR + '] .ico{display:block;width:15px;height:15px}',
      '[' + HOST_ATTR + '] .fpb-panel{overflow:hidden;background:var(--fpb-panel-bg);border:1px solid var(--fpb-bar-line);border-radius:9px}',
      '[' + HOST_ATTR + '] .fpb-phead{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px;border-bottom:1px solid var(--fpb-bar-line)}',
      '[' + HOST_ATTR + '] .fpb-ptitle{font-size:13.5px;color:var(--fpb-text)}',
      '[' + HOST_ATTR + '] .fpb-count{padding:2px 8px;border-radius:20px;background:var(--fpb-chip);color:var(--fpb-acc);font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums}',
      '[' + HOST_ATTR + '] .fpb-x{margin-left:auto}',
      '[' + HOST_ATTR + '] .fpb-list{max-height:min(46vh,360px);overflow-y:auto;padding:2px 0;overscroll-behavior:contain}',
      '[' + HOST_ATTR + '] .fpb-item{display:flex;align-items:flex-start;gap:12px;padding:10px 12px 10px 14px;cursor:pointer;transition:background .12s}',
      '[' + HOST_ATTR + '] .fpb-item:hover{background:var(--fpb-hover)}',
      '[' + HOST_ATTR + '] .fpb-item:focus-visible{outline:2px solid var(--fpb-acc);outline-offset:-2px}',
      '[' + HOST_ATTR + '] .fpb-item+.fpb-item{border-top:1px solid var(--fpb-item-line)}',
      '[' + HOST_ATTR + '] .fpb-item.fpb-cur{background:var(--fpb-cur)}',
      '[' + HOST_ATTR + '] .fpb-no{flex:none;display:grid;place-items:center;min-width:22px;height:22px;margin-top:1px;padding:0 5px;border-radius:6px;background:var(--fpb-no-bg);color:var(--fpb-no-text);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}',
      '[' + HOST_ATTR + '] .fpb-cur .fpb-no{background:var(--fpb-acc-dim);color:var(--fpb-acc-text)}',
      '[' + HOST_ATTR + '] .fpb-body{flex:1;min-width:0}',
      '[' + HOST_ATTR + '] .fpb-q{font-size:14px;line-height:1.65;color:var(--fpb-q);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}',
      '[' + HOST_ATTR + '] .fpb-meta{margin-top:4px;font-size:11.5px;color:var(--fpb-text-faint)}',
      '[' + HOST_ATTR + '] .fpb-copy{margin-top:1px;opacity:.5}',
      '[' + HOST_ATTR + '] .fpb-item:hover .fpb-copy{opacity:1}',
      '[' + HOST_ATTR + '] .fpb-foot{display:flex;align-items:center;gap:16px;padding:8px 14px;border-top:1px solid var(--fpb-bar-line);font-size:11.5px;color:var(--fpb-text-faint)}',
      '[' + HOST_ATTR + '] .fpb-foot .fpb-right{margin-left:auto}',
      '[' + HOST_ATTR + '] .fpb-kbd{padding:0 5px;border:1px solid var(--fpb-bar-line);border-radius:4px;color:var(--fpb-text-dim);font:inherit;font-size:11px}',
      // 外观选择器（点面板头的滑杆图标开合，插在面板头与提问列表之间）
      '[' + HOST_ATTR + '] .fpb-themer{padding:12px 14px;border-top:1px solid var(--fpb-item-line);background:rgba(255,255,255,.025)}',
      '[' + HOST_ATTR + '] .fpb-th-head{display:flex;align-items:center;gap:10px;margin-bottom:11px}',
      '[' + HOST_ATTR + '] .fpb-th-title{font-size:12.5px;color:var(--fpb-text-dim);letter-spacing:.02em}',
      '[' + HOST_ATTR + '] .fpb-th-reset{padding:0;border:0;background:none;font:inherit;font-size:12px;color:var(--fpb-text-faint);cursor:pointer}',
      '[' + HOST_ATTR + '] .fpb-th-reset:hover{color:var(--fpb-text)}',
      '[' + HOST_ATTR + '] .fpb-th-reset:focus-visible,[' + HOST_ATTR + '] .fpb-toggle:focus-visible{outline:2px solid var(--fpb-acc);outline-offset:1px}',
      '[' + HOST_ATTR + '] .fpb-th-collapse{margin-left:auto}',
      '[' + HOST_ATTR + '] .fpb-swgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px}',
      '[' + HOST_ATTR + '] .fpb-sw{position:relative;box-sizing:border-box;padding:7px 9px 9px;border:1px solid var(--fpb-item-line);border-radius:9px;background:var(--fpb-panel-bg);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .14s,box-shadow .14s,transform .14s}',
      '[' + HOST_ATTR + '] .fpb-sw:hover{border-color:#3f4248;transform:translateY(-1px)}',
      '[' + HOST_ATTR + '] .fpb-sw:focus-visible{outline:2px solid var(--fpb-acc);outline-offset:1px}',
      '[' + HOST_ATTR + '] .fpb-sw .pv{position:relative;display:block;height:26px;border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,.08);background:var(--g)}',
      '[' + HOST_ATTR + '] .fpb-sw .pv:before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:3px;border-radius:0 3px 3px 0;background:var(--c)}',
      '[' + HOST_ATTR + '] .fpb-sw .pv:after{content:"";position:absolute;left:9px;top:11px;width:52%;height:4px;border-radius:3px;background:rgba(255,255,255,.26)}',
      '[' + HOST_ATTR + '] .fpb-sw .nm{display:block;margin-top:7px;font-size:12px;color:var(--fpb-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '[' + HOST_ATTR + '] .fpb-sw.fpb-cur{border-color:var(--fpb-acc);box-shadow:0 0 0 1px var(--fpb-acc-dim)}',
      '[' + HOST_ATTR + '] .fpb-sw.fpb-cur .nm{color:var(--fpb-text)}',
      // 勾用当前外观的主色，不用色板里那套预览色：它是界面元素，该跟着正在用的主题走。
      '[' + HOST_ATTR + '] .fpb-sw.fpb-cur:after{content:"\\2713";position:absolute;right:7px;top:6px;width:17px;height:17px;border-radius:50%;display:grid;place-items:center;background:var(--fpb-acc);color:#0f2320;font-size:11px;font-weight:700;line-height:17px;box-shadow:0 0 0 1px rgba(0,0,0,.35)}',
      '[' + HOST_ATTR + '] .fpb-th-foot{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:11.5px;color:var(--fpb-text-faint)}',
      '[' + HOST_ATTR + '] .fpb-th-foot .fpb-right{margin-left:auto}',
      '[' + HOST_ATTR + '] .fpb-toggle{flex:none;position:relative;box-sizing:border-box;width:32px;height:18px;padding:0;border-radius:20px;border:1px solid var(--fpb-bar-line);background:#2a2a30;cursor:pointer;transition:background .16s,border-color .16s}',
      '[' + HOST_ATTR + '] .fpb-toggle:before{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#8b8b95;transition:transform .16s,background .16s}',
      '[' + HOST_ATTR + '] .fpb-toggle.fpb-on{background:var(--fpb-acc-dim);border-color:var(--fpb-acc)}',
      '[' + HOST_ATTR + '] .fpb-toggle.fpb-on:before{transform:translateX(14px);background:var(--fpb-acc)}',
      // 亮色外观公共补丁：开关底色/圆点与色板描边原本写死深色，浅底上必须跟着当前主题走。
      '[' + HOST_ATTR + '] .fpb-root.fpb-lt .fpb-toggle{background:var(--fpb-no-bg);border-color:var(--fpb-bar-line)}',
      '[' + HOST_ATTR + '] .fpb-root.fpb-lt .fpb-toggle:before{background:var(--fpb-text-faint)}',
      '[' + HOST_ATTR + '] .fpb-root.fpb-lt .fpb-toggle.fpb-on{background:var(--fpb-acc-dim);border-color:var(--fpb-acc)}',
      '[' + HOST_ATTR + '] .fpb-root.fpb-lt .fpb-toggle.fpb-on:before{transform:translateX(14px);background:var(--fpb-acc)}',
      '[' + HOST_ATTR + '] .fpb-root.fpb-lt .fpb-sw .pv{border-color:rgba(0,0,0,.2)}',
      '[' + HOST_ATTR + '] .fpb-root.fpb-lt .fpb-sw .pv:after{background:rgba(0,0,0,.16)}',
      '[' + HOST_ATTR + '] .fpb-root.fpb-lt .fpb-sw:hover{border-color:var(--fpb-text-faint)}',
      '[' + HOST_ATTR + '] .fpb-root.fpb-lt .fpb-flag{font-weight:600}',
      '@keyframes fpb-breathe{from{box-shadow:0 0 0 0 rgba(216,180,95,.05)}to{box-shadow:0 0 14px 1px rgba(216,180,95,.38)}}',
      '@keyframes fpb-flash{from{box-shadow:0 0 0 0 rgba(216,180,95,.55)}to{box-shadow:0 0 0 12px rgba(216,180,95,0)}}',
      // 跳转落点的高亮框：盖在目标行外面的独立元素（挂在 body 上），官方 React 重渲染碰不到它；
      // 淡入淡出由 flashRow 逐帧写 opacity（框要贴着行走，位置每帧重算），这里只管样子。
      '.fpb-hl{position:fixed;z-index:2147483000;pointer-events:none;box-sizing:border-box;border:2px solid #7fd1c0;border-radius:10px;background:rgba(127,209,192,.12);box-shadow:0 0 0 1px rgba(0,0,0,.35);opacity:0}',
      // 特效开关关掉时只留底色：徽标呼吸、复制闪光、悬停光带都停掉（嫌闪就用这个，不用整套餐掉）。
      '[' + HOST_ATTR + '] .fpb-root:not(.fpb-motion) .fpb-badge{animation:none !important}',
      '[' + HOST_ATTR + '] .fpb-root:not(.fpb-motion) .fpb-ic.fpb-ok{animation:none !important}',
      '[' + HOST_ATTR + '] .fpb-root:not(.fpb-motion) .fpb-bar:after{display:none}',
      '@media (prefers-reduced-motion:reduce){' +
        '[' + HOST_ATTR + '] .fpb-badge{animation:none !important}' +
        '[' + HOST_ATTR + '] .fpb-bar:after{display:none !important}' +
        '[' + HOST_ATTR + '] .fpb-sw,[' + HOST_ATTR + '] .fpb-bar{transition:none}' +
      '}',
      '[' + ANCHOR_ATTR + ']{display:none}',
      // 条目本体 portal 到正文后，官方给它包的那层 wrapper 就是个空壳，但空壳照样占一个 flex gap，
      // 所以整层摘掉。规则只认"直接子节点里有我们的锚点"这个事实，不写死 [data-slot="…"] 的转义名，
      // 也不写死官方 hash 类名：官方将来改命名，这条规则顶多是不再命中，不会牵连别的东西。
      '[data-slot]:has(> [' + ANCHOR_ATTR + '="hosted"]){display:none}',
    ].concat(THEME_CSS).join('\n');

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      var tag = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
      if (!tag) {
        tag = document.createElement('style');
        tag.setAttribute('data-plugin', NS);
        tag.setAttribute('data-plugin-css', STYLE_ID);
        tag.textContent = STYLE;
        document.head.appendChild(tag);
        return;
      }
      // 插件被热重载时 <head> 里那截样式是上一版留下的、不会跟着模块走：内容不同就地换掉，
      // 免得改了样式还得整页刷新才看得见。
      if (tag.textContent !== STYLE) tag.textContent = STYLE;
    }

    // ---------------------------------------------------------------- 图标

    function svg(size, paths) {
      var kids = [];
      for (var i = 0; i < paths.length; i++) kids.push(createElement(paths[i][0], Object.assign({ key: i }, paths[i][1])));
      return createElement.apply(null, ['svg', {
        className: 'ico',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' }
      }].concat(kids));
    }

    var PATHS = {
      copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2.5 }], ['path', { d: 'M15.5 5.5H6a2 2 0 0 0-2 2v9' }]],
      boxDown: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }], ['path', { d: 'M8 11l4 4 4-4' }]],
      boxUp: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }], ['path', { d: 'M8 14l4-4 4 4' }]],
      close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
      check: [['polyline', { points: '20 6 9 17 4 12' }]],
      sliders: [['path', { d: 'M4 8h8M17.5 8H20M4 16h3M11.5 16H20' }], ['circle', { cx: 14.5, cy: 8, r: 2.1 }], ['circle', { cx: 9, cy: 16, r: 2.1 }]]
    };

    // ---------------------------------------------------------------- 小工具

    function textOfContent(content) {
      if (!content || typeof content.length !== 'number') return '';
      var out = '';
      for (var i = 0; i < content.length; i++) {
        var block = content[i];
        if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
      }
      return out;
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function fmtTime(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '';
      var date = new Date(value < 1e11 ? value * 1000 : value);
      if (isNaN(date.getTime())) return '';
      var hm = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
      var now = new Date();
      if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return hm;
      if (date.getFullYear() === now.getFullYear()) return (date.getMonth() + 1) + '-' + date.getDate() + ' ' + hm;
      return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate() + ' ' + hm;
    }

    /** 把原文写进剪贴板：优先官方 primitives.writeClipboard，退回浏览器 API，再退回 execCommand。 */
    function copyText(text) {
      if (primitives && typeof primitives.writeClipboard === 'function') {
        try { return Promise.resolve(primitives.writeClipboard(text)); } catch (e) { /* 继续退回 */ }
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        try { return navigator.clipboard.writeText(text); } catch (e) { /* 继续退回 */ }
      }
      return new Promise(function (resolve, reject) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand ? document.execCommand('copy') : false;
          document.body.removeChild(ta);
          ok ? resolve() : reject(new Error('execCommand copy failed'));
        } catch (error) { reject(error); }
      });
    }

    /**
     * 把某行滚到滚动区顶部（上方留 24px，跟官方跳轮次的落点对齐一个感觉）。
     * 自己找最近的纵向滚动祖先算 scrollTop：scrollIntoView 各家行为不一致，
     * 而且聊天区开了 overflow-anchor:none，直接算数值最可控。
     */
    function scrollToRow(row) {
      if (!row || !row.isConnected) return false;
      var scroller = null;
      var probe = row.parentElement;
      while (probe) {
        if (probe.scrollHeight > probe.clientHeight + 1) {
          var overflow;
          try { overflow = window.getComputedStyle(probe).overflowY; } catch (error) { overflow = ''; }
          if (overflow === 'auto' || overflow === 'scroll') { scroller = probe; break; }
        }
        probe = probe.parentElement;
      }
      if (!scroller) {   // 找不到可滚祖先就直接用浏览器自己的滚法兜底
        try { row.scrollIntoView({ block: 'start' }); return true; } catch (error) { return false; }
      }
      var top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += top - 24;
      return true;
    }

    /**
     * 在目标行外面盖一个独立的描边框闪一下：元素挂在 body 上，官方 React 重渲染碰不到它。
     * 框每一帧重新贴着行放——跳转后官方阅读状态机还会再挪一两次滚动，
     * 固定位置的框会跟落点脱开，看着像凭空多出来一个框（实测踩过）。
     * 高度封顶 1/3 屏：落点行要是连着一整段被折叠的过程，框出认得出的一段就够，别糊满屏幕。
     */
    function flashRow(row) {
      if (typeof document === 'undefined' || !row || !row.isConnected) return;
      try {
        var layer = document.createElement('div');
        layer.className = 'fpb-hl';
        layer.setAttribute('aria-hidden', 'true');
        document.body.appendChild(layer);
        var start = Date.now();
        var DUR = 1400;
        var gone = false;
        function remove() {
          if (gone) return;
          gone = true;
          if (layer.parentNode) layer.parentNode.removeChild(layer);
        }
        function place() {
          if (gone) return;
          if (!row.isConnected) { remove(); return; }
          var age = Date.now() - start;
          if (age >= DUR) { remove(); return; }
          var r = row.getBoundingClientRect();
          var left = Math.max(2, r.left - 6);
          var top = Math.max(2, r.top - 6);
          layer.style.left = left + 'px';
          layer.style.top = top + 'px';
          layer.style.width = Math.max(40, Math.min(r.width + 12, window.innerWidth - left - 4)) + 'px';
          layer.style.height = Math.max(24, Math.min(r.height + 12, Math.floor(window.innerHeight * 0.34), window.innerHeight - top - 4)) + 'px';
          var op = age < DUR * 0.1 ? age / (DUR * 0.1) : (age > DUR * 0.6 ? Math.max(0, 1 - (age - DUR * 0.6) / (DUR * 0.4)) : 1);
          layer.style.opacity = String(op);
          window.requestAnimationFrame(place);
        }
        window.requestAnimationFrame(place);
      } catch (error) {}
    }

    /** 刚按发送、还没落库的那条就在聊天流最底下：滚到最后一行 = 滚到它。 */
    function scrollToLatest(sessionId) {
      var body = findConversationBody(sessionId);
      if (!body) return;
      var rows;
      try { rows = body.querySelectorAll('[data-chat-node-key]'); } catch (error) { return; }
      if (rows.length) scrollToRow(rows[rows.length - 1]);
    }

    /** 会话正文容器：它是 flex column，往里插的第一行会把消息区整体往下挤。 */
    function findConversationBody(sessionId) {
      if (typeof document === 'undefined') return null;
      var nodes = document.querySelectorAll('[data-conversation-content]');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('data-conversation-session') === sessionId) return nodes[i];
      }
      return null;
    }

    /**
     * 「对话」标签正在显示吗？判据是聊天流容器 `[data-chat-flow]` 在不在这一篇正文里：
     * 这个属性由聊天视图自己渲染（dsh-client-ui-conversation 的 chat 视图根节点），
     * 切到「轨迹」等别的视图时那一整块会被换掉，属性就没了。
     * 正文本身找不到时返回 true —— 宁可照常显示，也不要因为判不准把常驻条莫名藏掉。
     */
    function isChatViewMounted(body) {
      if (!body) return true;
      try { return !!body.querySelector('[data-chat-flow]'); } catch (error) { return true; }
    }

    var HOST_STATE_NO_BODY = { host: null, chatVisible: true };    // 正文还没出现：走内联降级
    var HOST_STATE_OTHER_VIEW = { host: null, chatVisible: false }; // 当前显示的不是「对话」：什么都不渲染

    /**
     * 把宿主 div 挂到会话正文的第一个子节点位置，只在「对话」标签下挂着：
     * 切到轨迹时把宿主整个摘掉，一点位置都不给别的视图占。
     * 官方切会话 / 重建正文都会连我们的宿主一起丢，所以这里必须持续确认，不能挂一次就完事。
     */
    function useConversationHost(sessionId) {
      var state = React.useState(HOST_STATE_NO_BODY);
      var hostState = state[0];
      var setHostState = state[1];

      React.useLayoutEffect(function () {
        if (typeof document === 'undefined') return void 0;
        var disposed = false;
        var node = null;
        var attempts = 0;
        var queued = false;
        var lastHost = null;
        var lastVisible = true;

        function publish(host, chatVisible) {
          if (host === lastHost && chatVisible === lastVisible) return;
          lastHost = host;
          lastVisible = chatVisible;
          setHostState({ host: host, chatVisible: chatVisible });
        }

        function dropNode() {
          if (node && node.parentNode) node.parentNode.removeChild(node);
        }

        function tick() {
          if (disposed) return false;
          var body = findConversationBody(sessionId);
          if (!body) {
            dropNode();
            publish(null, true);
            return false;
          }
          if (!isChatViewMounted(body)) {   // 「轨迹」或别的视图：摘掉宿主，也不留空行
            dropNode();
            publish(null, false);
            return false;
          }
          if (!node || !node.isConnected) {
            if (!node) {
              node = document.createElement('div');
              node.setAttribute(HOST_ATTR, '');
            }
            dropNode();
            body.insertBefore(node, body.firstChild);
          }
          publish(node, true);
          return true;
        }

        // 标签一切换，正文里的视图整块被换掉，MutationObserver 立刻告诉我们，不用等巡检。
        var observing = null;
        var observer = typeof MutationObserver === 'function' ? new MutationObserver(function () { schedule(); }) : null;
        function schedule() {
          if (disposed || queued) return;
          queued = true;
          window.requestAnimationFrame(function () {
            queued = false;
            if (disposed) return;
            var body = findConversationBody(sessionId);
            if (body && observer && observing !== body) {
              try { observer.observe(body, { childList: true, subtree: true }); observing = body; } catch (error) { observer = null; }
            }
            tick();
          });
        }
        schedule();

        // 首帧可能还没渲染出正文：退避重试几次，之后就交给巡检。
        (function retry() {
          if (disposed || attempts >= 6) return;
          attempts++;
          if (tick()) return;
          window.setTimeout(retry, attempts * 120);
        })();

        var poll = window.setInterval(function () {
          if (disposed) return;
          if (!node || !node.isConnected) tick();
        }, REATTACH_MS);

        return function () {
          disposed = true;
          window.clearInterval(poll);
          if (observer) { try { observer.disconnect(); } catch (error) {} }
          dropNode();
          setHostState(HOST_STATE_NO_BODY);
        };
      }, [sessionId]);

      return hostState;
    }

    // ---------------------------------------------------------------- 图标按钮

    function IconButton(props) {
      return createElement('button', {
        type: 'button',
        className: 'fpb-ic' + (props.on ? ' fpb-on' : '') + (props.className ? ' ' + props.className : ''),
        title: props.title,
        'aria-label': props.label || props.title,
        'aria-expanded': props.expanded,
        onClick: props.onClick
      }, svg(15, props.icon));
    }

    // ---------------------------------------------------------------- 面板

    function PromptList(props) {
      var items = props.items;
      var t = props.t;
      var copiedId = props.copiedId;
      var kids = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var isLast = i === items.length - 1;
        var jump = props.onJump ? props.onJump(item) : function () {};
        kids.push(createElement('div', {
          key: item.id,
          className: 'fpb-item' + (isLast ? ' fpb-cur' : ''),
          role: 'button',
          tabIndex: 0,
          title: t('panel.jump'),
          onClick: jump,
          onKeyDown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); }
          }
        },
          createElement('span', { className: 'fpb-no' }, String(i + 1)),
          createElement('div', { className: 'fpb-body' },
            createElement('div', { className: 'fpb-q' }, item.text),
            createElement('div', { className: 'fpb-meta' }, item.time
              ? t('panel.meta', { time: fmtTime(item.time), chars: String(item.text.length) })
              : t('panel.sending'))
          ),
          createElement(IconButton, {
            className: 'fpb-copy' + (copiedId === item.id ? ' fpb-ok' : ''),
            icon: copiedId === item.id ? PATHS.check : PATHS.copy,
            title: copiedId === item.id ? t('panel.copied') : t('panel.copy'),
            onClick: props.onCopy(item)
          })
        ));
      }
      return kids;
    }

    /** 外观选择器：色板网格，每格就是一截迷你常驻条，选中那格描边 + 打勾。 */
    function ThemePicker(props) {
      var t = props.t;
      var tiles = [];
      for (var i = 0; i < THEMES.length; i++) {
        var theme = THEMES[i];
        var current = theme.id === props.theme;
        tiles.push(createElement('button', {
          key: theme.id,
          type: 'button',
          className: 'fpb-sw' + (current ? ' fpb-cur' : ''),
          style: { '--g': theme.preview, '--c': theme.accent },
          title: theme.sweep ? t('theme.pick') + ' · ' + t('theme.sweep') : t('theme.pick'),
          'aria-pressed': current ? 'true' : 'false',
          onClick: (function (id) { return function () { props.onPick(id); }; })(theme.id)
        },
          createElement('span', { className: 'pv' }),
          createElement('span', { className: 'nm' }, t(theme.label))
        ));
      }
      return createElement('div', { className: 'fpb-themer' },
        createElement('div', { className: 'fpb-th-head' },
          createElement('span', { className: 'fpb-th-title' }, t('theme.title')),
          createElement('button', {
            type: 'button',
            className: 'fpb-th-reset',
            title: t('theme.reset'),
            onClick: function () { props.onPick(DEFAULT_THEME); }
          }, t('theme.reset')),
          createElement(IconButton, {
            className: 'fpb-th-collapse',
            icon: PATHS.boxUp,
            title: t('set.close'),
            onClick: props.onCollapse
          })
        ),
        createElement('div', { className: 'fpb-swgrid' }, tiles),
        createElement('div', { className: 'fpb-th-foot' },
          createElement('button', {
            type: 'button',
            className: 'fpb-toggle' + (props.motion ? ' fpb-on' : ''),
            role: 'switch',
            'aria-checked': props.motion ? 'true' : 'false',
            title: t('theme.motion'),
            'aria-label': t('theme.motion'),
            onClick: function () { props.onMotion(!props.motion); }
          }),
          createElement('span', null, t('theme.motion')),
          createElement('span', { className: 'fpb-right' }, t('theme.applied'))
        )
      );
    }

    function Panel(props) {
      var t = props.t;
      return createElement('div', { className: 'fpb-panel' },
        createElement('div', { className: 'fpb-phead' },
          createElement('span', { className: 'fpb-ptitle' }, t('panel.title')),
          createElement('span', { className: 'fpb-count' }, t('panel.count', { n: String(props.items.length) })),
          createElement(IconButton, {
            className: 'fpb-set',
            icon: PATHS.sliders,
            on: props.themeOpen,
            title: props.themeOpen ? t('set.close') : t('set.open'),
            expanded: props.themeOpen ? 'true' : 'false',
            onClick: props.onToggleTheme
          }),
          createElement(IconButton, {
            className: 'fpb-x',
            icon: PATHS.close,
            title: t('panel.close'),
            onClick: props.onClose
          })
        ),
        // 滑杆图标点开外观选择器，再点同一个图标收起；选择器插在面板头与提问列表之间，紧贴入口图标。
        props.themeOpen ? createElement(ThemePicker, {
          t: t,
          theme: props.theme,
          motion: props.motion,
          onPick: props.onPickTheme,
          onMotion: props.onMotion,
          onCollapse: props.onToggleTheme
        }) : null,
        createElement('div', { className: 'fpb-list', role: 'list' }, PromptList(props)),
        createElement('div', { className: 'fpb-foot' },
          createElement('span', null,
            createElement('kbd', { className: 'fpb-kbd' }, 'Esc'),
            ' ' + t('panel.esc')
          ),
          createElement('span', null, t('panel.outside')),
          createElement('span', { className: 'fpb-right' }, props.truncated ? t('panel.more', { n: String(MAX_PROMPTS) }) : t('panel.copyHint'))
        )
      );
    }

    // ---------------------------------------------------------------- 常驻条

    function FirstPromptBar(props) {
      var state = React.useState(false);
      var open = state[0];
      var setOpen = state[1];
      var copied = React.useState(null);
      var copiedId = copied[0];
      var setCopiedId = copied[1];
      var rootRef = React.useRef(null);
      var t = props.t;
      var items = props.items;
      // 外观与特效是全局设置：读一次进 state（useState 收函数初始化，只在挂载时读一次）。
      // 切外观只是换 root 上的 class，CSS 早就注入好了，所以即选即生效、不用重启。
      var look = React.useState(readTheme);
      var theme = look[0];
      var setTheme = look[1];
      var motionState = React.useState(readMotion);
      var motionOn = motionState[0];
      var setMotionOn = motionState[1];
      var themeOpenState = React.useState(false);
      var themeOpen = themeOpenState[0];
      var setThemeOpen = themeOpenState[1];

      var pickTheme = React.useCallback(function (id) { setTheme(id); writeTheme(id); }, []);
      var toggleMotion = React.useCallback(function (next) { setMotionOn(next); writeMotion(next); }, []);

      React.useEffect(function () { setOpen(false); setCopiedId(null); setThemeOpen(false); }, [props.sessionId]);

      React.useEffect(function () {
        if (!open) return void 0;
        function onPointerDown(event) {
          var root = rootRef.current;
          if (!root) return;
          var target = event.target;
          if (target && root.contains(target)) return;
          setOpen(false);
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') setOpen(false);
        }
        // 捕获阶段：官方组件自己 stopPropagation 也照样收得到"点外面"。
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [open]);

      var makeCopier = React.useCallback(function (item) {
        return function (event) {
          // 面板行整行可点（跳位置），复制按钮的点击不能顺带触发跳转。
          if (event && event.stopPropagation) event.stopPropagation();
          copyText(item.text).then(function () {
            setCopiedId(item.id);
          }, function () { setCopiedId('failed'); });
        };
      }, []);

      React.useEffect(function () {
        if (copiedId === null) return void 0;
        var timer = window.setTimeout(function () { setCopiedId(null); }, COPIED_FEEDBACK_MS);
        return function () { window.clearTimeout(timer); };
      }, [copiedId]);

      // 跳转的过程反馈：够不着东西时在常驻条上挂张小牌（'working' 正在加载 / 'failed' 这条已被压缩掉），
      // 成功就把牌子摘掉。失败牌 2.6 秒自动消失，不赖着不走。
      var jumpFlagState = React.useState(null);
      var jumpFlag = jumpFlagState[0];
      var setJumpFlag = jumpFlagState[1];
      var jumpFlagTimer = React.useRef(null);
      var jumpCancel = React.useRef(null);

      function clearJumpFlag() {
        if (jumpFlagTimer.current) { window.clearTimeout(jumpFlagTimer.current); jumpFlagTimer.current = null; }
        setJumpFlag(null);
      }

      // 切会话：旧跳转和牌子一律作废（跳转轮询是盯着旧会话的 DOM 的）。
      React.useEffect(function () {
        return function () {
          if (jumpCancel.current) { jumpCancel.current(); jumpCancel.current = null; }
          if (jumpFlagTimer.current) window.clearTimeout(jumpFlagTimer.current);
          jumpFlagTimer.current = null;
          setJumpFlag(null);
        };
      }, [props.sessionId]);

      var makeJumper = React.useCallback(function (item) {
        return function () {
          setOpen(false);   // 要"直接跳转"：先收起面板，腾出整个聊天区看落点
          if (jumpCancel.current) jumpCancel.current();
          var id = item && item.id ? String(item.id) : '';
          if (id.charAt(0) === 'p') { scrollToLatest(props.sessionId); return; }   // 发送中的回声：它就在聊天流最底下
          if (!item || typeof item.seq !== 'number' || item.seq < 1 || typeof props.jump !== 'function') {
            // 插件装上前就在的老记录只记了文本、没记 seq：没有可信的位置可跳，明说，不瞎滚。
            if (jumpFlagTimer.current) window.clearTimeout(jumpFlagTimer.current);
            setJumpFlag('failed');
            jumpFlagTimer.current = window.setTimeout(function () { jumpFlagTimer.current = null; setJumpFlag(null); }, 2600);
            return;
          }
          jumpCancel.current = props.jump(props.sessionId, item.seq, {
            busy: function (on) {
              if (!on) return;
              if (jumpFlagTimer.current) { window.clearTimeout(jumpFlagTimer.current); jumpFlagTimer.current = null; }
              setJumpFlag('working');
            },
            landed: function (row) {
              jumpCancel.current = null;
              clearJumpFlag();
              scrollToRow(row);
              flashRow(row);
              // 官方阅读状态机在我们滚完之后的渲染里还会自行调一两次位置：350ms 后看它挪歪了就再对齐一次（高亮框每帧跟行，不用管）。
              window.setTimeout(function () {
                try { if (row.isConnected) scrollToRow(row); } catch (error) {}
              }, 350);
            },
            done: function () {
              jumpCancel.current = null;
              if (jumpFlagTimer.current) window.clearTimeout(jumpFlagTimer.current);
              setJumpFlag('failed');
              jumpFlagTimer.current = window.setTimeout(function () { jumpFlagTimer.current = null; setJumpFlag(null); }, 2600);
            }
          });
        };
      }, [props.sessionId]);

      if (!items.length) return null;
      var first = items[0];

      return createElement('div', {
        className: 'fpb-root fpb-t-' + theme + (isLightTheme(theme) ? ' fpb-lt' : '') + (motionOn ? ' fpb-motion' : ''),
        ref: rootRef,
        'data-prompt-bar-root': props.hosted ? 'hosted' : 'inline'
      },
        createElement('div', { className: 'fpb-bar' },
          createElement('span', { className: 'fpb-badge' }, '1'),
          createElement('span', { className: 'fpb-label' }, t('bar.label')),
          createElement('span', { className: 'fpb-text', title: first.text }, first.text),
          // 完整列表一直没读到（没这个接口 / 翻页读史失败）：打一张「不完整」小牌，说明现在显示的只是页面已加载的那一段。
          props.degraded ? createElement('span', {
            className: 'fpb-flag',
            title: t('bar.incomplete.note', { why: t('why.' + props.degraded) })
          }, t('bar.incomplete')) : null,
          // 跳转过程的小牌：正在往回加载 / 这条太早跳不到。悬停看完整说明。
          jumpFlag ? createElement('span', {
            className: 'fpb-flag' + (jumpFlag === 'working' ? ' fpb-wait' : ''),
            title: t(jumpFlag === 'working' ? 'jump.working' : 'jump.failed')
          }, t(jumpFlag === 'working' ? 'jump.working' : 'jump.failed')) : null,
          createElement('span', { className: 'fpb-acts' },
            createElement(IconButton, {
              className: copiedId === first.id ? 'fpb-ok' : '',
              icon: copiedId === first.id ? PATHS.check : PATHS.copy,
              title: copiedId === first.id ? t('panel.copied') : t('bar.copy'),
              onClick: makeCopier(first)
            }),
            createElement(IconButton, {
              icon: open ? PATHS.boxUp : PATHS.boxDown,
              on: open,
              title: open ? t('bar.collapse') : t('bar.expand'),
              expanded: open ? 'true' : 'false',
              onClick: function () { setOpen(function (value) { return !value; }); }
            })
          )
        ),
        open ? createElement(Panel, {
          t: t,
          items: items,
          truncated: props.truncated,
        stats: props.stats,
          copiedId: copiedId,
          onCopy: makeCopier,
          onJump: makeJumper,
          onClose: function () { setOpen(false); },
          themeOpen: themeOpen,
          onToggleTheme: function () { setThemeOpen(function (value) { return !value; }); },
          theme: theme,
          motion: motionOn,
          onPickTheme: pickTheme,
          onMotion: toggleMotion
        }) : null
      );
    }

    // ---------------------------------------------------------------- 数据读取

    /**
     * 提问列表有三个来源，可靠程度从高到低：
     *  1) 宿主半从**完整事件日志**读出来的那份——权威，不受界面分页影响（还没点「加载更早」也认得真正的第一条）；
     *  2) 浏览器这边 chat 视图快照里的那份——窗口化的（会话太长时只有近期一段），宿主没接通或还没回话时用它顶着；
     *  3) pendingSubmissions——已经按下发送、还没落库的本地回声，负责"回车那一瞬间常驻条就出现"。
     * 1 和 2 按 seq 归并：刚发出去的那条立刻出现（来自 2），更早的历史随后由 1 补齐。
     */
    var promptCache = new Map();     // sessionId -> { items, seqSet, truncated }
    var promptTimers = new Map();    // sessionId -> 防抖计时器
    var promptBusy = new Set();      // 正在路上的请求，避免重复敲宿主
    var promptCooldown = new Map();  // sessionId -> 失败后的冷却截止时刻（宿主半没装上时别反复撞）
    var jumpTimers = new Map();      // sessionId -> 正在进行中的跳转（新跳转顶掉旧的轮询）
    var promptFail = new Map();      // sessionId -> 上次失败的原因键（常驻条据此打「不完整」小牌）

    function needsFetch(cached, durable) {
      if (!cached || !cached.seqSet) return true;
      if (durable.length > cached.items.length) return true;
      var first = durable[0];
      var last = durable[durable.length - 1];
      if (first && !cached.seqSet.has(first.seq)) return true;
      if (last && !cached.seqSet.has(last.seq)) return true;
      return false;
    }

    /** 两份都是 seq 升序；归并成一份并按 seq 去重，同一 seq 用窗口那份（更贴近当前界面）。 */
    function mergePrompts(authoritative, windowed) {
      if (!authoritative || !authoritative.length) return windowed || [];
      if (!windowed || !windowed.length) return authoritative;
      var out = [];
      var seen = new Set();
      var i = 0;
      var j = 0;
      while (i < authoritative.length || j < windowed.length) {
        var a = i < authoritative.length ? authoritative[i] : null;
        var b = j < windowed.length ? windowed[j] : null;
        var take;
        if (a && b && a.seq === b.seq) { take = b; i++; j++; }
        else if (a && (!b || a.seq < b.seq)) { take = a; i++; }
        else { take = b; j++; }
        if (take && !seen.has(take.seq)) { seen.add(take.seq); out.push(take); }
      }
      return out;
    }

    /**
     * 生成一组读数据的闭包。ctx 只在 apply 里可用，所以闭包在 apply 里建好再传给组件，
     * 组件里不碰 ctx（升级时只有这一处需要核对 API）。
     */
    function createReader(ctx) {
      function sessionBinding(sessionId) {
        try { return ctx.sessions.binding(sessionId); } catch (error) { return void 0; }
      }
      function chatSource(binding) {
        try {
          var uiConversation = ctx.get('uiConversation');
          if (!uiConversation || typeof uiConversation.binding !== 'function') return void 0;
          var bound = uiConversation.binding(binding);
          if (!bound || typeof bound.target !== 'function') return void 0;
          return bound.target(CHAT_VIEW);
        } catch (error) { return void 0; }
      }
      /**
       * 界面窗口里我发起的提问，按会话里的先后顺序。
       * 只认 kind==='user' | 'steering'：注入上下文、唤醒模型的 context、compact 检查点都不是人写的
       * （官方聊天视图自己也是这么判的：user/message 事件并且 data.source.kind === 'user' 才算人发的）。
       * durable = 已落库的，pending = 按了发送还没落库的本地回声。
       */
      function read(sessionId) {
        var binding = sessionBinding(sessionId);
        if (!binding || !binding.session || typeof binding.session.getSnapshot !== 'function') {
          return { binding: void 0, blank: true, durable: [], pending: [] };
        }
        var snapshot;
        try { snapshot = binding.session.getSnapshot(); } catch (error) { return { binding: binding, blank: true, durable: [], pending: [] }; }
        if (!snapshot) return { binding: binding, blank: true, durable: [], pending: [] };
        var durable = [];
        var chatComplete = false;   // 聊天窗口见底了（官方 store 的 hasMore === false）：这时窗口里的第一条就是真第一条
        if (!snapshot.blank) {
          var chat;
          try { chat = chatSource(binding).getSnapshot(); } catch (error) { chat = void 0; }
          if (chat && chat.order && chat.nodes) {
            chatComplete = chat.hasMore === false;
            for (var i = 0; i < chat.order.length; i++) {
              var node = chat.nodes.get(chat.order[i]);
              if (!node || (node.kind !== 'user' && node.kind !== 'steering')) continue;
              var data = node.data || {};
              var text = textOfContent(data.content);
              if (!text) continue;
              durable.push({ id: 'e:' + String(data.seq), seq: typeof data.seq === 'number' ? data.seq : -1, text: text, time: data.time });
            }
          }
        }
        var pending = [];
        var submissions = snapshot.pendingSubmissions;
        if (submissions && typeof submissions.length === 'number') {
          for (var p = 0; p < submissions.length; p++) {
            var submission = submissions[p];
            if (!submission || submission.placement !== 'transcript') continue;
            if (typeof submission.text !== 'string' || submission.text === '') continue;
            pending.push({ id: 'p:' + String(submission.requestId), seq: Number.MAX_SAFE_INTEGER, text: submission.text, time: void 0 });
          }
        }
        return { binding: binding, blank: !!snapshot.blank, durable: durable, pending: pending, complete: chatComplete && snapshot.openState === 'open' && snapshot.loadingOlder !== true };
      }
      /** 订阅会话生命周期（无副作用）；返回取消订阅。 */
      function watchSession(binding, onChange) {
        try {
          if (!binding || !binding.session || typeof binding.session.subscribe !== 'function') return function () {};
          var dispose = binding.session.subscribe(onChange);
          return typeof dispose === 'function' ? dispose : function () {};
        } catch (error) { return function () {}; }
      }
      /** 订阅 chat target；注意订阅会把该 target 激活（所以 blank 时不要订阅）。 */
      function watchChat(binding, onChange) {
        try {
          var source = chatSource(binding);
          if (!source || typeof source.subscribe !== 'function') return function () {};
          var dispose = source.subscribe(onChange);
          return typeof dispose === 'function' ? dispose : function () {};
        } catch (error) { return function () {}; }
      }
      /** 记下来的第一条：读一次就缓存，不每次都翻 localStorage。 */
      function record(sessionId) {
        if (recordMemo.has(sessionId)) return recordMemo.get(sessionId);
        var found = readRecord(sessionId);
        recordMemo.set(sessionId, found);
        return found;
      }
      /**
       * 窗口见底（hasMore=false）又看见了一条提问，就当场把第一条记下来。
       * 之后这条会话不管怎么折叠都不影响它 —— 判据已经保证"这就是第一条"。
       */
      function noteFirstPrompt(sessionId, latest) {
        if (record(sessionId)) return;
        if (!latest || !latest.complete) return;
        var first = null;
        if (latest.durable && latest.durable.length) first = latest.durable[0];
        else if (latest.pending && latest.pending.length) first = latest.pending[0];
        if (!first || typeof first.text !== 'string' || !first.text) return;
        if (writeRecord(sessionId, first.text, first.seq, true)) {
          recordMemo.set(sessionId, { text: first.text, seq: typeof first.seq === 'number' ? first.seq : null, at: Date.now() });
        }
      }
      /** 翻页读到了完整列表（没被截断）：用它的第一条覆盖记账，以后连翻页都能省掉，rewind 改过也能跟着更新。 */
      function rememberFromAuthoritative(sessionId, items, truncated) {
        if (truncated === true) return;   // 没翻到底，这一份的第一条不一定是真第一条
        if (!items || !items.length) return;
        var first = items[0];
        if (!first || typeof first.text !== 'string' || !first.text) return;
        var current = record(sessionId);
        if (current && current.seq === first.seq && current.text === first.text) return;
        if (writeRecord(sessionId, first.text, first.seq, true)) {
          recordMemo.set(sessionId, { text: first.text, seq: first.seq, at: Date.now() });
        }
      }
      var recordMemo = new Map();
      /** 已经拿到的权威列表（可能还没有）。 */
      function prompts(sessionId) { return promptCache.get(sessionId); }
      /** 最近一次向宿主取值失败了、而且至今一次都没成功：返回原因键，常驻条据此打「不完整」小牌；成功过一次就不再打。 */
      function degraded(sessionId) {
        if (promptCache.get(sessionId)) return null;
        return promptFail.get(sessionId) || null;
      }
      /** ctx.remote.session 在不在：翻页读史全靠它（老版本没有就算了，退回窗口那份）。 */
      function pageApi() {
        try {
          var ns = ctx.remote && ctx.remote.session;
          if (ns && typeof ns.page === 'function') return ns;
        } catch (error) {}
        try {
          // 有些挂载层级上按名字取更稳，再试一次。
          var byName = ctx.get && ctx.get('remote.session');
          if (byName && typeof byName.page === 'function') return byName;
        } catch (error) {}
        return null;
      }
      /** 读史失败 -> 文案键：超时单独算，其它一律算"翻页读史失败"。 */
      function reasonOfError(error) {
        var name = error && error.name ? String(error.name) : '';
        if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
        var code = error && typeof error.code === 'string' ? error.code : '';
        if (/time|abort/i.test(code)) return 'timeout';
        return 'read-failed';
      }
      /** 一条事件算不算"我打的提问"：user/message 且 data.source.kind === 'user'（跟官方聊天视图同一判据）。 */
      function isHumanPromptEvent(event) {
        if (!event || event.type !== 'user/message') return false;
        var data = event.data;
        return !!(data && data.source && data.source.kind === 'user');
      }
      /** 翻页调用：能用 AbortSignal.timeout 就加个超时，别把界面吊在一次读上。 */
      function callPage(api, request) {
        var signal;
        try {
          signal = typeof AbortSignal === 'function' && AbortSignal.timeout ? AbortSignal.timeout(PAGE_TIMEOUT_MS) : void 0;
        } catch (error) { signal = void 0; }
        return signal === void 0 ? api.page(request) : api.page(request, signal);
      }
      /** 窗口那份里最旧的 seq：接着它往前翻，免得把窗口里已有的近的那一段又翻一遍。窗口空着回 0（= 不设上界）。 */
      function oldestSeq(items) {
        var low = 0;
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (item && typeof item.seq === 'number' && (low === 0 || item.seq < low)) low = item.seq;
        }
        return low;
      }
      /** 窗口那份里最新的 seq，拿它当翻页起点，保证落在日志范围里。 */
      function latestSeq(items) {
        var top = 0;
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (item && typeof item.seq === 'number' && item.seq > top) top = item.seq;
        }
        return top;
      }
      /** 把出错原因压成一句话，标题诊断用。 */
      function errorText(error) {
        var text = error ? (error.message ? String(error.message) : String(error)) : '';
        return text.length > 140 ? text.slice(0, 140) : text;
      }
      var baseTitle = '';
      var titleSet = false;
      /**
       * 读史失败时把原因塞进窗口标题：窗口标题是浏览器外面唯一看得见的位置，
       * 排查时不用悬停、不用开发者工具。传空字符串表示"好了"，还原原标题。
       */
      function diagTitle(text) {   // 只是留个占位：往 document.title 写东西用户看不见、截图里也看不见，别再动它
        return;
        try {
          if (text) {
            if (!titleSet) { baseTitle = document.title || ''; titleSet = true; }
            document.title = 'fpb:' + text;
          } else if (titleSet) {
            document.title = baseTitle;
            titleSet = false;
          }
        } catch (error) {}
      }
      /**
       * 权威列表：用官方远程接口 ctx.remote.session.page 从落盘日志里一页页往前翻。
       * 游标字段照抄官方加载器：throughSeq = 开窗那个切点（全程固定），
       * beforeSeq = 手里最旧那条的位置（每轮往前挪）。读的是持久日志，不受界面分页影响，
       * 所以点「加载更早」也动不了它，第一条提问不会变。
       * 停手条件不信 hasMore：实测它会在还有旧内容时就回 false（那次只翻到 seq 1079 就见底了）。
       * 改成硬判据：这一页一条记录都没有 / 最旧 seq 没再往前走 / 已经摸到 seq 0 或 1 / 页数上限。
       * 成功返回 {items,seqSet,truncated}，失败返回 {fail:原因键}。
       */
      async function fetch(sessionId, hintSeq, oldestSeq) {
        var api = pageApi();
        if (!api) { diagTitle('no-api'); return { fail: 'no-api' }; }
        var address = { kind: 'session', sessionId: sessionId };
        var found = [];     // 收集所有页里的人发提问，最后统一按 seq 排序，不依赖服务端给的顺序
        var replaces = [];  // 把某一段 seq 顶掉的替换操作，用来判断某条提问还算不算数
        var cut = typeof hintSeq === 'number' && hintSeq > 0 ? hintSeq : Number.MAX_SAFE_INTEGER;
        // 窗口里已经有近的那一段，所以从窗口最旧那条接着往前翻；窗口还空着才不设上界，先拿切点往前的那一页。
        var through = typeof oldestSeq === 'number' && oldestSeq > 0 ? oldestSeq - 1 : cut;   // 游标就是切点本身，每轮往下挪；官方 loadOlder 用的那个 beforeSeq 在这儿会把第二页直接闷成空页（实测）
        var pages = 0;
        var stats = { pages: 0, lowest: null, reachedEnd: false, tail: [] };   // 面板上显示，好让人看出每页翻到了哪儿
        var prevFull = false;   // 上一页是满页（说明肯定还有更早的）
        var holeTries = 0;      // 撞上"上一页是满的、下一页却突然空了"这种坑时，往后跳一段再试
        var capped = true;
        while (pages < MAX_PAGES) {
          var request = { address: address, throughSeq: through, maxMessages: PAGE_MESSAGES, turnWindow: { minMessages: 50, minTurns: 2 } };   // 连 turnWindow 也照抄官方那份，行为尽量跟官方一致
          // 只靠 throughSeq 往回退（每轮 = 这一页最旧 seq 的前一个）：加了 beforeSeq 反而第二页直接回空，更早的提问就够不着了。
          var page;
          try {
            page = await callPage(api, request);
          } catch (error) {
            var why = reasonOfError(error);
            if (pages === 0) { diagTitle(why + ' ' + errorText(error)); return { fail: why, note: errorText(error) }; }
            return finish(found, replaces, true, stats);   // 翻到一半断了：先用手上的，照样算不完整
          }
          // 远程调用回的是信封：{ok:true, value:{records,hasMore}} 或 {ok:false, error:{code,message}}。
          var body = page && page.ok === true ? page.value : null;
          if (page && page.ok === false) {
            var bad = reasonOfError(page.error);
            if (pages === 0) { diagTitle(bad + ' ' + errorText(page.error)); return { fail: bad, note: errorText(page.error) }; }
            return finish(found, replaces, true, stats);
          }
          var records = body && Array.isArray(body.records) ? body.records : null;
          if (!records) {
            if (pages === 0) { diagTitle('read-failed value.records 不是数组'); return { fail: 'read-failed' }; }
            return finish(found, replaces, true, stats);
          }
          pages += 1;
          stats.pages = pages;
          var lowest = through + 1;   // 任何一条记录都会把它拉低；拉不动就说明没往前走
          var seen = 0;
          for (var i = 0; i < records.length; i++) {
            var record = records[i];
            var event = record && record.type === 'event' ? record.event : null;
            if (!event || typeof event.seq !== 'number') continue;
            seen += 1;
            if (event.seq < lowest) lowest = event.seq;
            var op = event.surfaceOp;
            if (op && typeof op === 'object' && op.op === 'replace' && typeof op.startSeq === 'number' && typeof op.endSeq === 'number') {
              replaces.push({ opSeq: event.seq, start: op.startSeq, end: op.endSeq });
              continue;  // 替换事件本身不是提问
            }
            if (!isHumanPromptEvent(event)) continue;
            var text = textOfContent(event.data && event.data.content);
            if (text) found.push({ seq: event.seq, time: event.time, text: text });
          }
          if (stats.tail.length < 3) stats.tail.push(String(through) + '→' + String(lowest) + ' n' + String(seen) + ' hM' + (body && body.hasMore === true ? 1 : 0));
          var wasFull = prevFull;   // 上一页满不满，用来判断"空页"到底是不是掉进缝里
          prevFull = seen >= PAGE_MESSAGES;
          if (seen === 0 && wasFull && holeTries < 4) {
            // 上一页是满的、这一页却空了：不像到底，更像切点正好落在缝里。往后跳一段再试几次。
            holeTries += 1;
            through = Math.max(0, through - 600);
            continue;
          }
          if (seen === 0) { capped = false; stats.reachedEnd = true; break; }              // 这一页一条都没有 = 到底了
          if (lowest <= 1) { capped = false; stats.reachedEnd = true; break; }             // 日志开头就在 seq 0 / 1，别再翻了
          if (stats.lowest === null || lowest < stats.lowest) stats.lowest = lowest;
          if (lowest > through) break;         // 游标没往前走，别原地打转
          through = lowest - 1;
        }
        return finish(found, replaces, capped, stats);
      }
      /** 收尾：排掉被后来的替换顶掉的旧提问、按 seq 升序、最多 MAX_PROMPTS 条，多出来算不完整。 */
      function finish(found, replaces, capped, stats) {
// 页内、页间的先后顺序我都不猜：直接按 seq 排一遍，往后走就是升序。
        found.sort(function (a, b) { return a.seq - b.seq; });
        var items = [];
        var seqs = new Set();
        for (var i = 0; i < found.length; i++) {
          var item = found[i];
          if (seqs.has(item.seq)) continue;
          var dead = false;
          for (var r = 0; r < replaces.length; r++) {
            var range = replaces[r];
            if (range.opSeq > item.seq && range.start <= item.seq && range.end >= item.seq) { dead = true; break; }
          }
          seqs.add(item.seq);
          if (dead) continue;
          if (items.length >= MAX_PROMPTS) { capped = true; continue; }
          items.push({ id: 'e:' + String(item.seq), seq: item.seq, text: item.text, time: item.time });
        }
        return { items: items, seqSet: seqs, truncated: capped, stats: stats };
      }
      /** 列表里最深（最旧）那条的 seq；空列表给最大值，比较时永远输。 */
      function firstSeq(list) {
        return list && list.items && list.items.length ? list.items[0].seq : Number.MAX_SAFE_INTEGER;
      }
      /**
       * 两条路的结果取**并集**。翻页那条不打扰界面、够得着 seq，但很老的事件正文可能已经被压缩工程抹空；
       * 窗口那条读的是聊天界面的投影，正文齐全。同一 seq 两边都有就取正文更长的那份。
       * 只要有一条确证到底，就算完整。
       */
      function mergeLists(a, b) {
        if (!a || !a.items) return b;
        if (!b || !b.items) return a;
        var bySeq = new Map();
        var order = [];
        function absorb(list, from) {
          if (!list || !list.items) return;
          for (var i = 0; i < list.items.length; i++) {
            var it = list.items[i];
            if (!it || typeof it.seq !== 'number') continue;
            var prev = bySeq.get(it.seq);
            if (!prev) {
              bySeq.set(it.seq, { seq: it.seq, text: it.text || '', time: it.time, from: from });
              order.push(it.seq);
            } else if ((it.text || '').length > prev.text.length) {
              prev.text = it.text; prev.from = from;
              if (!prev.time) prev.time = it.time;
            }
          }
        }
        absorb(a, 'page'); absorb(b, 'window');
        order.sort(function (x, y) { return x - y; });
        var items = []; var seqs = new Set(); var fromPage = 0; var fromWindow = 0;
        for (var k = 0; k < order.length && items.length < MAX_PROMPTS; k++) {
          var got = bySeq.get(order[k]);
          seqs.add(got.seq);
          if (got.from === 'page') fromPage += 1; else fromWindow += 1;
          items.push({ id: 'e:' + String(got.seq), seq: got.seq, text: got.text, time: got.time });
        }
        var reachedEnd = !!((a.stats && a.stats.reachedEnd) || (b.stats && b.stats.reachedEnd));
        // 窗口那条挖到了翻页那条挖不到的更早提问 = 历史那条没读全，值得在小字里露出来
        var debug = !reachedEnd || (b.items.length > 0 && (!a.items.length || firstSeq(b) < firstSeq(a)));
        var stats = {
          pages: (a.stats && a.stats.pages) || 0,
          lowest: (a.stats && a.stats.lowest !== null && a.stats.lowest !== void 0) ? a.stats.lowest : (b.stats ? b.stats.lowest : null),
          reachedEnd: reachedEnd, tail: (a.stats && a.stats.tail) || [],
          fromPage: fromPage, fromWindow: fromWindow, debug: debug
        };
        return { items: items, seqSet: seqs, truncated: !reachedEnd, stats: stats };
      }
      /**
       * 兜底：直接走官方那条「加载更早」。聊天界面自己用的就是 session.loadOlder()，
       * 它内部一页页往前扩窗口，直到 hasMore=false 才停，所以够得着日志开头；
       * 代价是这条会话的历史会被提前读进窗口（等于替你把「加载更早」一路点到底）。
       * 两条路都会跑（不再"只当兜底"）：历史那条够得着 seq，窗口那条正文齐全，结果取并集。
       */
      function loadWindowToBottom(sessionId) {
        return new Promise(function (resolve) {
          var binding = sessionBinding(sessionId);
          if (!binding || !binding.session || typeof binding.session.loadOlder !== 'function') { resolve(null); return; }
          var rounds = 0;
          var reachedEnd = false;
          var finished = false;
          var lastLowest = null;
          var boot = read(sessionId);
          if (boot.durable.length) lastLowest = boot.durable[0].seq;
          function atBottom() {
            var state = null;
            try { state = binding.session.getSnapshot(); } catch (error) { state = null; }
            return !!(state && state.openState === 'open' && state.hasMore === false);
          }
          function done() {
            if (finished) return;
            finished = true;
            var fresh = read(sessionId);
            var items = []; var seqs = new Set();
            for (var i = 0; i < fresh.durable.length && items.length < MAX_PROMPTS; i++) {
              var it = fresh.durable[i];
              if (seqs.has(it.seq)) continue;
              seqs.add(it.seq); items.push(it);
            }
            resolve({
              items: items, seqSet: seqs, truncated: !reachedEnd, fromWindow: true,
              stats: { pages: rounds, lowest: items.length ? items[0].seq : lastLowest, reachedEnd: reachedEnd, tail: [] }
            });
          }
          function step() {
            if (atBottom()) { reachedEnd = true; done(); return; }
            if (rounds >= LOADER_MAX_ROUNDS) { done(); return; }
            rounds += 1;
            var go = null;
            try { go = binding.session.loadOlder(); } catch (error) { done(); return; }
            if (!go || typeof go.then !== 'function') { done(); return; }
            go.then(function () {
              var next = read(sessionId);
              var lowest = next.durable.length ? next.durable[0].seq : null;
              if (lowest !== null && lastLowest !== null && lowest >= lastLowest) {
                if (atBottom()) reachedEnd = true;
                done(); return;
              }
              if (lowest !== null) lastLowest = lowest;
              window.setTimeout(step, 0);
            }, function () { done(); });
          }
          step();
        });
      }
      /**
       * 按 seq 在界面投影里找那条提问的节点，再按节点 key 在 DOM 里找它的行。
       * 聊天流的每一行由官方 ChatNodeSeat 渲染，带 data-chat-node-key（官方 chat store 的节点 key）；
       * 判 key 不判正文，正文被压缩工程抹空的行也照样在 DOM 里，能跳。
       * 投影里还没有这个节点 = 窗口还没翻到位（也可能正文已被 prune、永远等不来），由调用方轮询后定夺。
       */
      function locatePromptRow(sessionId, seq) {
        var binding = sessionBinding(sessionId);
        if (!binding) return null;
        var chat;
        try { chat = chatSource(binding).getSnapshot(); } catch (error) { chat = void 0; }
        if (!chat || !chat.order || !chat.nodes) return null;
        var key = null;
        for (var i = 0; i < chat.order.length; i++) {
          var k = chat.order[i];
          var node = chat.nodes.get(k);
          if (!node || (node.kind !== 'user' && node.kind !== 'steering')) continue;
          var data = node.data || {};
          if (data.seq === seq) { key = typeof node.key === 'string' ? node.key : String(k); break; }
        }
        if (key === null) return null;
        var body = findConversationBody(sessionId);
        if (!body) return null;
        var rows;
        try { rows = body.querySelectorAll('[data-chat-node-key]'); } catch (error) { return null; }
        for (var j = 0; j < rows.length; j++) {
          if (rows[j].dataset && rows[j].dataset.chatNodeKey === key) return rows[j];
        }
        return null;
      }
      /**
       * 跳到某条提问所在的位置（面板里点某条提问用）。
       * 会话被折叠/翻走过也没关系：官方跳轮次用的 session.loadThrough(seq) 会把窗口一页页往前扩到覆盖它，
       * 我们照抄同一条路（老接口没有 loadThrough 就退回一页页 loadOlder）。窗口到位后 DOM 是 React 画的，
       * 还要等它渲染出来，所以按拍轮询；约 5.4 秒还够不着就当它已被压缩工程抹掉，报失败，绝不静默。
       * hooks: busy(on) 加载中标记；landed(row) 成功；done() 没够着。返回取消函数。
       */
      function jumpToPrompt(sessionId, seq, hooks) {
        var entry = { timer: null };
        var prev = jumpTimers.get(sessionId);
        if (prev) window.clearTimeout(prev.timer);
        jumpTimers.set(sessionId, entry);
        var tries = 0;
        var cancelled = false;
        var busyOn = false;
        function sayBusy(on) {
          if (busyOn === on) return;
          busyOn = on;
          hooks.busy(on);
        }
        function alive() { return !cancelled && jumpTimers.get(sessionId) === entry; }
        function clear() {
          if (jumpTimers.get(sessionId) === entry) jumpTimers.delete(sessionId);
          if (entry.timer !== null) { window.clearTimeout(entry.timer); entry.timer = null; }
        }
        function finish(row) {
          clear();
          sayBusy(false);
          if (row) hooks.landed(row); else hooks.done();
        }
        function pump() {
          var binding = sessionBinding(sessionId);
          var session = binding && binding.session;
          if (!session) return;
          try {
            // loadThrough 自己就是"一页页往前翻到覆盖 seq"的循环，重复敲会把目标拉到更低值，安全。
            if (typeof session.loadThrough === 'function') { session.loadThrough(seq); return; }
            if (typeof session.loadOlder === 'function') session.loadOlder();
          } catch (error) {}
        }
        function probe() {
          if (!alive()) return;
          var row = locatePromptRow(sessionId, seq);
          if (row) { finish(row); return; }
          tries += 1;
          if (tries === 1) sayBusy(true);
          if (tries === 1 || (tries % 11 === 0 && tries < JUMP_MAX_TRIES)) pump();   // 第一拍就敲加载；之后约每秒补敲一次，中途断掉的页也能接上
          if (tries >= JUMP_MAX_TRIES) { finish(null); return; }
          entry.timer = window.setTimeout(probe, JUMP_POLL_MS);
        }
        probe();
        return function () {
          cancelled = true;
          clear();
        };
      }
      /**
       * 窗口里出现了权威那份还没有的提问（或压根还没拿过）就去敲宿主。防抖 350ms：
       * 一次发送往往连着触发好几次快照变更，敲一次就够。宿主半没装上时冷却 30 秒再试，别一直撞。
       */
      function scheduleFetch(sessionId, durable, onDone) {
        noteFirstPrompt(sessionId, read(sessionId));
        if (!needsFetch(promptCache.get(sessionId), durable)) return;
        if (promptTimers.has(sessionId)) return;
        promptTimers.set(sessionId, window.setTimeout(function () {
          promptTimers.delete(sessionId);
          if (promptBusy.has(sessionId)) return;
          var cooldown = promptCooldown.get(sessionId);
          if (cooldown && Date.now() < cooldown) return;
          var latest = read(sessionId);
          if (!needsFetch(promptCache.get(sessionId), latest.durable)) return;
          promptBusy.add(sessionId);
          var paged = null;
          fetch(sessionId, latestSeq(latest.durable), oldestSeq(latest.durable)).then(function (value) {
            paged = value;
            return loadWindowToBottom(sessionId);   // 两条都跑，结果取并集
          }, function (error) {
            paged = { fail: reasonOfError(error) };
            return loadWindowToBottom(sessionId);
          }).then(function (viaWindow) {
            var best = mergeLists(paged, viaWindow);
            if (best && best.items && best.items.length) {
              promptCache.set(sessionId, best); rememberFromAuthoritative(sessionId, best.items, best.truncated);
              promptCooldown.delete(sessionId);
              promptFail.delete(sessionId); diagTitle('');
            } else {
              promptFail.set(sessionId, (paged && paged.fail) || 'read-failed');
              promptCooldown.set(sessionId, Date.now() + 30000);
            }
          }).then(function () {
            promptBusy.delete(sessionId);
            onDone();
          });
        }, REFRESH_DEBOUNCE_MS));
      }
      var api = {
        read: read,
        binding: sessionBinding,
        watchSession: watchSession,
        watchChat: watchChat,
        prompts: prompts,
        degraded: degraded,
        scheduleFetch: scheduleFetch,
        record: record,
        jump: jumpToPrompt
      };
      createReader.__last = api;   // 自检钩子：离线脚本 apply 完就能从 exports.readerForTest() 拿到它
      return api;
    }

    // ------------------------------------------------------------- 首条提问的本地记账
    //
    // 判据不是"插件装没装"，而是更硬的两句：窗口见底（官方聊天 store 的 hasMore === false，
    // 意思是往前已经没东西可加载了）+ 看见了一条提问。这时候窗口里的第一条就是真第一条，
    // 当场把原文记进 localStorage，以后这条会话怎么折叠、翻页、被截断都动不了它 —— 因为已经在手上了。
    // 装插件之前就已经很长、窗口见底不了的会话只能靠翻页读史；翻不动就退回窗口那份，
    // 并打上「不完整」小牌说明目前只是局部。
    var RECORD_PREFIX = 'dsh-prompt-bar/first/';   // localStorage 键前缀
    var RECORD_MAX = 300;                                 // 最多记 300 个会话，超了丢最老的

    function recordKey(sessionId) { return RECORD_PREFIX + sessionId; }

    /** 读出某个会话记下来的第一条；没记过返回 null。 */
    function readRecord(sessionId) {
      try {
        var raw = window.localStorage.getItem(recordKey(sessionId));
        if (!raw) return null;
        var data = JSON.parse(raw);
        if (!data || typeof data.text !== 'string' || data.text === '') return null;
        if (data.v !== 1) return null;   // 老版本记过但没验过的，一律不认（当初它把「重启了」记成了第一条）
        return { text: data.text, seq: typeof data.seq === 'number' ? data.seq : null, at: typeof data.at === 'number' ? data.at : 0 };
      } catch (error) { return null; }
    }

    /** 记一条。写不进去（无痕模式、配额满）就算了，功能照旧。 */
    function writeRecord(sessionId, text, seq, verified) {
      try {
        window.localStorage.setItem(recordKey(sessionId), JSON.stringify({
          text: text, seq: typeof seq === 'number' ? seq : null, at: Date.now(), v: verified === true ? 1 : 0
        }));
        pruneRecords();
        return true;
      } catch (error) { return false; }
    }

    /** 只留最近 RECORD_MAX 个会话的记录，别让 localStorage 一直长。 */
    function pruneRecords() {
      try {
        var keys = [];
        for (var i = 0; i < window.localStorage.length; i++) {
          var key = window.localStorage.key(i);
          if (key && key.indexOf(RECORD_PREFIX) === 0) keys.push(key);
        }
        if (keys.length <= RECORD_MAX) return;
        var stamped = [];
        for (var k = 0; k < keys.length; k++) {
          var at = 0;
          try {
            var data = JSON.parse(window.localStorage.getItem(keys[k]));
            if (data && typeof data.at === 'number') at = data.at;
          } catch (error) {}
          stamped.push({ key: keys[k], at: at });
        }
        stamped.sort(function (a, b) { return a.at - b.at; });
        for (var j = 0; j < stamped.length - RECORD_MAX; j++) window.localStorage.removeItem(stamped[j].key);
      } catch (error) {}
    }

    // --------------------------------------------------------- 外观与特效的本地记账
    // 两条全局设置（不分会话）：用哪套外观、要不要动效。选完立刻生效——切的只是 root 上的 class，
    // 不碰数据、不重启。写不进去（无痕模式、配额满）就算了：界面当场照样能切，只是下次打开回到默认。
    var THEME_KEY = NS + '/theme';
    var MOTION_KEY = NS + '/motion';

    function themeById(id) {
      for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
      return null;
    }

    /** 记着的外观；没记过、或记的是这个版本已经没有的 id，都回到默认（甲）。 */
    function readTheme() {
      try {
        var id = window.localStorage.getItem(THEME_KEY);
        return themeById(id) ? id : DEFAULT_THEME;
      } catch (error) { return DEFAULT_THEME; }
    }

    function writeTheme(id) {
      try { if (themeById(id)) window.localStorage.setItem(THEME_KEY, id); } catch (error) {}
    }

    /** 特效开关：没记过算开（装完第一眼看完整效果，嫌闪自己去关）。 */
    function readMotion() {
      try { return window.localStorage.getItem(MOTION_KEY) !== 'off'; } catch (error) { return true; }
    }

    function writeMotion(on) {
      try { window.localStorage.setItem(MOTION_KEY, on ? 'on' : 'off'); } catch (error) {}
    }

    // ---------------------------------------------------------------- 槽位条目

    /**
     * 条目本体只出一个隐藏锚点（官方标题区里什么都不占），真正的界面 portal 到会话正文顶部。
     * 找不到正文锚点时退回内联渲染：位置会变丑（跑到标题区），但功能还在。
     */
    function createEntry(reader) {
      return function FirstPromptBarEntry(props) {
        var sessionId = props.sessionId;
        var t = props.t;
        var revision = React.useState(0);
        var setRevision = revision[1];
        var bumpRef = React.useRef(null);
        if (!bumpRef.current) bumpRef.current = function () { setRevision(function (value) { return value + 1; }); };

        var snapshotState = reader.read(sessionId);
        var blank = snapshotState.blank;
        var durable = snapshotState.durable;
        var hostState = useConversationHost(sessionId);

        // 会话生命周期（发送中、blank 翻转等）：订阅 Session 快照本身没有任何副作用，一直挂着。
        React.useEffect(function () {
          return reader.watchSession(reader.binding(sessionId), bumpRef.current);
        }, [sessionId]);

        // chat target 的订阅会把该 target 激活，blank 会话一旦被激活 phase 就从 blank 变 active、
        // 新会话的 Hero 界面会被顶掉，所以等第一条提问出现（blank=false）之后再挂。
        React.useEffect(function () {
          if (blank) return void 0;
          return reader.watchChat(reader.binding(sessionId), bumpRef.current);
        }, [sessionId, blank]);

        // 窗口里的提问一变（发了新的、切进会话后窗口刷新、rewind 改写）就去敲宿主拿完整列表。
        // key 只由「条数 + 首尾 seq」构成：模型流式输出不会改变它，所以不会被刷屏带着一路重敲。
        var durableKey = durable.length + '|' + (durable.length ? durable[0].seq + ':' + durable[durable.length - 1].seq : '');
        React.useEffect(function () {
          if (blank) return void 0;
          reader.scheduleFetch(sessionId, reader.read(sessionId).durable, bumpRef.current);
        }, [sessionId, blank, durableKey]);

        var authoritative = reader.prompts(sessionId);
        var remembered = reader.record(sessionId);
        // 记下来的那条优先。翻页那份虽然"多"，但可能没翻到底；记下来的那条是当场看见的，一定是对的。
        if (remembered) {
          var firstKnown = authoritative && authoritative.items && authoritative.items.length ? authoritative.items[0] : null;
          var better = !firstKnown
            || (remembered.seq !== null && firstKnown.seq > remembered.seq)
            || (remembered.seq === null && firstKnown.text !== remembered.text);
          if (better) {
            var kept = [];
            if (authoritative && authoritative.items) {
              for (var rI = 0; rI < authoritative.items.length; rI++) {
                var older = authoritative.items[rI];
                if (remembered.seq === null ? older.text === remembered.text : older.seq === remembered.seq) continue;
                kept.push(older);
              }
            }
            authoritative = {
              items: [{ id: 'rec', seq: remembered.seq === null ? Number.MIN_SAFE_INTEGER : remembered.seq, text: remembered.text, time: remembered.at }].concat(kept),
              seqSet: authoritative && authoritative.seqSet ? authoritative.seqSet : new Set(),
              truncated: !!(authoritative && authoritative.truncated)
            };
          }
        }
        var degradedKey = authoritative ? null : (remembered ? null : reader.degraded(sessionId));
        var merged = mergePrompts(authoritative && authoritative.items, durable);
        var lastText = merged.length ? merged[merged.length - 1].text : '';
        var echoes = [];
        for (var e = 0; e < snapshotState.pending.length; e++) {
          var echo = snapshotState.pending[e];
          if (echo.text === lastText) continue;   // 同一条其实已经落库了，别列两遍
          echoes.push(echo);
        }
        var shown = echoes.length ? merged.concat(echoes) : merged;

        // 不在「对话」标签（轨迹等视图）或压根没提问可显示：锚点标成 hosted，
        // 官方给条目包的那层空壳被样式规则整层摘掉，一点位置都不占。
        if (!hostState.chatVisible || !shown.length) {
          return createElement('span', {
            className: 'fpb-entry',
            'data-prompt-bar-entry': '',
            'aria-hidden': true
          }, createElement('span', { 'data-prompt-bar-anchor': 'hosted' }));
        }

        // 界面本体 portal 到会话正文顶部；拿不到正文锚点时退回内联渲染（位置变丑，功能还在）。
        // 锚点的值决定官方那层 wrapper 要不要摘掉：portal 成功时它是空壳，留着会白占一个 flex gap。
        var bar = createElement(FirstPromptBar, {
          sessionId: sessionId,
          t: t,
          items: shown,
          truncated: !!(authoritative && authoritative.truncated),
          degraded: degradedKey,
        stats: authoritative && authoritative.stats,
          hosted: !!hostState.host,
          jump: reader.jump
        });
        var host = hostState.host;
        return createElement('span', {
          className: 'fpb-entry',
          'data-prompt-bar-entry': '',
          'aria-hidden': host ? true : void 0
        },
          createElement('span', { 'data-prompt-bar-anchor': host ? 'hosted' : 'inline' }),
          host ? ReactDOM.createPortal(bar, host) : createElement('div', { 'data-prompt-bar': 'inline' }, bar)
        );
      };
    }

    // ---------------------------------------------------------------- 入口

    var name = 'dsh-prompt-bar';
    var inject = ['slots', 'sessions', 'locale', 'remote.session'];   // 'remote.session' 才会把 ctx.remote.session 挂上来：官方会话客户端的 inject 里写的就是 "remote.session"，只写 'remote' 拿不到 page

    function apply(ctx) {
      ensureStyle();

      ctx.effect(function () {
        return ctx.locale.register(NS, DICT);
      }, 'dsh-prompt-bar: dictionaries');

      var reader = createReader(ctx);

      try {
        ctx.slots.inject(SLOT, function () {
          return ctx.slots.register({
            name: SLOT,
            id: 'dsh-prompt-bar',
            order: 1000,
            locale: NS,
            inject: function () {
              return { t: ctx.locale.bind(NS) };
            }
          }, createEntry(reader));
        });
      } catch (error) {
        console.warn('[dsh-prompt-bar] ' + SLOT + ' 槽位不可用，已跳过挂载：', (error && error.message) || error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    // 暴露出去便于自检（控制台里能直接拿到组件与样式串）
    exports.FirstPromptBar = FirstPromptBar;
    exports.styleText = STYLE;
    exports.themes = THEMES;
    // 自检通道：apply 跑完后离线脚本/控制台可以直接调 reader.jump 验证跳转，不用碰界面。
    exports.readerForTest = function () { return createReader.__last || null; };
    return module.exports;
  }
});
