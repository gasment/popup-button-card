//v2.3.0
/* === NEW: 在 Lovelace 配置里查找 content_id 对应的内容源 === */
function __pbcFindContentInConfig(rootCfg, targetId) {
  if (!rootCfg || !targetId) return null;
  const id = String(targetId);

  const visitCard = (card) => {
    if (!card || typeof card !== 'object') return null;

    // 命中内容源：type + card_function + content_id
    const t = (card.type || '').toLowerCase();
    const isPBC = t === 'custom:popup-button-card' || t === 'popup-button-card';
    if (isPBC && (card.card_function || 'button') === 'content' && String(card.content_id || '') === id) {
      const c = card.content || {};
      if (Array.isArray(c.cards)) return { type: 'vertical-stack', cards: c.cards };
      if (c.card) return c.card;
      return { type: 'markdown', content: `⚠️ 内容源 #${id} 未提供 content.card 或 content.cards` };
    }

    // 递归常见容器
    const arrayKeys = ['cards', 'elements', 'badges', 'sections'];
    for (const k of arrayKeys) {
      const arr = card[k];
      if (Array.isArray(arr)) {
        for (const sub of arr) {
          // sections 里通常仍然有 cards
          if (k === 'sections' && sub && Array.isArray(sub.cards)) {
            for (const c2 of sub.cards) {
              const r = visitCard(c2);
              if (r) return r;
            }
          } else {
            const r = visitCard(sub);
            if (r) return r;
          }
        }
      }
    }
    // 支持 stack-in-card 等的单个 card
    if (card.card && typeof card.card === 'object') {
      const r = visitCard(card.card);
      if (r) return r;
    }
    return null;
  };

  // 遍历各个视图
  const views = Array.isArray(rootCfg?.views) ? rootCfg.views : [];
  for (const v of views) {
    // 直接 cards
    if (Array.isArray(v.cards)) {
      for (const c of v.cards) {
        const r = visitCard(c);
        if (r) return r;
      }
    }
    // Masonry sections / Grid sections
    if (Array.isArray(v.sections)) {
      for (const s of v.sections) {
        if (Array.isArray(s.cards)) {
          for (const c of s.cards) {
            const r = visitCard(c);
            if (r) return r;
          }
        }
      }
    }
  }
  return null;
}

/* === NEW: 全局内容注册表（供按钮用 from_id 引用） === */
window.__pbcContentRegistry = window.__pbcContentRegistry || new Map();
/**
 * 注册内容源
 * @param {string} id
 * @param {{getConfig:()=>object, getKey:()=>string}} provider
 */
function __pbcRegisterContent(id, provider) {
  if (!id) return;
  window.__pbcContentRegistry.set(String(id), provider);
}
function __pbcUnregisterContent(id, provider) {
  const key = String(id || '');
  const cur = window.__pbcContentRegistry.get(key);
  if (cur === provider) window.__pbcContentRegistry.delete(key);
}
function __pbcLookupContent(id) {
  if (!id) return null;
  return window.__pbcContentRegistry.get(String(id));
}

class PopupButtonCard extends HTMLElement {
  constructor() {
    super();
    this._open = false;
    this._config = {};
    this._rawConfig = {};
    this._side = 'bottom';
    this._variables = {};

    // DOM refs
    this._toggleEl = null;      // 外层容器（仅布局/命中）
    this._pressable = null;     // 内层可视包裹（全部视觉样式）
    this._popupEl = null;       // 弹层 / 遮罩（非全屏亦是内容容器）
    this._contentCard = null;   // Lovelace 卡片
    this._contentWrap = null;   // 全屏内容容器
    this._closeBtn = null;
    this._overlayEl = null;     // 非全屏模糊遮罩

    // flags
    this._closingAnim = false;
    this._fsShouldOverlayClickClose = false;
    this._justOpened = false;      // 打开后短暂期，防误关
    this._overlayArmed = false;    // 遮罩外点关闭是否就绪
    this._gestureActive = false;   // 手势期标记
    this._anchorRectOnDown = null; // 手势按下瞬间缓存的锚点矩形
    this._scrollCloseCleanup = null; // up/down 滚动关闭的解绑函数
    this._anyTapCloseTimer = null;
    this._anyTapCloseCleanup = null;
    this._openGuardUntil = 0;

    // === NEW: 内容源模式相关 ===
    this._cardFunction = 'button';   // 'button' | 'content'
    this._contentId = null;          // 内容源 id
    this._editModeTimer = null;      // 轮询编辑态
    this._contentHost = null;        // content 模式下的承载节点（仅编辑态可见）
    this._contentProvider = null;    // 注册到全局表的 provider

    // 绑定实例级事件处理器
    this._onWindowPointerDownCapture = this._onWindowPointerDownCapture.bind(this);
    this._onWindowScroll = this._onWindowScroll.bind(this);
    this._onAnimationEnd = this._onAnimationEnd.bind(this);
    this._onOverlayWheelOrTouchMove = this._onOverlayWheelOrTouchMove.bind(this);
    this._onOverlayClickToClose = this._onOverlayClickToClose.bind(this);
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    this._onWindowPointerUp = this._onWindowPointerUp.bind(this);
    this._onExpandableYieldOthers = this._onExpandableYieldOthers.bind(this);
  }

  /* ================== Lovelace/模板系统工具 ================== */
  static _getLovelaceConfig() {
    try {
      const ha = document.querySelector("home-assistant");
      const main = ha?.shadowRoot?.querySelector("home-assistant-main");
      const drawer = main?.shadowRoot?.querySelector("app-drawer-layout partial-panel-resolver");
      const root = (drawer?.shadowRoot || main?.shadowRoot);
      const panel = root?.querySelector("ha-panel-lovelace");
      return panel?.lovelace?.config;
    } catch (e) { return undefined; }
  }
  static _getLovelace() {
    try {
      const ha = document.querySelector('home-assistant');
      const main = ha?.shadowRoot?.querySelector('home-assistant-main');
      const drawer = main?.shadowRoot?.querySelector('app-drawer-layout partial-panel-resolver');
      const root = (drawer?.shadowRoot || main?.shadowRoot);
      const panel = root?.querySelector('ha-panel-lovelace');
      return panel?.lovelace;
    } catch { return undefined; }
  }
  static _isEditMode() {
    const ll = PopupButtonCard._getLovelace();
    return !!ll?.editMode;
  }
  static _getGlobalTemplates() {
    const cfg = PopupButtonCard._getLovelaceConfig();
    return (cfg?.popup_button_card_templates
         || cfg?.button_card_templates
         || window.popup_button_card_templates
         || window.frontend_pbc_templates
         || {});
  }
  static _deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((x)=>PopupButtonCard._deepClone(x));
    const out = {}; for (const k of Object.keys(obj)) out[k] = PopupButtonCard._deepClone(obj[k]); return out;
  }
  static _deepMerge(base, ext) {
    if (base === null || typeof base !== 'object') return PopupButtonCard._deepClone(ext);
    if (ext === null || typeof ext !== 'object') return PopupButtonCard._deepClone(ext);
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (Array.isArray(base) && Array.isArray(ext)) return base.concat(ext);
    for (const k of Object.keys(ext)) {
      const bv = out[k], ev = ext[k];
      if (Array.isArray(bv) && Array.isArray(ev)) out[k] = bv.concat(ev);
      else if (bv && typeof bv === 'object' && ev && typeof ev === 'object') out[k] = PopupButtonCard._deepMerge(bv, ev);
      else out[k] = PopupButtonCard._deepClone(ev);
    }
    return out;
  }
  _resolveTemplatesAndVariables(inputCfg) {
    const globalTpl = PopupButtonCard._getGlobalTemplates();
    const tplEntries = [];
    const pushByName = (name) => {
      if (!name || typeof name !== 'string') return;
      const def = globalTpl[name];
      if (!def) { console.warn('[popup-button-card] 未找到模板:', name); return; }
      tplEntries.push({ name, def });
    };
    const rawTemplate = inputCfg.template ?? inputCfg.templates;
    if (rawTemplate) {
      if (typeof rawTemplate === 'string') pushByName(rawTemplate);
      else if (Array.isArray(rawTemplate)) rawTemplate.forEach(pushByName);
      else if (typeof rawTemplate === 'object' && rawTemplate.name) pushByName(rawTemplate.name);
    }
    const visited = new Set();
    const unfold = (tplDef) => {
      const name = Object.entries(globalTpl).find(([k,v]) => v === tplDef)?.[0];
      if (name) { if (visited.has(name)) { console.warn('[popup-button-card] 模板循环：', name); return {}; } visited.add(name); }
      let merged = {};
      const parentRef = tplDef?.template ?? tplDef?.templates;
      if (parentRef) {
        const parents = Array.isArray(parentRef) ? parentRef : [parentRef];
        for (const pName of parents) {
          const pd = globalTpl[pName];
          if (!pd) { console.warn('[popup-button-card] 模板未找到（父）:', pName); continue; }
          merged = PopupButtonCard._deepMerge(merged, unfold(pd));
        }
      }
      merged = PopupButtonCard._deepMerge(merged, tplDef || {});
      return merged;
    };
    let mergedCfg = {};
    for (const { def } of tplEntries) mergedCfg = PopupButtonCard._deepMerge(mergedCfg, unfold(def));
    const tplVars = mergedCfg.variables || {}, userVars = inputCfg.variables || {};
    const finalVars = PopupButtonCard._deepMerge(tplVars, userVars) || {};
    const { template, templates, variables, ...restInput } = inputCfg;
    const finalCfg = PopupButtonCard._deepMerge(mergedCfg, restInput);
    return { finalCfg, finalVars };
  }

  /* ================= 生命周期 ================= */
  connectedCallback() {
    if (!this.shadowRoot) this._render();

    // 防闪烁：回到视图时强制处于关闭、隐藏状态
    this._open = false;
    if (this._popupEl) {
      this._popupEl.style.display = 'none';
      this._popupEl.removeAttribute('data-anim');
      this._popupEl.classList.remove('fullscreen');
    }
    this._unlockBodyScroll();
    this._destroyFullscreenWrap();
    //关键：清理任何可能残留的态，恢复可交互
    this._closingAnim = false;
    this._overlayArmed = false;
    this._justOpened = false;
    this._pressable?.classList.remove('pressed','effect');
    this.removeAttribute('data-active');
    this.removeAttribute('data-fullscreen');
    this.removeAttribute('data-closing');
    this.removeAttribute('data-opening');
    this.removeAttribute('data-yield');
    if (this._overlayEl) {
      this._overlayEl.style.pointerEvents = 'none';
      this._overlayEl.style.display = 'none';
      this._overlayEl.removeAttribute('data-anim');
    }

    // 全局监听
    window.addEventListener('pointerup', this._onWindowPointerUp, true);
    window.addEventListener('scroll', this._onWindowScroll, true);
    document.addEventListener('visibilitychange', this._onVisibilityChange, true);
    
    // 监听全局关闭信号
    window.addEventListener('expandable-close-all', this._onExpandableCloseAll);
    window.addEventListener('expandable-close-others', this._onExpandableCloseOthers);
    window.addEventListener('expandable-yield-others', this._onExpandableYieldOthers);
    this.style.transform = 'translateZ(0)';
    setTimeout(() => {
      this.style.transform = '';
    }, 0);

    // === NEW: 内容源模式下，轮询编辑态以控制可见性 ===
    if (this._cardFunction === 'content') {
      this._updateEditVisibility();
      if (!this._editModeTimer) {
        this._editModeTimer = setInterval(() => this._updateEditVisibility(), 500);
      }
    }
  }

  disconnectedCallback() {
    this._unbindUpdownCloseSources();
    window.removeEventListener('pointerup', this._onWindowPointerUp, true);
    window.removeEventListener('scroll', this._onWindowScroll, true);
    document.removeEventListener('visibilitychange', this._onVisibilityChange, true);
    
    // 移除全局关闭监听
    window.removeEventListener('expandable-close-all', this._onExpandableCloseAll);
    window.removeEventListener('expandable-close-others', this._onExpandableCloseOthers);
    window.removeEventListener('expandable-yield-others', this._onExpandableYieldOthers);

    this._teardownFullscreenOverlayListeners();
    this._unlockBodyScroll();
    if (this._popupEl) {
      this._popupEl.style.display = 'none';
      this._popupEl.removeAttribute('data-anim');
      this._popupEl.classList.remove('fullscreen');
    }
    this._open = false;

    // 兜底：移除活动态标记，避免层级残留
    this.removeAttribute('data-active');
    this.removeAttribute('data-fullscreen');
    this.removeAttribute('data-yield');
    this.removeAttribute('data-closing');
    this.removeAttribute('data-opening');;
    this._pressable?.classList.remove('pressed','effect');
    this._pressable?.style?.removeProperty('--effect-color');
    this._teardownAnyTapToClose();

    // === NEW: 清理编辑态计时器 & 从注册表注销 ===
    if (this._editModeTimer) { clearInterval(this._editModeTimer); this._editModeTimer = null; }
    if (this._cardFunction === 'content' && this._contentProvider && this._contentId) {
      __pbcUnregisterContent(this._contentId, this._contentProvider);
      this._contentProvider = null;
    }
  }

  _onExpandableCloseOthers = (e) => {
    if (e.detail === this) return; // 忽略自己
    if (this._open && this._side !== 'full_screen') this.close();
  };

  _onExpandableYieldOthers(e) {
    if (!e || !e.detail) return;
    if (e.detail === this) return;

    // 不依赖 instanceof，避免多上下文失效
    const isEl = !!(e.detail.nodeType === 1 || e.detail.tagName);
    if (!isEl) return;

   // 已开 或 正在关闭 都需要让位；与是否启用 outside_blur 无关（新遮罩来自“新实例”）
    if ((this._open || this.hasAttribute('data-closing')) && this._side !== 'full_screen') {
      this.setAttribute('data-yield', '');
      // 立即撤销置顶与按钮状态，避免快切换残留
      this.removeAttribute('data-opening');
      this.removeAttribute('data-active');
      this._pressable?.classList.remove('pressed','effect');
      this._pressable?.style?.removeProperty('--effect-color');
    }
  }

  // 添加事件处理函数
  _onExpandableCloseAll = (e) => {
    // 如果是自己发出的信号则忽略
    if (e.detail === this) return;
    
    // 如果当前已打开且不是全屏模式，则关闭
    if (this._open && this._side !== 'full_screen') this.close();
  };

   /* ================= Home Assistant ================= */
  set hass(hass) { 
    this._hass = hass; 
    if (this._contentCard) this._contentCard.hass = hass; 
    this.updateDynamicContent(); 
    // 内容源容器中的子卡片（编辑态可见）也同步 hass
    if (this._contentHost && this._contentHost.lastElementChild && this._contentHost.lastElementChild.hass === undefined) {
      try { this._contentHost.lastElementChild.hass = hass; } catch {}
    }
  }
  
  setConfig(config) {
    this._rawConfig = config || {};

    // === NEW: 读 card_function 与 content_id（默认 button） ===
    this._cardFunction = (this._rawConfig.card_function || 'button');
    this._contentId = this._rawConfig.content_id || null;

    const { finalCfg, finalVars } = this._resolveTemplatesAndVariables(this._rawConfig);
    this._variables = finalVars || {};
    // 1. 将原始的、未解析的最终配置存储在一个私有属性中。
    this._finalConfig = finalCfg || {};

    // 2. 创建一个 Proxy 作为 this._config 供整个组件使用。
    //    任何对 this._config.someProperty 的访问都会触发 get() 处理器。
    this._config = new Proxy(this._finalConfig, {
      get: (target, prop) => {
        // 当代码尝试获取配置属性时，这个函数会自动运行。
        const rawValue = target[prop];
        //直接调用现有的 evaluateTemplate 方法。
        return this.evaluateTemplate(rawValue);
      }
    });
    this._side = this._config.expand_side || 'bottom';
    this._computeFsOverlayClickFlag();
    this._tapAction  = this._config.tap_action;
    this._holdAction = this._config.hold_action;

    if (!this.shadowRoot) {
      this._render();
    }

    // === NEW: 分流 ===
    if (this._cardFunction === 'content') {
      this._renderAsContentSource();      // 只在编辑态显示
    } else {
      // 原 button 流程
      this.updateDynamicContent();
      this.loadContent();
      if (this._open) this.positionPopup();
    }
  }


  /* ================= 模板 / 样式工具 ================= */
  evaluateTemplate(value) {
    if (typeof value !== 'string') return value; const s = value.trim();
    if (!s.startsWith('[[[') || !s.endsWith(']]]')) return value; if (!this._hass) return '';
    const _exec = (codeStr, variablesProxy) => {
      const hass = this._hass; const states = hass?.states || {}; const user = hass?.user;
      const entity = this._config?.entity ? states[this._config.entity] : null;
      const isBlock = /(\bvar\b|\bif\b|\blet\b|\bconst\b|;|\n|\breturn\b)/.test(codeStr);
      if (isBlock) return Function('hass','states','entity','user','variables','config','card',`"use strict"; ${codeStr}`)(hass, states, entity, user, variablesProxy, this._config, this);
      return Function('hass','states','entity','user','variables','config','card',`"use strict"; return (${codeStr})`)(hass, states, entity, user, variablesProxy, this._config, this);
    };
    try {
      const rawCode = s.slice(3, -3);
      const variablesProxy = new Proxy(this._variables || {}, { get: (t,p,r) => {
        const v = Reflect.get(t,p,r);
        if (typeof v === 'string') {
          const t2 = v.trim();
          if (t2.startsWith('[[[') && t2.endsWith(']]]') && t2 !== `[[[ return variables.${String(p)} ]]]`) {
            const inner = t2.slice(3, -3); return _exec(inner, this);
          }
        }
        return v;
      }});
      return _exec(rawCode, variablesProxy);
    } catch (e) { console.warn('PopupButtonCard: 模板错误', value, e); return ''; }
  }
  applyStyleList(el, styleList) {
    if (!el || !Array.isArray(styleList)) return;
    for (const rule of styleList) {
      const [prop, val] = Object.entries(rule)[0];
      let finalVal = val; if (typeof val === 'string' && val.trim().startsWith('[[[')) finalVal = this.evaluateTemplate(val);
      if (el.tagName === 'HA-ICON' && (prop === 'width' || prop === 'height')) el.style.setProperty('--mdc-icon-size', finalVal);
      else el.style.setProperty(prop, finalVal);
    }
  }
  _getStylePropFromList(styleList, prop) {
    if (!Array.isArray(styleList)) return undefined; let val;
    for (const rule of styleList) { const entries = Object.entries(rule || {}); if (!entries.length) continue; const [k,v] = entries[0]; if (k === prop) val = v; }
    if (typeof val === 'string' && val.trim().startsWith('[[[')) return this.evaluateTemplate(val); return val;
  }

  // 把 styles.button 拆成：布局（给 .toggle） vs 视觉（给 .pressable）
  _applyButtonStylesUnified(styleList) {
    if (!Array.isArray(styleList)) return;
    const visualProps = new Set([
      'background', 'background-color', 'backdrop-filter', 'filter',
      'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
      'border', 'border-color', 'border-width', 'border-style',
      'border-radius', 'box-shadow', 'outline',
      'transform', 'transform-origin', 'transition',
      // 尺寸（给 pressable，容器用内容撑开）
      'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
      // 添加 grid 布局属性
      'display', 'grid-template-areas', 'grid-template-columns', 'grid-template-rows', 
      'grid-column-gap', 'grid-row-gap', 'grid-gap', 'gap',
      'grid-auto-columns', 'grid-auto-rows', 'grid-auto-flow',
      'align-items', 'justify-items', 'align-content', 'justify-content',
      'place-items', 'place-content'
    ]);
    const layoutList = [];
    const visualList = [];
    for (const rule of styleList) {
      const [prop, val] = Object.entries(rule)[0];
      if (visualProps.has(prop)) visualList.push({ [prop]: val });
      else layoutList.push({ [prop]: val });
    }
    // 视觉到 pressable，布局到 toggle
    this.applyStyleList(this._pressable, visualList);
    this.applyStyleList(this._toggleEl, layoutList);
  }

  _getConfiguredContentHeightPx() {
    const styles = this._config?.styles?.content; const raw = this._getStylePropFromList(styles, 'height');
    if (raw == null || raw === '') return null; if (typeof raw === 'number') return raw; if (typeof raw !== 'string') return null;
    const val = raw.trim(); if (/^\d+(\.\d+)?$/.test(val)) return Number(val);
    const m = /^(-?\d+(?:\.\d+)?)(px|rem|em|vh|vw|%)$/.exec(val); if (!m) return null; const num = Number(m[1]); const unit = m[2];
    switch (unit) {
      case 'px': return num;
      case 'rem': return num * parseFloat(getComputedStyle(document.documentElement).fontSize || '16');
      case 'em' : return num * parseFloat(getComputedStyle(this).fontSize || getComputedStyle(document.documentElement).fontSize || '16');
      case 'vh': return num * (window.innerHeight || document.documentElement.clientHeight) / 100;
      case 'vw': return num * (window.innerWidth  || document.documentElement.clientWidth ) / 100;
      case '%':  return num * (window.innerHeight || document.documentElement.clientHeight) / 100;
      default:   return null;
    }
  }
  _computeFsOverlayClickFlag() {
    const styles = this._config?.styles?.content || []; const hasW = this._getStylePropFromList(styles, 'width') != null; const hasH = this._getStylePropFromList(styles, 'height') != null; this._fsShouldOverlayClickClose = !!(hasW || hasH);
  }

  /** 找最近的可垂直滚动祖先（含跨越 shadow root），找不到则返回 window */
  _findScrollableAncestor(startNode = this) {
    let node = startNode;
    const getHost = (n) => (n && n.getRootNode && n.getRootNode() instanceof ShadowRoot) ? n.getRootNode().host : null;
    while (node) {
      if (node instanceof ShadowRoot) { node = node.host; continue; }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {HTMLElement} */ (node);
        const style = getComputedStyle(el);
        const oy = style.overflowY;
        const canScroll = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && (el.scrollHeight > el.clientHeight + 1);
        if (canScroll) return el;
      }
      node = node.parentNode || getHost(node) || null;
    }
    return window;
  }

  /** 在非全屏 + 配置开启时，监听“就近滚动/手势”以关闭弹窗 */
  _bindUpdownCloseSources() {
    if (!this._open) return;
    if (this._side === 'full_screen') return;
    if (!this._config.updown_slide_to_close_popup) return;
    this._unbindUpdownCloseSources();

    const target = this._findScrollableAncestor(this);
    const handler = () => {
      if (!this._open) return;
      if (this._justOpened) return;
      this.close();
    };
    const wheelHandler = handler;
    const touchMoveHandler = handler;

    // 1) 直接监听就近滚动容器的 scroll（不冒泡，必须绑在元素上）
    if (target !== window && target.addEventListener) {
      target.addEventListener('scroll', handler, { capture: true, passive: true });
      target.addEventListener('wheel', wheelHandler, { capture: true, passive: true });
      target.addEventListener('touchmove', touchMoveHandler, { capture: true, passive: true });
    } else {
      // 退回监听 window 的 wheel/touchmove（桌面场景也够用）
      window.addEventListener('wheel', wheelHandler, { capture: true, passive: true });
      window.addEventListener('touchmove', touchMoveHandler, { capture: true, passive: true });
      window.addEventListener('scroll', handler, { capture: true, passive: true });
    }

    // 2) 额外兜底：若处于全屏父层，父层常见滚动容器是 .content-wrap
    if (this._popupEl && this._popupEl.closest) {
      const wrap = this._popupEl.closest('.content-wrap');
      if (wrap) {
        wrap.addEventListener('scroll', handler, { capture: true, passive: true });
        wrap.addEventListener('wheel', wheelHandler, { capture: true, passive: true });
        wrap.addEventListener('touchmove', touchMoveHandler, { capture: true, passive: true });
      }
    }

    this._scrollCloseCleanup = () => {
      try {
        if (target !== window && target.removeEventListener) {
          target.removeEventListener('scroll', handler, { capture: true });
          target.removeEventListener('wheel', wheelHandler, { capture: true });
          target.removeEventListener('touchmove', touchMoveHandler, { capture: true });
        } else {
          window.removeEventListener('wheel', wheelHandler, { capture: true });
          window.removeEventListener('touchmove', touchMoveHandler, { capture: true });
          window.removeEventListener('scroll', handler, { capture: true });
        }
        const wrap = this._popupEl?.closest?.('.content-wrap');
        if (wrap) {
          wrap.removeEventListener('scroll', handler, { capture: true });
          wrap.removeEventListener('wheel', wheelHandler, { capture: true });
          wrap.removeEventListener('touchmove', touchMoveHandler, { capture: true });
        }
      } catch {}
      this._scrollCloseCleanup = null;
    };
  }

  _unbindUpdownCloseSources() {
    if (this._scrollCloseCleanup) this._scrollCloseCleanup();
  }


  /* ================= 滚动/高度 ================= */
  _updateContentOverflowScroll() {
    const isFull = this._side === 'full_screen'; 
    const scroller = isFull ? this._contentWrap : this._popupEl; 
    if (!scroller) return;
    
    // 确保滚动条始终隐藏
    scroller.style.scrollbarWidth = 'none';
    scroller.style.msOverflowStyle = 'none';
    
    const limitPx = this._getConfiguredContentHeightPx();
    if (limitPx == null) { 
      scroller.style.overflowY = isFull ? 'auto' : ''; 
      scroller.style.maxHeight = ''; 
      scroller.style.webkitOverflowScrolling = isFull ? 'touch' : '';
      return; 
    }
    
    const check = () => {
      const contentH = scroller.scrollHeight;
      if (contentH > limitPx + 1) { 
        scroller.style.maxHeight = `${limitPx}px`; 
        scroller.style.overflowY = 'auto'; 
        scroller.style.webkitOverflowScrolling = 'touch'; 
      }
      else { 
        scroller.style.overflowY = isFull ? 'auto' : ''; 
        scroller.style.maxHeight = ''; 
        scroller.style.webkitOverflowScrolling = isFull ? 'touch' : '';
      }
    };
    requestAnimationFrame(check);
  }
  _lockBodyScroll() { document.documentElement.classList.add('pbc-no-scroll'); }
  _unlockBodyScroll() { document.documentElement.classList.remove('pbc-no-scroll'); }

  /* ================= 渲染 ================= */
  async _render() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      const styleEl = document.createElement('style');
      styleEl.textContent = `
        /* 1. 组件宿主：作为布局容器，决定组件在页面流中的位置和尺寸 */
        :host {
          display: block;
          outline: none;
          -webkit-tap-highlight-color: transparent;
        }

        /* 2. 外层容器/命中区域：填满宿主，并居中 .pressable */
        .toggle {
          all:unset; cursor:pointer;
          display: flex; 
          justify-content: center;
          align-items: center;
          width: 100%;
          height: 100%;
          position: relative; /* 为 z-index 和绝对定位的子元素提供定位上下文 */
          pointer-events:none; touch-action:manipulation;
        }

        /* 3. 内层可视包裹：所有视觉样式和内部布局都在这里 */
        .pressable {
          display:inline-grid; justify-items:center; align-items:center; gap:4px;
          padding:8px 12px;
          background: var(--pbc-btn-bg, transparent);
          border-radius:6px;
          box-shadow: 0px 2px 5px 0px rgb(193,193,193);
          transform-origin:center center;
          transition: transform 220ms ease-out, box-shadow 200ms ease, background 200ms ease, border-radius 200ms ease;
          pointer-events: auto;  /* 允许事件 */
          cursor: pointer;
        }

        /* ========= 层级管理：核心逻辑 ========= */
        /* 用宿主 :host 管全局层级（确保当前卡片在其他卡片之上） */
        :host([data-opening]:not([data-fullscreen])) { z-index: 1003; position: relative; }
        :host([data-active]:not([data-fullscreen])),
        :host([data-closing]:not([data-fullscreen])) { z-index: 1002; position: relative; }
        :host([data-yield]:not([data-fullscreen])) { z-index: 999; position: relative; }
        
        /* 【关键恢复】在组件内部，根据状态提升 .toggle 和 .popup 的层级 */
        /* 确保它们都显示在 .popup-overlay (z-index: 1000) 之上 */
        :host([data-active]:not([data-fullscreen])) .toggle,
        :host([data-closing]:not([data-fullscreen])) .toggle,
        :host([data-active]:not([data-fullscreen])) .popup,
        :host([data-closing]:not([data-fullscreen])) .popup { 
          z-index: 1002; 
        }
        :host([data-opening]:not([data-fullscreen])) .toggle,
        :host([data-opening]:not([data-fullscreen])) .popup { 
          z-index: 1003; 
        }
        /* (yield 状态的 z-index 由 :host 控制即可，内部元素无需额外设置) */
        
        /* ========= 其他样式（保持不变） ========= */

        .pressable.pressed { /* reserved */ }
        :host([data-opening]:not([data-fullscreen])) .pressable.effect,
        :host([data-active]:not([data-fullscreen]))  .pressable.effect,
        :host([data-closing]:not([data-fullscreen])) .pressable.effect {
          box-shadow:0px 3px 1px -2px var(--effect-color,#ffa500),
                      0px 2px 2px 0px var(--effect-color,#ffa500),
                      0px 1px 5px 0px var(--effect-color,#ffa500);
          border-radius:0;
        }

        .inner-grid { display:contents; }

        .name, .state, .label {
          line-height: 1.1;
          white-space: pre-wrap;
        }
        
        .popup { position:fixed; z-index: 1001; pointer-events:auto; background:var(--card-background-color,#fff); border-radius:8px; padding:10px; box-shadow:0 4px 20px rgba(0,0,0,0.3); display:none; opacity:0; transform:scale(0.95); overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
        
        @keyframes popupIn { from {opacity:0; transform:scale(0.85)} to {opacity:1; transform:scale(1)} }
        @keyframes popupOut{ from {opacity:1; transform:scale(1)} to {opacity:0; transform:scale(0.95)} }
        .popup[data-anim="open"]  { display:block; animation: popupIn 350ms ease forwards; }
        .popup[data-anim="close"] { display:block; animation: popupOut 400ms ease forwards; }

        :host([data-closing]) .toggle { pointer-events: none; }

        .popup.fullscreen {
           position:fixed; inset:0; width:100vw; height:100vh; padding:0; border-radius:0;
           background:rgba(0,0,0,0.40); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
           display:flex; align-items:center; justify-content:center;
           opacity:0; transform:none; overscroll-behavior:none;
        }
        .popup.fullscreen[data-anim] { display:flex; }
        .popup.fullscreen .content-wrap {
           position:relative;
           background:var(--card-background-color,#fff);
           border-radius:12px;
           box-shadow:0 10px 30px rgba(0,0,0,0.35);
           overflow:auto; -webkit-overflow-scrolling:touch;
           max-width:95vw; max-height:95vh;
           touch-action:pan-y; overscroll-behavior:contain;
           margin:auto;
           display:inline-block;
           flex:0 0 auto;
        }
        .popup.fullscreen .close-fab { position:absolute; left:50%; transform:translateX(-50%); bottom:16px; width:48px; height:48px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.72); color:#fff; border:none; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.35); z-index:2; outline:none; font-size:24px; line-height:1; }
        .popup.fullscreen .close-fab:active { transform: translateX(-50%) scale(0.96); }
        .fullscreen .popup_close_button {
          position: absolute; top: 12px; right: 12px; z-index: 1003; width: 32px; height: 32px;
          display: flex; align-items: center; justify-content: center;
          border-radius: 16px; background: rgba(0,0,0,0.1); color: #fff; cursor: pointer;
        }

        :host-context(html.pbc-no-scroll) body { overflow:hidden !important; }

        .popup, .popup.fullscreen .content-wrap {
          scrollbar-width: none !important; -ms-overflow-style: none !important;
        }
        .popup::-webkit-scrollbar, .popup.fullscreen .content-wrap::-webkit-scrollbar {
          display: none !important;
        }

        .pressable.hold-pressing {
          transform: scale(0.96);
          box-shadow:0px 2px 0px -2px rgba(0,0,0,0.12), 0px 1px 1px 0px rgba(0,0,0,0.10), 0px 1px 3px 0px rgba(0,0,0,0.10);
        }

        .popup-overlay {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(0,0,0,0.25);
          backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
          opacity: 0; display: none; pointer-events: none; touch-action: none;
        }
        @keyframes overlayIn { from {opacity:0} to {opacity:1} }
        @keyframes overlayOut { from {opacity:1} to {opacity:0} }
        .popup-overlay[data-anim="open"]  { display:block; animation: overlayIn 350ms ease forwards; }
        .popup-overlay[data-anim="close"] { display:block; animation: overlayOut 400ms ease forwards; }

        @keyframes fsOverlayIn  { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fsOverlayOut { from { opacity: 1; } to { opacity: 0; } }
        .popup.fullscreen[data-anim="open"]  { animation: fsOverlayIn 350ms ease forwards !important; }
        .popup.fullscreen[data-anim="close"] { animation: fsOverlayOut 400ms ease forwards !important; }

        @keyframes fsContentInOnce {
          0%   { opacity: 0; transform: scale(0.85); }
          99.9%{ opacity: 1; transform: scale(1); }
          100% { opacity: 1; transform: none; }
        }
        @keyframes fsContentOutOnce {
          0%   { opacity: 1; transform: scale(1); }
          80%  { opacity: 1; transform: scale(0.75); }
          99.9%{ opacity: 0; transform: scale(0.75); }
          100% { opacity: 0; transform: none; }
        }
        .popup.fullscreen[data-anim="open"]  .content-wrap { animation: fsContentInOnce 350ms ease; }
        .popup.fullscreen[data-anim="close"] .content-wrap { animation: fsContentOutOnce 400ms ease; }
      `;
      this.shadowRoot.appendChild(styleEl);

      // 结构：toggle -> pressable -> inner-grid
      this._toggleEl = document.createElement('button');
      this._toggleEl.className = 'toggle';
      this._toggleEl.type = 'button';

      this._pressable = document.createElement('div');
      this._pressable.className = 'pressable';
      this._toggleEl.appendChild(this._pressable);

      // 遮罩
      this._overlayEl = document.createElement('div');
      this._overlayEl.className = 'popup-overlay';
      this._overlayEl.addEventListener('animationend', this._onAnimationEnd);
      this._overlayEl.addEventListener('wheel', this._onOverlayWheelOrTouchMove, { passive:false });
      this._overlayEl.addEventListener('touchmove', this._onOverlayWheelOrTouchMove, { passive:false });
      // 点击遮罩：统一关闭 & 阻止穿透
      this._overlayEl.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); e.preventDefault(); }, { capture:true });
      this._overlayEl.addEventListener('click', (e)=>{ 
        e.stopPropagation(); e.preventDefault();
        if (!this._open || this._side === 'full_screen') return;
        if (this._justOpened) return;
        this.close();
      }, { capture:true });

      // 弹窗
      this._popupEl = document.createElement('div');
      this._popupEl.className = 'popup';
      this._popupEl.addEventListener('animationend', this._onAnimationEnd);
      
      this.shadowRoot.append(this._toggleEl, this._overlayEl, this._popupEl);

      // 手势逻辑
      const LONG_PRESS_MS = Number(this._config.long_press_ms || 500);
      const MOVE_TOL = 10;
      let pressTimer = null; let longPressed = false; let downX = 0, downY = 0;

      const popupOn = (this._tapAction === 'popup') ? 'tap' : (this._holdAction === 'popup' ? 'hold' : 'tap');
      const clearTimer = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
      const startHoldVisual = () => { this._pressable.classList.add('hold-pressing'); };
      const stopHoldVisual  = () => { this._pressable.classList.remove('hold-pressing'); void this._pressable.offsetWidth; };

      this._toggleEl.addEventListener('pointerdown', (e) => {
        downX = e.clientX; downY = e.clientY; longPressed = false; this._gestureActive = true;
        // 记录按下瞬间的按钮锚点（toggle 不做 transform，rect 稳定）
        this._anchorRectOnDown = this._toggleEl.getBoundingClientRect();

        if (popupOn === 'hold' || (this._holdAction && this._holdAction !== 'popup')) {
          clearTimer(); startHoldVisual();
          pressTimer = setTimeout(() => {
            longPressed = true;
            if (popupOn === 'hold') this.toggle();
            else if (this._holdAction && this._holdAction !== 'popup') this._handleHaAction(this._holdAction, 'hold');
          }, LONG_PRESS_MS);
        }
      }, { passive: true });

      this._toggleEl.addEventListener('pointerup', (e) => {
        const dx = e.clientX - downX, dy = e.clientY - downY; const moved = Math.hypot(dx, dy) > MOVE_TOL; const wasLong = longPressed;
        clearTimer(); this._toggleEl.blur?.(); stopHoldVisual(); this._gestureActive = false; this._anchorRectOnDown = null;
        if (moved) return; if (wasLong) return;
        if (popupOn === 'tap') this.toggle();
        else if (this._tapAction && this._tapAction !== 'popup') this._handleHaAction(this._tapAction, 'tap');
        else if (popupOn !== 'hold') this.toggle();
      }, { passive: true });

      const cancel = () => { clearTimer(); stopHoldVisual(); this._gestureActive = false; this._anchorRectOnDown = null; };
      this._toggleEl.addEventListener('pointercancel', cancel, { passive: true });
      this._toggleEl.addEventListener('pointerleave',  cancel, { passive: true });

      if (window.provideHass) window.provideHass(this);
      this.updateDynamicContent();
      
    }
  }

  /* =================== 内容源模式（仅编辑态可见） =================== */
  _renderAsContentSource() {
    // 隐藏按钮/弹窗 UI
    if (this._toggleEl) this._toggleEl.style.display = 'none';
    if (this._overlayEl) this._overlayEl.style.display = 'none';
    if (this._popupEl)  this._popupEl.style.display  = 'none';

    // 可视容器（编辑模式下显示）
    if (!this._contentHost) {
      this._contentHost = document.createElement('div');
      this._contentHost.className = 'pbc-content-host';
      Object.assign(this._contentHost.style, {
        display: 'none',
        outline: '1px dashed var(--secondary-text-color, #999)',
        borderRadius: '8px',
        padding: '8px',
        background: 'var(--card-background-color, #fff)',
      });
      const badge = document.createElement('div');
      badge.textContent = `Popup Button 内容源${this._contentId ? ` #${this._contentId}` : ''}`;
      Object.assign(badge.style, { fontSize: '12px', opacity: '0.7', marginBottom: '6px' });
      this._contentHost.appendChild(badge);
      this.shadowRoot.appendChild(this._contentHost);
    }

    // 渲染子卡片进容器（仅编辑态视觉，真正弹窗不使用该 DOM）
    this._renderChildCardsInHost();

    // 注册 provider 供按钮 from_id 引用
    if (this._contentId && !this._contentProvider) {
      this._contentProvider = this._buildContentProvider();
      __pbcRegisterContent(this._contentId, this._contentProvider);
    }

    // 初次更新编辑态可见性
    this._updateEditVisibility();
  }

  _updateEditVisibility() {
    const edit = PopupButtonCard._isEditMode();
    if (this._cardFunction !== 'content') return;
    if (this._contentHost) this._contentHost.style.display = edit ? 'block' : 'none';
  }

  _buildContentProvider() {
    const getConfig = () => {
      const c = this._config?.content || {};
      if (Array.isArray(c.cards)) {
        return { type: 'vertical-stack', cards: c.cards };
      }
      if (c.card) return c.card;
      return { type: 'markdown', content: '⚠️ 未提供 content.card 或 content.cards' };
    };
    const getKey = () => JSON.stringify(getConfig());
    return { getConfig, getKey };
  }

  async _renderChildCardsInHost() {
    if (!this._contentHost) return;
    // 保留第一个 badge
    const badge = this._contentHost.firstChild;
    this._contentHost.innerHTML = '';
    if (badge) this._contentHost.appendChild(badge);
    const helpers = await window.loadCardHelpers();
    const c = this._config?.content || {};
    let renderCfg;
    if (Array.isArray(c.cards))    renderCfg = { type: 'vertical-stack', cards: c.cards };
    else if (c.card)               renderCfg = c.card;
    else                           renderCfg = { type: 'markdown', content: '在 content 模式下配置 content.card 或 content.cards。' };
    try {
      const el = await helpers.createCardElement(renderCfg);
      el.hass = this._hass;
      this._contentHost.appendChild(el);
    } catch (e) {
      const err = document.createElement('div');
      err.style.color = 'red';
      err.textContent = `内容源渲染失败：${e?.message || e}`;
      this._contentHost.appendChild(err);
    }
  }

  /* ================= 动态内容 ================= */
  updateDynamicContent() {
    if (!this._toggleEl || !this._pressable) return;

    // 内容源模式不显示按钮 UI
    if (this._cardFunction === 'content') {
      this._toggleEl.style.display = 'none';
      return;
    } else {
      this._toggleEl.style.display = '';
    }

    const styles = this._config.styles || {};

    // grid 放在 pressable 内部
    let grid = this._pressable.querySelector('.inner-grid');
    if (!grid) { grid = document.createElement('div'); grid.className = 'inner-grid'; this._pressable.appendChild(grid); }
    if (styles.grid) this.applyStyleList(this._pressable, styles.grid);

    const nameVal  = this._config.name || '';
    const labelVal = this._config.label || '';
    const iconVal  = this._config.button_icon ?? '';

    const stateFromConfig = this._config.state ?? '';
    const stateFromEntity = this._config.entity ? (this._hass?.states?.[this._config.entity]?.state ?? '') : '';
    const stateVal = (stateFromEntity !== '' && stateFromEntity != null) ? String(stateFromEntity) : String(stateFromConfig);

    const isUrl = (v) => typeof v === 'string' && (v.startsWith('/') || v.startsWith('http'));
    let iconEl = grid.querySelector('.icon-el');
    if (iconVal) {
      const needImg = isUrl(iconVal);
      if (!iconEl || (needImg && iconEl.tagName !== 'IMG') || (!needImg && iconEl.tagName === 'IMG')) {
        if (iconEl) iconEl.remove();
        iconEl = needImg ? document.createElement('img') : document.createElement('ha-icon');
        iconEl.classList.add('icon-el'); iconEl.style.gridArea = 'i'; grid.prepend(iconEl);
      }
      if (iconEl.tagName === 'IMG') { const prevRaw = iconEl.dataset.srcRaw || ''; if (prevRaw !== String(iconVal)) { iconEl.dataset.srcRaw = String(iconVal); iconEl.src = iconVal; } }
      else { if (iconEl.getAttribute('icon') !== iconVal) iconEl.setAttribute('icon', iconVal); }
      this.applyStyleList(iconEl, styles.icon || []);
    } else if (iconEl) { iconEl.remove(); }

    const ensureSpan = (cls, area) => { let el = grid.querySelector('.' + cls); if (!el) { el = document.createElement('span'); el.className = cls; el.style.gridArea = area; grid.appendChild(el); } return el; };
    if (nameVal) { const nameEl = ensureSpan('name','n'); nameEl.innerHTML  = nameVal; this.applyStyleList(nameEl, styles.name || []); } else { grid.querySelector('.name')?.remove(); }
    const showState = (styles.state && Array.isArray(styles.state)) || stateVal !== '';
    if (showState) { const stateEl = ensureSpan('state','s'); stateEl.innerHTML  = stateVal; this.applyStyleList(stateEl, styles.state || []); } else { grid.querySelector('.state')?.remove(); }
    const showLabel = (styles.label && Array.isArray(styles.label)) || labelVal !== '';
    if (showLabel) { const labelEl = ensureSpan('label','l'); labelEl.innerHTML  = labelVal; this.applyStyleList(labelEl, styles.label || []); } else { grid.querySelector('.label')?.remove(); }

    // 统一应用 styles.button
    if (styles.button) this._applyButtonStylesUnified(styles.button);

    if (styles.card) {
      this.applyStyleList(this._toggleEl, this._config.styles.card);
    }

    if (this._open) this.positionPopup();
  }

  /* ================= 开合与定位 ================= */
  toggle() {
    // 内容源模式不响应 toggle
    if (this._cardFunction === 'content') return;

    // 决策逻辑只在“即将打开”时执行
    if (!this._open) {
      // 判断是否需要关闭其他已打开的弹窗
      const shouldCloseOthers =
        this._side === 'full_screen' ||
        (!this._config.multi_expand && this._side !== 'full_screen');

      if (shouldCloseOthers) {
        window.dispatchEvent(new CustomEvent('expandable-yield-others', { detail: this }));
        window.dispatchEvent(new CustomEvent('expandable-close-all', { detail: this }));
        setTimeout(() => this._actualToggle(), 50);
        return;
      }
    }

    this._actualToggle();
  }

  _actualToggle() {
    this._open = !this._open;
    const restartAnim = (type) => { this._popupEl.removeAttribute('data-anim'); void this._popupEl.offsetWidth; this._popupEl.setAttribute('data-anim', type); };
    
    if (this._open) {
      // === 空内容兜底：非全屏若无内容则撤销打开，避免小白块 ===
      if (this._side !== 'full_screen') {
        const noCfgContent = !this._config?.content;
        const noDomContent = !this._popupEl?.childElementCount;
        if (noCfgContent || noDomContent) {
          this._open = false;
          this._pressable?.classList.remove('pressed','effect');
          this._pressable?.style?.removeProperty('--effect-color');
          this.removeAttribute('data-opening');
          this.removeAttribute('data-active');
          if (this._overlayEl) {
            this._overlayEl.style.pointerEvents = 'none';
            this._overlayEl.style.display = 'none';
            this._overlayEl.removeAttribute('data-anim');
          }
          return;
        }
      }

      this._openGuardUntil = performance.now() + 400;
      
      if ((this._config.popup_outside_blur || !this._config.multi_expand) && this._side !== 'full_screen') {
        window.dispatchEvent(new CustomEvent('expandable-yield-others', { detail: this }));
        window.dispatchEvent(new CustomEvent('expandable-close-others', { detail: this }));
      }
      
      this._popupEl.style.display = (this._side === 'full_screen') ? 'flex' : 'block';
      this.positionPopup(); 
      this._updateContentOverflowScroll?.(); 
      restartAnim('open');

      this.setAttribute('data-opening', '');
      this.setAttribute('data-active', '');
      if (this._side !== 'full_screen' && this._config?.popup_outside_blur) this._lockBodyScroll();
      if (this._side === 'full_screen') {
        this.setAttribute('data-fullscreen', '');
      }
      
      if (this._side !== 'full_screen' && this._config.popup_outside_blur) {
        this._overlayEl.style.display = 'block';
        this._overlayEl.removeAttribute('data-anim'); 
        void this._overlayEl.offsetWidth;
        this._overlayEl.setAttribute('data-anim', 'open');
        this._overlayEl.style.pointerEvents = 'auto';
        
        if (this._config.styles?.popup_outside_blur) {
          this.applyStyleList(this._overlayEl, this._config.styles.popup_outside_blur);
        } else {
          this._overlayEl.style.background = 'rgba(0, 0, 0, 0.25)';
          this._overlayEl.style.backdropFilter = 'blur(6px)';
          this._overlayEl.style.webkitBackdropFilter = 'blur(6px)';
        }
      }

      this._pressable.classList.add('pressed');
      if (this._config.button_effect) {
        const color = this._config.button_effect_color || '#ffa500';
        this._pressable.style.setProperty('--effect-color', color);
        this._pressable.classList.add('effect');
      }
      
      this._bindUpdownCloseSources();
      this._armAnyTapToClose(); 
      this._overlayArmed = false; 
      this._justOpened = true; 
      setTimeout(() => { 
        this._overlayArmed = true; 
        this._justOpened = false; 
      }, 300);
    } else {
      this.setAttribute('data-closing', '');
      this._teardownAnyTapToClose();
      if (!this._config?.popup_outside_blur) this._pressable.classList.remove('pressed','effect');
      this._closingAnim = true; 
      this._unbindUpdownCloseSources();
      restartAnim('close'); 
      
      if (this._side === 'full_screen') {
        this._unlockBodyScroll();
      }

      if (this._side !== 'full_screen' && this._config.popup_outside_blur) {
        this._overlayEl.removeAttribute('data-anim'); 
        void this._overlayEl.offsetWidth;
        this._overlayEl.setAttribute('data-anim', 'close');
      }
    }
  }

  close() {
    if (!this._open) return; 
    this._open = false; 
    this.setAttribute('data-closing', '');
    if (!this._config?.popup_outside_blur) this._pressable.classList.remove('pressed','effect');
    this._closingAnim = true; 
    this._popupEl.removeAttribute('data-anim'); void this._popupEl.offsetWidth; 
    this._popupEl.setAttribute('data-anim','close'); 

    if (this._side !== 'full_screen' && this._config.popup_outside_blur) {
      this._overlayEl.removeAttribute('data-anim'); void this._overlayEl.offsetWidth;
      this._overlayEl.setAttribute('data-anim','close');
    }
    if (this._side === 'full_screen') this._unlockBodyScroll(); 
  }

  positionPopup() {
    const side = this._side || 'bottom'; const popup = this._popupEl;
    if (side === 'full_screen') {
      popup.classList.add('fullscreen'); popup.style.top='0px'; popup.style.left='0px'; popup.style.width='100vw'; popup.style.height='100vh';
      this._ensureFullscreenWrap(); this._applyFullscreenSizeDefaults(); this._lockBodyScroll(); return;
    }
    popup.classList.remove('fullscreen');
    const offset = 6;
    const rect = this._anchorRectOnDown || this._toggleEl.getBoundingClientRect();
    switch (side) {
      case 'top':    popup.style.top = `${rect.top - popup.offsetHeight - offset}px`; popup.style.left = `${rect.left}px`; break;
      case 'left':   popup.style.top = `${rect.top}px`; popup.style.left = `${rect.left - popup.offsetWidth - offset}px`; break;
      case 'right':  popup.style.top = `${rect.top}px`; popup.style.left = `${rect.right + offset}px`; break;
      case 'bottom':
      default:       popup.style.top = `${rect.bottom + offset}px`; popup.style.left = `${rect.left}px`; break;
    }
  }

  /* ================= 全屏包装 & 监听 ================= */
  _shouldGuardInitialTap() {
    return this._side === 'full_screen' && performance.now() < this._openGuardUntil;
  }

  _onOverlayGuardClick = (e) => {
    if (this._shouldGuardInitialTap()) {
      e.stopImmediatePropagation?.();
      e.stopPropagation();
      e.preventDefault();
    }
  };
  _onOverlayTouchStart = (e) => {
    if (this._side !== 'full_screen') return;
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (t) this._lastTouchY = t.clientY;
  };

  _ensureFullscreenWrap() {
    if (this._contentWrap) { this._updateFsFooterReserve(); return; }
    const wrap = document.createElement('div');
    wrap.className = 'content-wrap';
    
    wrap.style.scrollbarWidth = 'none';
    wrap.style.msOverflowStyle = 'none';
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-fab'; 
    closeBtn.setAttribute('aria-label','Close'); 
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => { 
      e.stopPropagation(); 
      this.close(); 
    }, { passive: true });
    
    const frag = document.createDocumentFragment(); 
    while (this._popupEl.firstChild) frag.appendChild(this._popupEl.firstChild);
    wrap.appendChild(frag); 
    this._popupEl.innerHTML = ''; 
    this._popupEl.appendChild(wrap); 
    this._popupEl.appendChild(closeBtn);
    
    this._contentWrap = wrap; 
    this._closeBtn = closeBtn;
    
    if (this._config.styles?.content) this.applyStyleList(wrap, this._config.styles.content);
    if (this._config.styles?.popup_close_button) this.applyStyleList(closeBtn, this._config.styles.popup_close_button);
    if (this._config.styles?.overlay) this.applyStyleList(this._popupEl, this._config.styles.overlay);
    
    this._updateFsFooterReserve(); 
    this._setupFullscreenOverlayListeners();
    this._popupEl.removeEventListener('click', this._onOverlayClickToClose, { capture:false });
    this._popupEl.addEventListener('click', this._onOverlayClickToClose, { capture:false });
  }
  
  _updateFsFooterReserve() {
    if (!this._contentWrap) return; 
    const bottomGapCfgList = this._config?.styles?.content || []; 
    const reserve = Math.round(bottomGapCfgList);
    this._contentWrap.style.paddingBottom = `${reserve}px`;
  }
  
  _applyFullscreenSizeDefaults() {}
  
  _destroyFullscreenWrap() {
    if (!this._contentWrap) return; 
    const frag = document.createDocumentFragment(); 
    while (this._contentWrap.firstChild) frag.appendChild(this._contentWrap.firstChild); 
    this._popupEl.innerHTML = ''; 
    this._popupEl.appendChild(frag); 
    this._contentWrap = null; 
    this._closeBtn = null;
  }
  
  _setupFullscreenOverlayListeners() {
    if (!this._popupEl) return; 
    this._popupEl.addEventListener('click', this._onOverlayClickToClose, { capture:false });
    this._popupEl.addEventListener('click', this._onOverlayGuardClick, { capture:true, passive:false });
    this._popupEl.addEventListener('pointerup', this._onOverlayGuardClick, { capture:true, passive:false });
    this._popupEl.addEventListener('touchend', this._onOverlayGuardClick, { capture:true });
    this._popupEl.addEventListener('touchstart', this._onOverlayTouchStart, { passive:false });
    window.addEventListener('wheel', this._onFsWheelOrTouchMove, { capture: true, passive: false });
    window.addEventListener('touchmove', this._onFsWheelOrTouchMove, { capture: true, passive: false });
  }
  
  _teardownFullscreenOverlayListeners() {
    if (!this._popupEl) return; 
    this._popupEl.removeEventListener('click', this._onOverlayClickToClose, { capture:false });
    this._popupEl.removeEventListener('click', this._onOverlayGuardClick, { capture:true });
    this._popupEl.removeEventListener('pointerup', this._onOverlayGuardClick, { capture:true });
    this._popupEl.removeEventListener('touchend', this._onOverlayGuardClick, { capture:true });
    this._popupEl.removeEventListener('touchstart', this._onOverlayTouchStart, { passive:false });
    this._destroyFullscreenWrap();
    window.removeEventListener('wheel', this._onFsWheelOrTouchMove, { capture: true });
    window.removeEventListener('touchmove', this._onFsWheelOrTouchMove, { capture: true });
  }

  
  _onFsWheelOrTouchMove = (e) => {
    // 只在当前卡处于 fullscreen 且已打开时处理
    if (!this._open || this._side !== 'full_screen') return;
    if (!this._popupEl || !this._contentWrap) return;

    // 使用 composedPath 判断事件是否在当前 popup 内
    const path = e.composedPath ? e.composedPath() : [];
    const inPopup = path.includes(this._popupEl);
    if (!inPopup) return;  // 不属于这个 popup，放行

    // 是否在内容容器内（content-wrap 及其子树）
    const inContent = path.includes(this._contentWrap);

    // ✅ 不在 content 内（也就是 overlay 上）→ 禁止滚动
    if (!inContent) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // ✅ 在 content 内部 → 完全放行，让子卡 / content-wrap 自己处理滚动
    // 不做任何 preventDefault
  };



  _onOverlayWheelOrTouchMove(e) {
    // fullscreen 的滚动由 _onFsWheelOrTouchMove 负责，这里直接退出
    if (this._side === 'full_screen') return;

    if (this._config?.popup_outside_blur) {
      const inPopup = this._popupEl && (this._popupEl === e.target || this._popupEl.contains(e.target));
      if (!inPopup) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }


  _onOverlayClickToClose(e) { 
    if (!this._overlayArmed || this._justOpened) return; 
    const wrap = this._contentWrap; 
    const btn = this._closeBtn; 
    if (btn && (e.target === btn || btn.contains(e.target))) return; 
    if (wrap && wrap.contains(e.target)) return; 
    this.close(); 
  }

  /* ================= 事件：全局 / 弹层 ================= */
  _onWindowPointerUp(e) {
    if (this._side === 'full_screen') return;
    if (!this._open) return;
    if (this._config && this._config.multi_expand) return;
    if (this._justOpened) return;
    
    const path = e.composedPath?.() || [];
    const inSelf = path.includes(this) || path.includes(this.shadowRoot);
    const inPopup = path.includes(this._popupEl);
    const inBtn = path.includes(this._toggleEl);
    if (!inSelf && !inPopup && !inBtn) this.close();
  }

  _onWindowPointerDownCapture(e) {
    if (!this._open || this._side === 'full_screen') return;
    if (!this._overlayArmed || this._justOpened) return;
    const path = e.composedPath ? e.composedPath() : null;
    const inPopup  = path ? path.includes(this._popupEl)  : this._popupEl.contains(e.target);
    const inToggle = path ? path.includes(this._toggleEl) : this._toggleEl.contains(e.target);
    if (!inPopup && !inToggle) this.close();
  }
  
  _onWindowScroll() {
    if (!this._open) return;
    if (this._side === 'full_screen') return;
    if (this._anchorRectOnDown) this._anchorRectOnDown = null;
    if (this._config.updown_slide_to_close_popup) {
      this.close();
      return;
    }
    this.positionPopup();
  }
  
  _onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      if (this._popupEl) { 
        this._popupEl.style.display = 'none'; 
        this._popupEl.removeAttribute('data-anim'); 
        this._popupEl.classList.remove('fullscreen'); 
      }
      this._open = false; 
      this._unlockBodyScroll(); 
      this._destroyFullscreenWrap();

      this._closingAnim = false;
      this._overlayArmed = false;
      this._justOpened = false;
      this._pressable?.classList.remove('pressed','effect');
      this._pressable?.style?.removeProperty('--effect-color');
      this.removeAttribute('data-active');
      this.removeAttribute('data-fullscreen');
      this.removeAttribute('data-closing');
      this.removeAttribute('data-opening');
      this.removeAttribute('data-yield');
      if (this._overlayEl) {
        this._overlayEl.style.pointerEvents = 'none';
        this._overlayEl.style.display = 'none';
        this._overlayEl.removeAttribute('data-anim');
      }
    }
  }
  
  _onAnimationEnd(e) {
    if (this._open && this.hasAttribute('data-opening') &&
        e?.target === this._popupEl && this._popupEl.getAttribute('data-anim') === 'open') {
      this.removeAttribute('data-opening');
    }
    if (this._closingAnim && !this._open) {
      this._closingAnim = false; 
      this._popupEl.style.display = 'none'; 
      this._popupEl.removeAttribute('data-anim');
      if (this._side === 'full_screen') { 
        this._popupEl.classList.remove('fullscreen'); 
        this._destroyFullscreenWrap(); 
      }
      if (this._overlayEl) {
        this._overlayEl.style.pointerEvents = 'none';
        this._overlayEl.style.display = 'none';
        this._overlayEl.removeAttribute('data-anim');
      }
      this._pressable.classList.remove('pressed','effect');
      this.removeAttribute('data-blur-closing');
      this.removeAttribute('data-active');
      this.removeAttribute('data-fullscreen');
      this.removeAttribute('data-closing');
      this.removeAttribute('data-yield');
    
      if (this._config?.popup_outside_blur) this._unlockBodyScroll();
    }
  }

  /* ============ 执行 HA 动作 ============ */
  _handleHaAction(actionCfg = {}, type = 'tap') {
    if (!actionCfg || actionCfg.action === 'none') return; 
    const hass = this._hass; 
    if (!hass) return;
    
    const fire = (type, detail = {}) => { 
      this.dispatchEvent(new CustomEvent(type, { detail, bubbles:true, composed:true })); 
    };
    
    const fallbackEntity = actionCfg.entity || this._config.entity || (this._contentCard?.config?.entity);
    
    switch (actionCfg.action) {
      case 'perform-action': {
        let domain, service; 
        const svc = actionCfg.perform_action || actionCfg.service;
        if (typeof svc === 'string' && svc.includes('.')) [domain, service] = svc.split('.',2); 
        else { domain = actionCfg.domain; service = actionCfg.service; }
        if (!domain || !service) return; 
        const data = actionCfg.data || actionCfg.service_data || {}; 
        const target = actionCfg.target; 
        hass.callService(domain, service, data, target); 
        break; 
      }
      case 'call-service': {
        let domain, service; 
        const svc = actionCfg.service; 
        if (typeof svc === 'string' && svc.includes('.')) [domain, service] = svc.split('.',2); 
        else { domain = actionCfg.domain; service = actionCfg.service; }
        if (!domain || !service) return; 
        const data = actionCfg.service_data || actionCfg.data || {}; 
        const target = actionCfg.target; 
        hass.callService('homeassistant'==='homeassistant'?domain:domain, service, data, target); 
        break; 
      }
      case 'more-info': { 
        const entityId = actionCfg.entity || fallbackEntity; 
        if (!entityId) return; 
        fire('hass-more-info', { entityId }); 
        break; 
      }
      case 'navigate': { 
        const path = actionCfg.navigation_path || actionCfg.url_path || actionCfg.url; 
        if (!path) return; 
        fire('hass-navigate', { path }); 
        break; 
      }
      case 'url': { 
        const url = actionCfg.url || actionCfg.url_path || actionCfg.navigation_path; 
        if (!url) return; 
        window.open(url, actionCfg.new_tab === false ? '_self' : '_blank', 'noopener'); 
        break; 
      }
      case 'toggle': { 
        const entityId = actionCfg.entity || fallbackEntity; 
        if (!entityId) return; 
        hass.callService('homeassistant','toggle',{ entity_id: entityId }); 
        break; 
      }
      case 'fire-dom-event': { 
        const ev = new CustomEvent('ll-custom', { 
          detail: actionCfg.data || {}, 
          bubbles:true, 
          composed:true 
        }); 
        this.dispatchEvent(ev); 
        break; 
      }
      default: { 
        fire('action', { 
          action: actionCfg.action, 
          config: actionCfg, 
          entity: fallbackEntity, 
          card: this, 
          type 
        }); 
      }
    }
  }

  /* ================= 内容加载（支持 content.from_id + YAML 预览兜底） ================= */
  async loadContent() {
    // 内容源模式（card_function: content）不在弹窗里加载 DOM
    if (this._cardFunction === 'content') return;

    if (!this._popupEl) return;
    // 清空旧内容
    this._popupEl.innerHTML = '';
    this._contentWrap = null;
    this._closeBtn = null;

    const content = this._config.content;
    if (!content) return;

    // 解析 from_id（优先）
    let effectiveCardConfig = null;
    let fromIdNotFound = false;
    if (this._cardFunction === 'button' && content.from_id) {
      // 1) 先查运行时注册表（正常视图）
      const provider = __pbcLookupContent(content.from_id);
      if (provider) {
        effectiveCardConfig = provider.getConfig();
      } else {
        // 2) YAML 原始编辑器等场景：回退到“直接扫描 Lovelace 配置”
        const cfg = PopupButtonCard._getLovelaceConfig?.();
        const extracted = __pbcFindContentInConfig(cfg, content.from_id);
        if (extracted) {
          effectiveCardConfig = extracted;
        } else {
          fromIdNotFound = true; // 真的找不到，再走占位提示
        }
      }
    }

    // 选择最终 card 配置；若缺失则用占位 markdown 防止 “No card type configured”
    let cardConfig = effectiveCardConfig || content.card || content;

    // 如果还是拿不到合法的 type，构造一个占位卡
    if (!cardConfig || typeof cardConfig !== 'object' || !cardConfig.type) {
      if (fromIdNotFound) {
        // YAML 原始编辑器里只渲染当前卡，内容源未挂载很常见——给出友好提示
        cardConfig = {
          type: 'markdown',
          content: `⚠️ content.from_id "**${content.from_id}**" 未在当前仪表盘中找到该内容源。\n\n请确保已配置contend_id或content_id正确。`
        };
      } else {
        cardConfig = {
          type: 'markdown',
          content: '⚠️ 未提供 content.card，且没有有效的 content.from_id。'
        };
      }
    }

    const helpers = await window.loadCardHelpers();

    try {
      const cardEl = await helpers.createCardElement(cardConfig);
      cardEl.hass = this._hass;
      try { cardEl.variables = this._variables; } catch (_e) {}

      if (this._config.entity && cardEl.config && !cardEl.config.entity) {
        cardEl.config.entity = this._config.entity;
      }
      this._contentCard = cardEl;

      if (this._side === 'full_screen') {
        this._ensureFullscreenWrap();
        this._contentWrap.appendChild(cardEl);
        this._applyFullscreenSizeDefaults();
      } else {
        this._popupEl.appendChild(cardEl);
        // 隐藏滚动条
        this._popupEl.style.scrollbarWidth = 'none';
        this._popupEl.style.msOverflowStyle = 'none';
      }
    } catch (e) {
      this._popupEl.innerHTML = `<div style="color:red">卡片加载失败: ${e?.message || e}</div>`;
    }

    // 应用样式 & 溢出滚动
    if (this._config.styles?.content) {
      if (this._side === 'full_screen') this.applyStyleList(this._contentWrap, this._config.styles.content);
      else this.applyStyleList(this._popupEl, this._config.styles.content);
    }
    this._updateContentOverflowScroll();
  }


  /* ================== any tap to close（原逻辑保留） ================== */
  _armAnyTapToClose() {
    if (!this._popupEl) return;
    if (!this._config?.any_ha_action_to_close_popup) return;

    const isFullscreen = this._side === 'full_screen';

    const delay = Number(this._config?.any_tap_close_delay_ms ?? 500);
    const PRIME_WINDOW_MS = Number(this._config?.any_tap_prime_window_ms ?? 1500);
    const closeOnMoreInfo = this._config?.close_on_more_info ?? true;
    const moreInfoDelayMs = Number(this._config?.close_more_info_delay_ms ?? 500);

    const root = isFullscreen ? this._contentWrap : this._popupEl;
    if (!root) return;

    // ——— 调度器 ———
    const schedule = () => {
      if (this._shouldGuardInitialTap?.() || this._justOpened) return; // 刚打开保护期
      if (!this._open) return;
      if (this._anyTapCloseTimer) clearTimeout(this._anyTapCloseTimer);
      this._anyTapCloseTimer = setTimeout(() => { if (this._open) this.close(); }, delay);
    };

    // 绕过保护期用于“立即/短延迟”关闭（给 hass-more-info 用）
    const closeSoon = (ms = 0) => {
      if (!this._open) return;
      if (this._anyTapCloseTimer) clearTimeout(this._anyTapCloseTimer);
      this._anyTapCloseTimer = setTimeout(() => { if (this._open) this.close(); }, ms);
    };

    // ——— 交互引子：记录最近一次弹窗内用户动作时间戳 ———
    this._lastPopupUserActionTs = this._lastPopupUserActionTs ?? 0;
    const markAction = () => { this._lastPopupUserActionTs = Date.now(); };
    const recentlyInPopup = () => (Date.now() - (this._lastPopupUserActionTs || 0)) <= PRIME_WINDOW_MS;

    const onClick     = (e) => { if (root.contains(e.target)) markAction(); };
    const onPointerUp = (e) => { if (root.contains(e.target)) markAction(); };
    const onKeyDown   = (e) => { if (root.contains(e.target)) markAction(); };
    const onChange    = (e) => { if (root.contains(e.target)) markAction(); };
    const onInput     = (e) => { if (root.contains(e.target)) markAction(); };
    const onTouchEnd  = (e) => { if (root.contains(e.target)) markAction(); };

    root.addEventListener('click', onClick, { capture: true });
    root.addEventListener('pointerup', onPointerUp, { capture: true });
    root.addEventListener('keydown', onKeyDown, { capture: true });
    root.addEventListener('change', onChange, { capture: true });
    root.addEventListener('input', onInput, { capture: true });
    root.addEventListener('touchend', onTouchEnd, { capture: true });

    const _normalizeList = (v) => {
      if (v == null) return [];
      if (typeof v === 'string') return v.trim().toLowerCase() === 'all' ? 'all' : [v];
      if (Array.isArray(v)) return v.map(x => String(x ?? '').toLowerCase());
      return [];
    };

    const _shouldCloseByFilter = (kind, text) => {
      const filterCfg = this._config?.filter_for_ha_action_to_close_popup;
      if (!filterCfg) return true;

      const include = _normalizeList(filterCfg.include_keyword);
      const exclude = _normalizeList(filterCfg.exclude_keyword);

      const hay = String([kind, text].filter(Boolean).join(' ')).toLowerCase();

      if (exclude === 'all') return false;
      if (include === 'all') return true;

      if (Array.isArray(exclude) && exclude.length && exclude.some(k => k && hay.includes(k))) return false;

      if (Array.isArray(include) && include.length) {
        return include.some(k => k && hay.includes(k));
      }
      return true;
    };

    const onMoreInfo = (ev) => {
      if (!closeOnMoreInfo) return;
      if (!this._open) return;

      const det = ev?.detail || {};
      const entityIdForFilter = det?.entityId || det?.entity || det?.entity_id || '';
      const textForFilterMoreInfo = `more-info ${entityIdForFilter}`;
      if (!_shouldCloseByFilter('more-info', textForFilterMoreInfo)) return;

      if (isFullscreen) {
        if (!recentlyInPopup()) return;

        const det    = ev?.detail || {};
        const target = ev.target || window;
        const openDelay = Number(this._config?.close_more_info_delay_ms ?? 250);

        ev.stopImmediatePropagation();
        ev.preventDefault?.();

        closeSoon(0);

        setTimeout(() => {
          const re = new CustomEvent('hass-more-info', {
            detail: { ...det, __pbc_gated: true },
            bubbles: true, composed: true
          });
          try { target.dispatchEvent(re); } catch { window.dispatchEvent(re); }
        }, openDelay);

        return;
      }

      if (det.__pbc_gated) return;

      const shouldGate =
        recentlyInPopup() || !this._config?.multi_expand || !!this._config?.popup_outside_blur;
      if (!shouldGate) return;

      ev.stopImmediatePropagation();
      ev.preventDefault?.();

      window.dispatchEvent(new CustomEvent('expandable-yield-others', { detail: { source: 'more-info-gate' } }));
      window.dispatchEvent(new CustomEvent('expandable-close-all',   { detail: { source: 'more-info-gate' } }));

      const openDelay = moreInfoDelayMs;
      const target = ev.target || window;
      setTimeout(() => {
        const re = new CustomEvent('hass-more-info', {
          detail: { ...det, __pbc_gated: true },
          bubbles: true, composed: true
        });
        try { target.dispatchEvent(re); } catch { window.dispatchEvent(re); }
      }, openDelay);
    };

    window.addEventListener('hass-more-info', onMoreInfo, { capture: true });

    const currentUserId = this._hass?.user?.id;
    const serviceEventHandler = (ev) => {
      const ctx = ev?.context || ev?.data?.context || {};
      const userOk = !!ctx.user_id && ctx.user_id === currentUserId;
      if (!userOk) return;
      if (!recentlyInPopup()) return;

      const d = ev?.data || {};
      const domain = d.domain || '';
      const service = d.service || '';
      const ents = []
        .concat(d?.service_data?.entity_id || [])
        .concat(d?.service_data?.entityIds || [])
        .filter(Boolean)
        .join(' ');
      const textForFilterSvc = `${domain}.${service} ${ents}`.trim();
      if (!_shouldCloseByFilter('call_service', textForFilterSvc)) return;

      schedule();
    };

    this._unsubCallService = null;
    try {
      const conn = this._hass?.connection;
      if (conn?.subscribeEvents) {
        conn.subscribeEvents(serviceEventHandler, 'call_service')
            .then(unsub => { this._unsubCallService = unsub; })
            .catch(() => { /* 忽略订阅失败 */ });
      }
    } catch { /* 忽略 */ }

    const onNavigate = (ev) => {
      if (!this._open) return;
      if (!recentlyInPopup()) return;
      const path = ev?.detail?.path || ev?.detail?.url || ev?.detail || '';
      const textForFilterNav = `navigation ${path}`;
      if (!_shouldCloseByFilter('navigation', textForFilterNav)) return;
      schedule();
    };
    window.addEventListener('hass-navigate', onNavigate, { capture: true });

    const prevCleanup = this._anyTapCloseCleanup;
    this._anyTapCloseCleanup = () => {
      try {
        root.removeEventListener('click', onClick, { capture: true });
        root.removeEventListener('pointerup', onPointerUp, { capture: true });
        root.removeEventListener('keydown', onKeyDown, { capture: true });
        root.removeEventListener('change', onChange, { capture: true });
        root.removeEventListener('input', onInput, { capture: true });
        root.removeEventListener('touchend', onTouchEnd, { capture: true });
        window.removeEventListener('hass-more-info', onMoreInfo, { capture: true });
        window.removeEventListener('hass-navigate', onNavigate, { capture: true });
      } catch {}
      if (this._unsubCallService) {
        try { this._unsubCallService(); } catch {}
        this._unsubCallService = null;
      }
      if (this._anyTapCloseTimer) { clearTimeout(this._anyTapCloseTimer); this._anyTapCloseTimer = null; }
      if (prevCleanup) prevCleanup();
    };
  }

  _teardownAnyTapToClose() {
    if (this._anyTapCloseTimer) { clearTimeout(this._anyTapCloseTimer); this._anyTapCloseTimer = null; }
    if (this._anyTapCloseCleanup) this._anyTapCloseCleanup();
  }

  getCardSize() { return 1; }
}

/* =============== 自定义元素注册 =============== */
if (!customElements.get('popup-button-card')) { 
  customElements.define('popup-button-card', PopupButtonCard); 
}
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === 'popup-button-card')) {
  window.customCards.push({ 
    type: 'popup-button-card', 
    name: 'Popup Button Card v2.3.0', 
    description: '一个带弹窗的按钮卡片' 
  });
}
