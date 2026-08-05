import { Component } from '@theme/component';
import { fetchConfig } from '@theme/utilities';
import { CartLinesUpdateEvent } from '@shopify/events';

/**
 * Reads the cart back after a write, the way the standard cart event wants it.
 *
 * Mirrors product-form's own refresh: the cart-items component holds the
 * authoritative copy on pages that render one, and the Ajax API is the fallback
 * everywhere else (a product page with no cart section, for instance).
 *
 * @returns {Promise<any>} the cart, in Ajax API shape
 */
async function refreshCart() {
  const cartItems = /** @type {any} */ (document.querySelector('cart-items-component'));

  if (cartItems) {
    await customElements.whenDefined('cart-items-component');
    return cartItems.fetchCartData();
  }

  const response = await fetch(`${Theme.routes.cart_url}.json`, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });

  if (!response.ok) throw new Error(`Failed to fetch cart: ${response.status}`);

  return response.json();
}

const COOKIE_NAME = 'bm_bundle';
const COOKIE_DAYS = 365;
const STORE_EVENT = 'bundle:change';

/* ---------------------------------------------------------------------------
 * Bundle store
 *
 * Persists the in-progress bundle in a first-party cookie so it survives
 * navigations. JSON shape:
 *   { items: [{ variant_id, selling_plan_id, product_id, image,
 *               product_title, variant_title, plan_label, price, handle }] }
 *
 * Cookies cap out at ~4KB. With max 4 short entries we are well under that.
 * --------------------------------------------------------------------------- */

const BundleStore = {
  /** @returns {{items: Array<Record<string, any>>}} */
  read() {
    const match = document.cookie.split('; ').find((row) => row.startsWith(`${COOKIE_NAME}=`));
    if (!match) return { items: [] };
    try {
      const raw = decodeURIComponent(match.split('=')[1] || '');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) return parsed;
    } catch (_) {
      /* fall through */
    }
    return { items: [] };
  },

  /** @param {{items: Array<Record<string, any>>}} data */
  write(data) {
    const value = encodeURIComponent(JSON.stringify(data));
    const expires = new Date(Date.now() + COOKIE_DAYS * 864e5).toUTCString();
    document.cookie = `${COOKIE_NAME}=${value}; expires=${expires}; path=/; SameSite=Lax`;
    document.dispatchEvent(new CustomEvent(STORE_EVENT, { detail: data }));
  },

  /** @returns {Array<Record<string, any>>} */
  items() {
    return this.read().items;
  },

  /** @param {Record<string, any>} item */
  add(item) {
    const data = this.read();
    data.items.push(item);
    this.write(data);
  },

  /** @param {number} index */
  removeAt(index) {
    const data = this.read();
    if (index < 0 || index >= data.items.length) return;
    data.items.splice(index, 1);
    this.write(data);
  },

  clear() {
    this.write({ items: [] });
  },
};

/* ---------------------------------------------------------------------------
 * BuildABoxSection
 *
 * Marker wrapper around the Collection-tabs UI. Flow when a card's
 * "Choose options" button is clicked:
 *
 *   1. Capture the click bubbling up from a card; stash product info (handle,
 *      title, image) and flag the shared <quick-add-dialog> with
 *      `data-bundle-mode` ("bundle"|"normal") plus dataset.bundleHandle.
 *   2. The framework's existing quick-add handler also fires (we let it run);
 *      it fetches the product page and morphs it into `#quick-add-modal-content`.
 *   3. A *one-shot* MutationObserver waits for that first render to settle,
 *      then replaces the modal's content entirely with our Figma-styled bundle
 *      layout — and immediately disconnects, so subsequent interactions never
 *      re-trigger the observer. (Earlier versions kept observing on every DOM
 *      change, causing the modal to loop on itself and block close clicks.)
 *
 * For single-variant "Add" buttons (no modal) we short-circuit and push the
 * item straight into the bundle store with One-time frequency.
 *
 * @extends Component<{}>
 * --------------------------------------------------------------------------- */
class BuildABoxSection extends Component {
  /** @type {AbortController} */
  #ac = new AbortController();
  /** @type {Map<string, any>} Cached /products/{handle}.js responses keyed by handle. */
  #productCache = new Map();

  get minItems() {
    return Number(this.dataset.minItems) || 4;
  }
  get maxItems() {
    return Number(this.dataset.maxItems) || 4;
  }

  connectedCallback() {
    super.connectedCallback();
    // No section-level listener anymore — the click is intercepted at
    // window-capture phase (see installWindowInterceptor below) so we beat the
    // framework's document-capture handler. That eliminates the flash of the
    // default quick-add popup that previously appeared on the first click.
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#ac.abort();
  }

  /**
   * Entry point called by the window-capture interceptor. Opens the shared
   * quick-add dialog directly with our custom layout — no MutationObserver,
   * no dependency on the framework's morph.
   *
   * Two modes share the same two-column layout:
   *   bundle = true  → frequency dropdown + ADD TO BUNDLE → writes to cookie
   *   bundle = false → quantity selector + ADD TO CART    → POST /cart/add.js
   *
   * @param {{handle: string, productId: string, productTitle: string, image: string}} ctx
   * @param {{form: HTMLFormElement | Element | null, button: 'choose'|'add', bundle: boolean}} opts
   */
  async openBundleModal(ctx, opts) {
    if (opts.button === 'add') {
      if (opts.bundle) await this.#addCurrentToBundle({ form: opts.form, ctx });
      else await this.#addCurrentToCart({ form: opts.form, ctx });
      return;
    }

    const dialog = document.getElementById('quick-add-dialog');
    if (!dialog) return;
    const modalContent = dialog.querySelector('#quick-add-modal-content');
    if (!modalContent) return;

    // The dialog dataset doubles as render context and as a "modal is currently
    // ours" sentinel that survives async work.
    dialog.setAttribute('data-bundle-mode', opts.bundle ? 'bundle' : 'normal');
    dialog.dataset.bundleSectionId = this.dataset.sectionId || '';
    dialog.dataset.bundleHandle = ctx.handle;
    dialog.dataset.bundleProductId = ctx.productId;
    dialog.dataset.bundleProductTitle = ctx.productTitle;
    dialog.dataset.bundleImage = ctx.image;

    // Render a lightweight loading skeleton immediately so the modal never
    // shows the default quick-add content while we wait on /products/{handle}.js.
    modalContent.innerHTML = this.#loadingHTML(ctx);

    // Open the dialog now.
    const dlg = /** @type {any} */ (dialog);
    if (typeof dlg.showDialog === 'function') dlg.showDialog();

    // Teardown on close — register before the async work in case the user closes early.
    dialog.addEventListener(
      'dialog:close',
      () => {
        dialog.removeAttribute('data-bundle-mode');
        delete dialog.dataset.bundleSectionId;
        delete dialog.dataset.bundleHandle;
        delete dialog.dataset.bundleProductId;
        delete dialog.dataset.bundleProductTitle;
        delete dialog.dataset.bundleImage;
      },
      { once: true }
    );

    // Fetch product data, then render.
    const productData = await this.#getProductData(ctx.handle);
    if (!dialog.getAttribute('data-bundle-mode')) return; // closed in the meantime
    this.#renderBundleModal(dialog, modalContent, ctx, productData, opts.bundle);
  }

  /**
   * Minimal loading skeleton shown while /products/{handle}.js is in flight.
   * Reuses the same two-column layout so there's no jump when the real content arrives.
   *
   * @param {{image: string, productTitle: string}} ctx
   */
  #loadingHTML(ctx) {
    return `
      <div class="bab-modal bab-modal--loading" data-bab-root>
        <div class="bab-modal__media">
          <div class="bab-modal__media-scroller">
            ${ctx.image
        ? `<img class="bab-modal__image" src="${escapeAttr(ctx.image)}" alt="" />`
        : ''}
          </div>
        </div>
        <div class="bab-modal__info">
          <header class="bab-modal__header">
            <h2 class="bab-modal__title">${escapeHtml(ctx.productTitle || '')}</h2>
          </header>
          <div class="bab-modal__loading-spinner" aria-hidden="true"></div>
        </div>
      </div>
    `;
  }

  /**
   * Render the Figma-styled modal into `#quick-add-modal-content`.
   *
   * @param {HTMLElement} dialog
   * @param {Element} modalContent
   * @param {{handle: string, productId: string, productTitle: string, image: string}} ctx
   * @param {any} productData
   * @param {boolean} isBundle - true: bundle popup; false: standard cart popup
   */
  #renderBundleModal(dialog, modalContent, ctx, productData, isBundle = true) {
    /** @type {any[]} */
    const variants = Array.isArray(productData?.variants) ? productData.variants : [];
    /** @type {string[]} */
    const options = Array.isArray(productData?.options) ? productData.options : [];

    // State held on the modal element so re-renders can read it.
    const initialVariant = variants.find((v) => v.available) || variants[0] || null;
    /** @type {(string | null)[]} */
    const selectedValues = [
      initialVariant?.option1 ?? null,
      initialVariant?.option2 ?? null,
      initialVariant?.option3 ?? null,
    ];

    const sellingPlans = this.#flattenSellingPlans(productData);
    let selectedPlanIdx = 0; // 0 = first option (One-time or first subscription)

    const productTitle = productData?.title || ctx.productTitle || '';
    // ctx.flavorNotes comes from `data-product-flavor-notes` (rendered by the
    // Quick-add block from `product.metafields.custom.card_flavor_notes`).
    // Fall back to DOM scraping only if the attribute wasn't there.
    const flavorNotes = ctx.flavorNotes || this.#flavorNotesFromCard(ctx) || '';
    const cardLabel = this.#cardLabelFromCard(ctx);
    const imageSrcs = this.#productImageSrcs(productData, ctx);

    let quantity = 1;
    const description = productData?.description || '';
    const productUrl = productData?.url || (ctx.handle ? `/products/${ctx.handle}` : '');

    modalContent.innerHTML = this.#layoutHTML({
      isBundle,
      productTitle,
      flavorNotes,
      cardLabel,
      imageSrcs,
      options,
      variants,
      selectedValues,
      sellingPlans,
      selectedPlanIdx,
      quantity,
      description,
      productUrl,
    });

    // Wire interactions. We deliberately re-render specific subtrees rather
    // than the whole modal to keep focus and dropdown state stable.
    const root = /** @type {HTMLElement} */ (modalContent);

    /** Find the variant matching the current selectedValues. */
    const currentVariant = () => {
      return variants.find((v) =>
        selectedValues.every((val, i) => val === null || v[`option${i + 1}`] === val)
      ) || initialVariant;
    };

    /**
     * Mirrors variant-picker.js's recomputeAvailability for our pill UI: an
     * option value at position P is available iff some *available* variant
     * exists where option(P) === value AND option(Q) === selectedValues[Q]
     * for every other position Q. Pills that don't pass are flagged with
     * aria-disabled so CSS can strike them through.
     */
    const recomputeAvailability = () => {
      const isAvailable = (/** @type {number} */ optIdx, /** @type {string} */ value) =>
        variants.some((v) => {
          if (!v.available) return false;
          if (v[`option${optIdx + 1}`] !== value) return false;
          for (let i = 0; i < selectedValues.length; i++) {
            if (i === optIdx) continue;
            const sel = selectedValues[i];
            if (sel != null && v[`option${i + 1}`] !== sel) return false;
          }
          return true;
        });

      root.querySelectorAll('[data-bab-variant-btn]').forEach((btn) => {
        const idx = Number(/** @type {HTMLElement} */ (btn).dataset.optionIndex);
        const value = /** @type {HTMLElement} */ (btn).dataset.value || '';
        const ok = isAvailable(idx, value);
        btn.toggleAttribute('aria-disabled', !ok);
      });
    };

    /** Disable the buy CTA when the resulting variant is unavailable. */
    const refreshCta = () => {
      const v = currentVariant();
      const cta = /** @type {HTMLButtonElement | null} */ (root.querySelector('[data-bab-add]'));
      if (!cta) return;
      const unavailable = !v || v.available === false;
      // In bundle mode, the no-plans state already disables the CTA — don't
      // overwrite that. Only act if we're touching availability here.
      if (unavailable) {
        cta.disabled = true;
        cta.textContent = isBundle ? 'UNAVAILABLE' : 'UNAVAILABLE';
      } else if (!(isBundle && sellingPlans.length === 0)) {
        cta.disabled = false;
        cta.textContent = isBundle ? 'ADD TO BUNDLE' : 'ADD TO CART';
      }
    };

    const refreshPrice = () => {
      const v = currentVariant();
      const plan = isBundle ? sellingPlans[selectedPlanIdx] : null;
      const priceBlock = root.querySelector('[data-bab-price]');
      if (priceBlock instanceof HTMLElement && v) {
        priceBlock.innerHTML = this.#priceHTML(v, plan, isBundle);
      }
      if (!isBundle) return;

      const planLabel = root.querySelector('[data-bab-plan-label]');
      if (planLabel instanceof HTMLElement && plan) {
        planLabel.textContent = plan.label;
      }
      const planSavings = root.querySelector('[data-bab-plan-savings]');
      if (planSavings instanceof HTMLElement) {
        const pct = this.#savingsPercent(v, plan);
        planSavings.textContent = pct ? `SAVE ${pct}%` : '';
        planSavings.hidden = !pct;
      }
    };

    /**
     * Scroll the media column to the current variant's featured image.
     * @param {ScrollBehavior} behavior
     */
    const scrollToVariantImage = (behavior = 'smooth') => {
      const v = currentVariant();
      const scroller = /** @type {HTMLElement | null} */ (root.querySelector('[data-bab-media-scroller]'));
      if (!scroller) return;

      /** @type {HTMLImageElement | null} */
      let target = null;

      // 1) Match by variant.featured_image.position (1-indexed → 0-indexed).
      const pos = v?.featured_image?.position;
      if (pos && Number.isFinite(pos)) {
        target = scroller.querySelector(`img[data-image-index="${pos - 1}"]`);
      }

      // 2) Fallback: match by normalized image URL.
      if (!target && v?.featured_image?.src) {
        const key = normalizeImageUrl(v.featured_image.src);
        target = scroller.querySelector(`img[data-image-src="${CSS.escape(key)}"]`);
      }

      if (!target) return;

      // Scroll the scroller directly rather than scrollIntoView, which would
      // also pull the page. Set both axes so the same call works on desktop
      // (vertical snap) and mobile (horizontal snap).
      scroller.scrollTo({
        top: target.offsetTop - scroller.offsetTop,
        left: target.offsetLeft - scroller.offsetLeft,
        behavior,
      });
    };

    // Variant pill buttons.
    root.querySelectorAll('[data-bab-variant-btn]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(/** @type {HTMLElement} */(el).dataset.optionIndex);
        const value = /** @type {HTMLElement} */ (el).dataset.value || null;
        if (Number.isNaN(idx)) return;
        selectedValues[idx] = value;
        // Update pressed state for this option group.
        root
          .querySelectorAll(`[data-bab-variant-btn][data-option-index="${idx}"]`)
          .forEach((b) => {
            const bv = /** @type {HTMLElement} */ (b).dataset.value;
            b.setAttribute('aria-pressed', String(bv === value));
          });
        // Update the "selected value" label next to the option name.
        const selectedLabel = root.querySelector(`[data-bab-selected-value="${idx}"]`);
        if (selectedLabel) selectedLabel.textContent = value || '';
        refreshPrice();
        recomputeAvailability();
        refreshCta();
        scrollToVariantImage('smooth');
      });
    });

    // Initial pass: paint availability + CTA state for the starting selection.
    recomputeAvailability();
    refreshCta();

    // Initial scroll: align the media column to the starting variant's image.
    // Defer one frame so layout has settled and offsetTop reads correctly.
    requestAnimationFrame(() => scrollToVariantImage('instant'));

    if (isBundle) {
      // Frequency dropdown toggle (bundle mode only).
      const dropdown = root.querySelector('[data-bab-frequency]');
      const trigger = root.querySelector('[data-bab-frequency-trigger]');
      const list = root.querySelector('[data-bab-frequency-list]');
      if (trigger && list) {
        trigger.addEventListener('click', () => {
          const open = dropdown?.getAttribute('data-open') === 'true';
          dropdown?.setAttribute('data-open', String(!open));
        });
        // Click-outside closes.
        const docHandler = (/** @type {MouseEvent} */ e) => {
          if (!dropdown?.contains(/** @type {Node} */(e.target))) {
            dropdown?.setAttribute('data-open', 'false');
          }
        };
        document.addEventListener('click', docHandler, true);
        // Clean up the listener when the dialog closes.
        dialog.addEventListener('dialog:close', () => document.removeEventListener('click', docHandler, true), {
          once: true,
        });

        list.querySelectorAll('[data-bab-plan-option]').forEach((opt) => {
          opt.addEventListener('click', () => {
            const idx = Number(/** @type {HTMLElement} */(opt).dataset.planIdx);
            if (Number.isNaN(idx)) return;
            selectedPlanIdx = idx;
            dropdown?.setAttribute('data-open', 'false');
            refreshPrice();
          });
        });
      }

      // Add to bundle.
      root.querySelector('[data-bab-add]')?.addEventListener('click', () => {
        if (BundleStore.items().length >= this.maxItems) return;
        const v = currentVariant();
        const plan = sellingPlans[selectedPlanIdx];
        // Subscription-only bundle: skip silently if no plan is selected.
        if (!v || !plan?.id) return;

        const variantTitle =
          v.title && v.title !== 'Default Title' ? v.title : '';

        BundleStore.add({
          variant_id: v.id,
          selling_plan_id: plan.id,
          product_id: productData?.id ? Number(productData.id) : undefined,
          handle: ctx.handle,
          image: v.featured_image?.src || imageSrcs[0] || ctx.image || '',
          product_title: productTitle,
          variant_title: variantTitle,
          plan_label: plan.label,
          price: v.price,
        });

        this.#closeDialog(dialog);
      });
    } else {
      // Quantity selector (normal mode).
      const qtyInput = /** @type {HTMLInputElement | null} */ (
        root.querySelector('[data-bab-qty-input]')
      );
      const minus = root.querySelector('[data-bab-qty-minus]');
      const plus = root.querySelector('[data-bab-qty-plus]');

      const setQty = (/** @type {number} */ next) => {
        quantity = Math.max(1, Math.floor(next) || 1);
        if (qtyInput) qtyInput.value = String(quantity);
      };

      minus?.addEventListener('click', () => setQty(quantity - 1));
      plus?.addEventListener('click', () => setQty(quantity + 1));
      qtyInput?.addEventListener('change', () => setQty(Number(qtyInput.value)));

      // Add to cart.
      const addBtn = /** @type {HTMLButtonElement | null} */ (root.querySelector('[data-bab-add]'));
      addBtn?.addEventListener('click', async () => {
        const v = currentVariant();
        if (!v || addBtn.dataset.busy === '1') return;
        addBtn.dataset.busy = '1';
        addBtn.disabled = true;

        try {
          await this.#postCartAdd(v.id, quantity);
          this.#closeDialog(dialog);

          // Open the cart drawer if available.
          const drawer = /** @type {any} */ (document.querySelector('cart-drawer-component'));
          if (drawer?.showDialog) drawer.showDialog();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('Add to cart failed', err);
        } finally {
          delete addBtn.dataset.busy;
          addBtn.disabled = false;
        }
      });
    }

    // Cancel link mirrors the X (both modes).
    root.querySelector('[data-bab-cancel]')?.addEventListener('click', () => this.#closeDialog(dialog));

    // Product details expand toggle (both modes).
    root.querySelector('[data-bab-details-toggle]')?.addEventListener('click', (event) => {
      const wrap = /** @type {HTMLElement | null} */ (
        /** @type {HTMLElement} */ (event.currentTarget).closest('[data-bab-details]')
      );
      if (!wrap) return;
      const open = wrap.getAttribute('data-open') === 'true';
      wrap.setAttribute('data-open', String(!open));
    });
  }

  /** @param {HTMLElement} dialog */
  #closeDialog(dialog) {
    const dlg = /** @type {any} */ (dialog);
    if (typeof dlg.closeDialog === 'function') dlg.closeDialog();
    else dialog.querySelector('dialog')?.close?.();
  }

  /* --- Render helpers ----------------------------------------------------- */

  /**
   * @param {{
   *   isBundle: boolean,
   *   productTitle: string,
   *   flavorNotes: string,
   *   cardLabel: string,
   *   imageSrcs: string[],
   *   options: any[],
   *   variants: any[],
   *   selectedValues: (string|null)[],
   *   sellingPlans: Array<{id: number|null, label: string, plan: any}>,
   *   selectedPlanIdx: number,
   *   quantity: number,
   *   description: string,
   *   productUrl: string,
   * }} args
   */
  #layoutHTML({
    isBundle,
    productTitle,
    flavorNotes,
    cardLabel,
    imageSrcs,
    options,
    variants,
    selectedValues,
    sellingPlans,
    selectedPlanIdx,
    quantity,
    description,
    productUrl,
  }) {
    const optionsHTML = options
      .map((opt, optIdx) => {
        // /products/{handle}.js returns options as either ["Size", "Grind"]
        // (older shape) or [{name: "Size", values: [...]}] (newer shape).
        // Handle both.
        const optName = typeof opt === 'string' ? opt : opt?.name || '';
        const values = this.#uniqueOptionValues(variants, optIdx);
        if (!values.length) return '';
        const selected = selectedValues[optIdx];
        return `
          <div class="bab-modal__variant-row">
            <div class="bab-modal__variant-label">
              <span class="bab-modal__variant-name">${escapeHtml(optName)}:</span>
              <span class="bab-modal__variant-value" data-bab-selected-value="${optIdx}">${escapeHtml(selected || '')}</span>
            </div>
            <div class="bab-modal__variant-options">
              ${values
            .map(
              (val) => `
                <button
                  type="button"
                  class="bab-modal__variant-btn"
                  data-bab-variant-btn
                  data-option-index="${optIdx}"
                  data-value="${escapeHtml(val)}"
                  aria-pressed="${val === selected ? 'true' : 'false'}"
                >${escapeHtml(val)}</button>
              `
            )
            .join('')}
            </div>
          </div>
        `;
      })
      .join('');

    const selectedPlan = sellingPlans[selectedPlanIdx];
    const initVariant =
      variants.find((v) =>
        selectedValues.every((val, i) => val === null || v[`option${i + 1}`] === val)
      ) || variants[0] || null;
    const initSavings = this.#savingsPercent(initVariant, selectedPlan);

    const planOptionsHTML = sellingPlans
      .map((p, i) => {
        const pct = this.#savingsPercent(initVariant, p);
        return `
          <button
            type="button"
            class="bab-modal__plan-option"
            data-bab-plan-option
            data-plan-idx="${i}"
            ${i === selectedPlanIdx ? 'aria-selected="true"' : ''}
          >
            <span>${escapeHtml(p.label)}</span>
            ${pct ? `<span class="bab-modal__save-badge">SAVE ${pct}%</span>` : ''}
          </button>
        `;
      })
      .join('');

    return `
      <div class="bab-modal" data-bab-root>
        <div class="bab-modal__media">
          ${cardLabel ? `<div class="bab-modal__card-label">${escapeHtml(cardLabel)}</div>` : ''}
          <div class="bab-modal__media-scroller" data-bab-media-scroller>
            ${imageSrcs
        .map(
          (src, i) =>
            `<img class="bab-modal__image" src="${escapeAttr(src)}" alt="" loading="lazy" data-image-index="${i}" data-image-src="${escapeAttr(normalizeImageUrl(src))}" />`
        )
        .join('')}
          </div>
        </div>

        <div class="bab-modal__info">
          <header class="bab-modal__header">
            <h2 class="bab-modal__title">${escapeHtml(productTitle)}</h2>
            ${flavorNotes ? `<p class="bab-modal__subtitle">${escapeHtml(flavorNotes)}</p>` : ''}
          </header>

          <div class="bab-modal__variants">
            ${optionsHTML}
          </div>

          ${isBundle ? `
            <div class="bab-modal__frequency">
              <p class="bab-modal__frequency-label">Delivery Frequency</p>
              ${sellingPlans.length === 0 ? `
                <p class="bab-modal__no-plans">No subscription plan is available for this product.</p>
              ` : `
                <div
                  class="bab-modal__dropdown"
                  data-bab-frequency
                  data-open="false"
                >
                  <button type="button" class="bab-modal__dropdown-trigger" data-bab-frequency-trigger>
                    <span class="bab-modal__dropdown-value">
                      <span data-bab-plan-label>${escapeHtml(selectedPlan?.label || '')}</span>
                      <span class="bab-modal__save-badge" data-bab-plan-savings ${initSavings ? '' : 'hidden'}>${initSavings ? `SAVE ${initSavings}%` : ''}</span>
                    </span>
                    <svg class="bab-modal__caret" width="12" height="8" viewBox="0 0 12 8" aria-hidden="true">
                      <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <div class="bab-modal__dropdown-list" data-bab-frequency-list role="listbox">
                    ${planOptionsHTML}
                  </div>
                </div>
                <a href="#" class="bab-modal__details" tabindex="-1" aria-hidden="true" onclick="event.preventDefault();return false;">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                    <path d="M2.25 6L9 9.75L15.75 6L9 2.25L2.25 6Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                    <path d="M2.25 6V12L9 15.75M15.75 6V12L9 15.75M9 9.75V15.75" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                  </svg>
                  <span>Subscription Details</span>
                </a>
              `}
            </div>
          ` : `
            <div class="bab-modal__quantity">
              <p class="bab-modal__quantity-label">Quantity</p>
              <div class="bab-modal__qty-stepper">
                <button type="button" class="bab-modal__qty-btn" data-bab-qty-minus aria-label="Decrease quantity">&minus;</button>
                <input type="number" class="bab-modal__qty-input" data-bab-qty-input value="${quantity}" min="1" />
                <button type="button" class="bab-modal__qty-btn" data-bab-qty-plus aria-label="Increase quantity">+</button>
              </div>
            </div>
          `}

          <footer class="bab-modal__footer">
            <div class="bab-modal__price-row" data-bab-price>
              ${initVariant ? this.#priceHTML(initVariant, selectedPlan, isBundle) : ''}
            </div>
            ${!isBundle && productUrl ? `<a class="bab-modal__product-link" href="${escapeAttr(productUrl)}">${sellingPlans.length > 0 ? 'SEE ALL PURCHASE OPTIONS' : 'SEE ALL PRODUCT DETAILS'}</a>` : ''}
            <button type="button" class="bab-modal__cta${!isBundle ? ' bab-modal__cta--secondary' : ''}" data-bab-add ${isBundle && sellingPlans.length === 0 ? 'disabled' : ''}>${isBundle ? 'ADD TO BUNDLE' : 'ADD TO CART'}</button>
            <button type="button" class="bab-modal__cancel" data-bab-cancel>CANCEL</button>
          </footer>

          ${description ? `
            <section class="bab-modal__details-section" data-bab-details data-open="false">
              <button type="button" class="bab-modal__details-toggle" data-bab-details-toggle aria-expanded="false">
                <span>Product details</span>
                <svg class="bab-modal__caret" width="12" height="8" viewBox="0 0 12 8" aria-hidden="true">
                  <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <div class="bab-modal__details-body rte">${description}</div>
            </section>
          ` : ''}
        </div>
      </div>
    `;
  }

  /**
   * @param {any} variant
   * @param {{id: number|null, label: string, plan: any}|null|undefined} plan
   * @param {boolean} [isBundle]
   */
  #priceHTML(variant, plan, isBundle = true) {
    const base = Number(variant.price) || 0;
    const compareAt = Number(variant.compare_at_price) || 0;
    const adjusted = isBundle ? this.#applyPlanAdjustment(base, plan) : base;

    const showCompare = adjusted < base;
    const label = isBundle ? 'Price per delivery:' : 'Price:';

    return `
      <span class="bab-modal__price-label">${label}</span>
      <span class="bab-modal__price-values">
        ${showCompare ? `<s class="bab-modal__price-strike">${formatMoney(base)}</s>` : ''}
        <strong class="bab-modal__price-now">${formatMoney(adjusted)}</strong>
        ${!showCompare && compareAt > base ? `<s class="bab-modal__price-strike">${formatMoney(compareAt)}</s>` : ''}
      </span>
    `;
  }

  /**
   * @param {any[]} variants
   * @param {number} optIdx
   * @returns {string[]}
   */
  #uniqueOptionValues(variants, optIdx) {
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    for (const v of variants) {
      const val = v[`option${optIdx + 1}`];
      if (val && !seen.has(val)) {
        seen.add(val);
        out.push(val);
      }
    }
    return out;
  }

  /**
   * Subscription-only: only emit selling plans. If a product has no plans, the
   * caller renders an empty state and disables the Add CTA.
   *
   * @param {any} productData
   * @returns {Array<{id: number, label: string, plan: any}>}
   */
  #flattenSellingPlans(productData) {
    /** @type {Array<{id: number, label: string, plan: any}>} */
    const out = [];
    const groups = productData?.selling_plan_groups;
    if (!Array.isArray(groups)) return out;
    for (const group of groups) {
      const plans = Array.isArray(group.selling_plans) ? group.selling_plans : [];
      for (const plan of plans) {
        if (plan.id == null) continue;
        out.push({ id: plan.id, label: plan.name || group.name || 'Subscribe', plan });
      }
    }
    return out;
  }

  /**
   * @param {number} basePrice - in cents
   * @param {{plan: any}|null|undefined} entry
   * @returns {number}
   */
  #applyPlanAdjustment(basePrice, entry) {
    const plan = entry?.plan;
    if (!plan) return basePrice;
    const adj = Array.isArray(plan.price_adjustments) ? plan.price_adjustments[0] : null;
    if (!adj) return basePrice;
    if (adj.value_type === 'percentage') {
      const pct = Number(adj.value) || 0;
      return Math.max(0, Math.round(basePrice * (1 - pct / 100)));
    }
    if (adj.value_type === 'fixed_amount') {
      return Math.max(0, basePrice - (Number(adj.value) || 0));
    }
    if (adj.value_type === 'price') {
      return Math.max(0, Number(adj.value) || 0);
    }
    return basePrice;
  }

  /**
   * @param {any} variant
   * @param {{plan: any}|null|undefined} entry
   * @returns {number} 0 when no savings
   */
  #savingsPercent(variant, entry) {
    if (!variant || !entry?.plan) return 0;
    const base = Number(variant.price) || 0;
    if (!base) return 0;
    const adjusted = this.#applyPlanAdjustment(base, entry);
    if (adjusted >= base) return 0;
    return Math.round(((base - adjusted) / base) * 100);
  }

  /**
   * @param {{handle: string, image: string}} ctx
   * @returns {string}
   */
  #flavorNotesFromCard(ctx) {
    // The product-title block also renders inside a `.text-block` (it uses the
    // same `text` snippet), so exclude everything inside the title link.
    const card = document.querySelector(`product-card a[href^="/products/${ctx.handle}"]`)?.closest('product-card');
    if (!card) return '';
    const titleLink = card.querySelector('[ref="productTitleLink"]');
    const blocks = Array.from(card.querySelectorAll('.text-block')).filter(
      (el) => !titleLink || !titleLink.contains(el)
    );
    for (const b of blocks) {
      const txt = (b.textContent || '').trim();
      if (txt && txt.length < 200) return txt;
    }
    return '';
  }

  /**
   * @param {{handle: string}} ctx
   * @returns {string}
   */
  #cardLabelFromCard(ctx) {
    const card = document.querySelector(`product-card a[href^="/products/${ctx.handle}"]`)?.closest('product-card');
    if (!card) return '';
    // Look for a small optional card label (e.g. category/badge) rendered in the card hover-label slot.
    const label = card.querySelector('.product-card__hover-label, [data-product-card-label]');
    return (label?.textContent || '').trim();
  }

  /**
   * @param {any} productData
   * @param {{image: string}} ctx
   * @returns {string[]}
   */
  #productImageSrcs(productData, ctx) {
    /** @type {string[]} */
    const out = [];
    if (Array.isArray(productData?.images)) {
      for (const src of productData.images) {
        if (typeof src === 'string') out.push(src);
      }
    } else if (productData?.featured_image) {
      out.push(productData.featured_image);
    }
    if (out.length === 0 && ctx.image) out.push(ctx.image);
    return out;
  }

  /** @param {string} handle */
  async #getProductData(handle) {
    if (!handle) return null;
    if (this.#productCache.has(handle)) return this.#productCache.get(handle);
    try {
      const r = await fetch(`/products/${handle}.js`, { headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const data = await r.json();
      this.#productCache.set(handle, data);
      return data;
    } catch (_) {
      return null;
    }
  }

  /**
   * POST a single line to /cart/add.js and announce it on the standard cart
   * event, so the theme's cart-drawer (and bubble) refresh.
   *
   * The event goes out before the request, carrying the promise its listeners
   * await — that is what lets them shimmer immediately and settle on the real
   * cart once it lands.
   *
   * @param {number} variantId
   * @param {number} quantity
   */
  async #postCartAdd(variantId, quantity) {
    const sections = [];
    document.querySelectorAll('cart-items-component').forEach((el) => {
      if (el instanceof HTMLElement && el.dataset.sectionId) sections.push(el.dataset.sectionId);
    });

    const payload = {
      items: [{ id: variantId, quantity }],
      sections: sections.join(','),
    };

    const cfg = fetchConfig('javascript', { body: JSON.stringify(payload) });
    cfg.headers = { ...cfg.headers, 'Content-Type': 'application/json', Accept: 'application/json' };

    const deferred = CartLinesUpdateEvent.createPromise();

    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: [{ merchandiseId: String(variantId), quantity }],
        promise: deferred.promise,
      })
    );

    try {
      const res = await fetch(Theme.routes.cart_add_url, cfg);
      const data = await res.json();
      if (data.status && data.status !== 200) {
        throw new Error(data.message || 'cart/add failed');
      }

      const cart = await refreshCart();
      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          items: cart.items,
          source: 'build-a-box-modal',
          sourceId: this.id || 'build-a-box-modal',
          itemCount: quantity,
          productId: String(variantId),
          sections: data.sections,
          didError: false,
        },
      });

      return data;
    } catch (error) {
      // Leaving the promise pending would strand every listener mid-shimmer.
      deferred.reject(error);
      throw error;
    }
  }

  /**
   * Single-variant shortcut (no modal). Adds directly to the cart.
   *
   * @param {{form: HTMLFormElement | Element | null, ctx: {handle: string, productId: string, productTitle: string, image: string}}} args
   */
  async #addCurrentToCart({ form, ctx }) {
    const variantIdInput = /** @type {HTMLInputElement | null} */ (form?.querySelector?.('input[name="id"]'));
    let variantId = variantIdInput?.value || '';
    if (!variantId && ctx.handle) {
      const data = await this.#getProductData(ctx.handle);
      const v = data?.variants?.find((/** @type {any} */ x) => x.available) || data?.variants?.[0];
      if (v) variantId = String(v.id);
    }
    if (!variantId) return;
    try {
      await this.#postCartAdd(Number(variantId), 1);
      const drawer = /** @type {any} */ (document.querySelector('cart-drawer-component'));
      if (drawer?.showDialog) drawer.showDialog();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Add to cart failed', err);
    }
  }

  /**
   * Single-variant shortcut (no modal). Subscription-only — falls back to
   * opening the modal so the user can see the "no subscription plan" message
   * if the product has no selling plans.
   *
   * @param {{form: HTMLFormElement | Element | null, ctx: {handle: string, productId: string, productTitle: string, image: string}}} args
   */
  async #addCurrentToBundle({ form, ctx }) {
    if (BundleStore.items().length >= this.maxItems) return;

    const variantIdInput = /** @type {HTMLInputElement | null} */ (form?.querySelector?.('input[name="id"]'));
    let variantId = variantIdInput?.value || '';

    const data = ctx.handle ? await this.#getProductData(ctx.handle) : null;

    const plans = this.#flattenSellingPlans(data);
    if (plans.length === 0) {
      // No subscription plan → open the modal so the user sees the empty state.
      await this.openBundleModal(ctx, { form: null, button: 'choose', bundle: true });
      return;
    }
    const plan = plans[0];

    if (!variantId && data?.variants?.length) {
      const v = data.variants.find((/** @type {any} */ x) => x.available) || data.variants[0];
      variantId = String(v.id);
    }
    if (!variantId) return;

    const variant = data?.variants?.find((/** @type {any} */ v) => String(v.id) === String(variantId));

    BundleStore.add({
      variant_id: Number(variantId),
      selling_plan_id: plan.id,
      product_id: data?.id ? Number(data.id) : undefined,
      handle: ctx.handle,
      image: variant?.featured_image?.src || data?.featured_image || ctx.image,
      product_title: ctx.productTitle || data?.title || '',
      variant_title: variant?.title && variant.title !== 'Default Title' ? variant.title : '',
      plan_label: plan.label,
      price: variant?.price ?? data?.price ?? 0,
    });
  }
}

if (!customElements.get('build-a-box-section')) {
  customElements.define('build-a-box-section', BuildABoxSection);
}

/* ---------------------------------------------------------------------------
 * Bundle bar
 *
 * Floating bar pinned to the viewport bottom. Renders the current bundle state
 * (slots filled from cookie), provides per-slot remove buttons, and a CTA that
 * submits all items to the cart in a single bulk /cart/add.js call.
 *
 * @typedef {{ slots: HTMLElement, filledCount: HTMLElement, cta: HTMLButtonElement }} BundleBarRefs
 * @extends Component<BundleBarRefs>
 * --------------------------------------------------------------------------- */
class BundleBar extends Component {
  requiredRefs = ['slots', 'filledCount', 'cta'];

  /** @type {AbortController} */
  #ac = new AbortController();
  /** @type {ResizeObserver | null} */
  #ro = null;

  get maxItems() {
    return Number(this.dataset.maxItems) || 4;
  }
  get minItems() {
    return Number(this.dataset.minItems) || 4;
  }

  connectedCallback() {
    super.connectedCallback();
    const { signal } = this.#ac;
    document.addEventListener(STORE_EVENT, this.#render, { signal });
    this.addEventListener('click', this.#onClick, { signal });
    this.#render();

    this.#ro = new ResizeObserver(() => this.#syncSpacer());
    this.#ro.observe(this);
    this.#syncSpacer();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#ac.abort();
    this.#ro?.disconnect();
  }

  #syncSpacer() {
    const section = /** @type {HTMLElement | null} */ (this.closest('build-a-box-section'));
    if (!section) return;
    const h = this.hidden ? 0 : this.offsetHeight;
    section.style.setProperty('--bundle-bar-spacer', `${h}px`);
  }

  #render = () => {
    const items = BundleStore.items();
    const { slots, filledCount, cta } = this.refs;

    filledCount.textContent = String(items.length);

    const slotEls = slots.querySelectorAll('.bundle-bar__slot');
    slotEls.forEach((slot, i) => {
      const item = items[i];
      if (item) {
        slot.classList.add('bundle-bar__slot--filled');
        slot.classList.remove('bundle-bar__slot--empty');
        slot.innerHTML = `
          <img
            src="${escapeAttr(item.image || '')}"
            alt=""
            class="bundle-bar__slot-image"
            loading="lazy"
          />
          <div class="bundle-bar__slot-info">
            <span class="bundle-bar__slot-title">${escapeHtml(item.product_title || '')}</span>
            <span class="bundle-bar__slot-meta">
              ${escapeHtml(item.variant_title || '')}${item.variant_title && item.plan_label ? ' · ' : ''}${escapeHtml(item.plan_label || '')}
            </span>
          </div>
          <button
            type="button"
            class="bundle-bar__slot-remove"
            data-bundle-remove="${i}"
            aria-label="Remove from bundle"
          >&times;</button>
        `;
      } else {
        slot.classList.remove('bundle-bar__slot--filled');
        slot.classList.add('bundle-bar__slot--empty');
        slot.innerHTML = `
          <div class="bundle-bar__slot-placeholder">
            <span class="bundle-bar__plus" aria-hidden="true">+</span>
          </div>
        `;
      }
    });

    this.hidden = items.length === 0;
    cta.disabled = items.length < this.minItems;
    this.#syncSpacer();
  };

  /** @param {MouseEvent} event */
  #onClick = (event) => {
    const removeBtn = /** @type {HTMLElement | null} */ (
      /** @type {HTMLElement} */ (event.target).closest('[data-bundle-remove]')
    );
    if (!removeBtn) return;
    event.preventDefault();
    const idx = Number(removeBtn.getAttribute('data-bundle-remove'));
    if (!Number.isNaN(idx)) BundleStore.removeAt(idx);
  };

  async handleSubmit() {
    const items = BundleStore.items();
    if (items.length < this.minItems) return;

    const { cta } = this.refs;
    if (cta.dataset.busy === '1') return;
    cta.dataset.busy = '1';
    cta.disabled = true;

    const payload = {
      items: items.map((item) => {
        /** @type {Record<string, any>} */
        const line = { id: item.variant_id, quantity: 1 };
        if (item.selling_plan_id) line.selling_plan = item.selling_plan_id;
        return line;
      }),
      sections: this.#getCartSectionIds(),
    };

    const cfg = fetchConfig('javascript', { body: JSON.stringify(payload) });
    cfg.headers = { ...cfg.headers, 'Content-Type': 'application/json', Accept: 'application/json' };

    const totalCount = items.length;
    const deferred = CartLinesUpdateEvent.createPromise();

    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: items.map((item) => ({
          merchandiseId: String(item.variant_id),
          quantity: 1,
        })),
        promise: deferred.promise,
      })
    );

    try {
      const res = await fetch(Theme.routes.cart_add_url, cfg);
      const data = await res.json();
      if (data.status && data.status !== 200) {
        // eslint-disable-next-line no-console
        console.error('Bundle add failed:', data);
        deferred.reject(new Error(data.message || 'Bundle add failed'));
        return;
      }

      BundleStore.clear();

      const cart = await refreshCart();
      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          items: cart.items,
          source: 'bundle-bar',
          sourceId: this.id || 'bundle-bar',
          itemCount: totalCount,
          sections: data.sections,
          didError: false,
        },
      });

      const drawer = /** @type {any} */ (document.querySelector('cart-drawer-component'));
      if (drawer?.showDialog) drawer.showDialog();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Bundle add error', err);
      deferred.reject(err);
    } finally {
      delete cta.dataset.busy;
    }
  }

  /** @returns {string} */
  #getCartSectionIds() {
    const ids = [];
    document.querySelectorAll('cart-items-component').forEach((el) => {
      if (el instanceof HTMLElement && el.dataset.sectionId) ids.push(el.dataset.sectionId);
    });
    return ids.join(',');
  }
}

if (!customElements.get('bundle-bar')) {
  customElements.define('bundle-bar', BundleBar);
}

/* ---------------------------------------------------------------------------
 * Window-capture click interceptor
 *
 * Activation is opt-in per Quick-add block: the block's `Mode` setting
 * controls whether the wrapper carries `data-bundle-trigger="true"`. If the
 * click came from inside such a wrapper AND on a Choose/Add button, we:
 *
 *   - stopImmediatePropagation, so the framework's quick-add never fires
 *   - call the closest <build-a-box-section>'s openBundleModal directly,
 *     which opens the dialog itself with a loading skeleton and then renders
 *     the Figma layout once /products/{handle}.js resolves.
 *
 * Using `window` (not `document`) and `capture: true` guarantees we run
 * before any document-level capture listener regardless of registration
 * order — capture phase walks window → document → … → target.
 *
 * Falling back to ancestry-based detection (closest('build-a-box-section'))
 * was unreliable when product cards rendered with custom wrappers or shadow
 * roots; the explicit `data-bundle-trigger` opt-in is set by Liquid at render
 * time and is immune to those issues.
 * --------------------------------------------------------------------------- */

const INTERCEPTOR_KEY = '__buildABoxInterceptorInstalled';
if (!(/** @type {any} */ (window))[INTERCEPTOR_KEY]) {
  /** @type {any} */ (window)[INTERCEPTOR_KEY] = true;
  console.debug('[build-a-box] click interceptor installed');

  window.addEventListener(
    'click',
    (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const target = /** @type {Element | null} */ (
        path.find((n) => n instanceof Element) || (event.target instanceof Element ? event.target : null)
      );
      if (!target) return;

      // Mode resolution. The Quick-add block writes `data-bundle-trigger`
      // with one of: "bundle" (force), "normal" (force), or "auto"
      // (infer from ancestor build-a-box-section).
      const trigger = /** @type {HTMLElement | null} */ (target.closest('[data-bundle-trigger]'));

      const chooseBtn = target.closest('.quick-add__button--choose, [data-quick-add-button="choose"] button');
      const addBtn = target.closest('add-to-cart-component button, .quick-add__button--add');

      if (!trigger || (!chooseBtn && !addBtn)) return;

      const section = /** @type {BuildABoxSection | null} */ (target.closest('build-a-box-section'));

      const triggerMode = trigger.getAttribute('data-bundle-trigger');
      let useBundle;
      if (triggerMode === 'bundle') useBundle = true;
      else if (triggerMode === 'normal') useBundle = false;
      else useBundle = !!section; // "auto" — bundle when inside a bundle section

      console.debug('[build-a-box] click', {
        triggerMode,
        hasSection: !!section,
        useBundle,
        button: chooseBtn ? 'choose' : 'add',
      });

      const card = /** @type {HTMLElement | null} */ (target.closest('product-card, [data-build-a-box-card]'));
      const handleAnchor = /** @type {HTMLAnchorElement | null} */ (
        card?.querySelector('a[href*="/products/"]')
      );
      const image = /** @type {HTMLImageElement | null} */ (card?.querySelector('img'));
      const titleEl = card?.querySelector('[ref="productTitleLink"], .product-card__title, product-title');

      const href = handleAnchor?.getAttribute('href') || '';
      const handleMatch = href.match(/\/products\/([^/?#]+)/);
      const handle = handleMatch?.[1] || '';

      const variantInput = /** @type {HTMLInputElement | null} */ (card?.querySelector('input[name="id"]'));
      const productId = variantInput?.dataset.productId || card?.dataset.productId || '';

      const ctx = {
        handle,
        productId,
        productTitle: (titleEl?.textContent || '').trim(),
        image: image?.currentSrc || image?.src || '',
        // Read flavour notes straight off the trigger element — Liquid wrote
        // it there from `product.metafields.custom.card_flavor_notes`.
        flavorNotes: trigger.dataset.productFlavorNotes || '',
      };

      // Beat the framework: prevent the default popup from ever opening.
      event.preventDefault();
      event.stopImmediatePropagation();

      const button = chooseBtn ? 'choose' : 'add';
      const form = (chooseBtn || addBtn)?.closest('form') || null;
      const host = section || getOrCreateOrphanSection();
      host.openBundleModal(ctx, { form, button, bundle: useBundle });
    },
    { capture: true }
  );
}

/**
 * Provides a fallback BuildABoxSection-like host when a bundle-mode Quick-add
 * block is used outside of a <build-a-box-section>. Reuses BundleStore /
 * BundleBar state (both are global), so behaviour is identical.
 *
 * @returns {BuildABoxSection}
 */
let _orphanSection = /** @type {BuildABoxSection | null} */ (null);
function getOrCreateOrphanSection() {
  if (_orphanSection) return _orphanSection;
  const el = document.createElement('build-a-box-section');
  el.dataset.minItems = '4';
  el.dataset.maxItems = '4';
  el.style.display = 'none';
  document.body.appendChild(el);
  _orphanSection = /** @type {BuildABoxSection} */ (el);
  return _orphanSection;
}

/* ---------------------------------------------------------------------------
 * Utilities
 * --------------------------------------------------------------------------- */

/** @param {string} s */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

/** @param {string} s */
function escapeAttr(s) {
  return escapeHtml(s);
}

/**
 * Strip the Shopify CDN size suffix and query string from an image URL so a
 * variant's `featured_image.src` can be matched against the product images
 * list, which may use a different size.
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeImageUrl(url) {
  return String(url || '')
    .split('?')[0]
    .replace(/_(\d+x\d*|\d+x|x\d+|\d+)(?=\.[a-z]+$)/i, '');
}

/**
 * Format a Shopify price (integer cents) using the storefront's formatter when
 * available, otherwise a simple en-US currency fallback.
 *
 * @param {number} cents
 */
function formatMoney(cents) {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(document.documentElement.lang || 'en-US', {
      style: 'currency',
      currency: window.Shopify?.currency?.active || 'USD',
    }).format(amount);
  } catch (_) {
    return `$${amount.toFixed(2)}`;
  }
}

/* ---------------------------------------------------------------------------
 * Bundle modal styles (Figma)
 *
 * Inlined as a single style tag because the modal lives in the shared
 * <quick-add-dialog>, which sections cannot style with their own stylesheet.
 * Scoped to `[data-bundle-mode]` so non-bundle modal usage is untouched.
 * --------------------------------------------------------------------------- */

const STYLE_ID = 'bundle-modal-injected-styles';
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Bundle mode: blank out the existing modal grid so the bundle layout owns it. */
    [data-bundle-mode] .quick-add-modal__content {
      display: block;
      padding: 0;
      gap: 0;
      grid-template-columns: none;
      grid-template-rows: none;
    }
    [data-bundle-mode] dialog.quick-add-modal {
      width: 781px;
      max-width: 95vw;
      height: fit-content;
      max-height: 92vh;
    }

    .bab-modal {
      --bab-bg: var(--color-background-subdued, transparent);
      --bab-bg-media: var(--color-background, transparent);
      --bab-fg: var(--color-foreground, inherit);
      --bab-fg-onfill: var(--color-border, currentColor);
      --bab-accent: var(--color-link, currentColor);
      --bab-light-green: #C3BA98;
      --bab-muted: rgba(27, 27, 27, 0.6);
      --bab-border: var(--color-foreground, inherit);

      display: grid;
      grid-template-columns: 313px 1fr;
      gap: 24px;
      padding: 0 24px 0 0;
      background: var(--bab-bg);
      color: var(--bab-fg);
      font-family: var(--font-body--family, system-ui, sans-serif);
      box-sizing: border-box;
    }

    .bab-modal *,
    .bab-modal *::before,
    .bab-modal *::after {
      box-sizing: border-box;
    }

    .bab-modal__media {
      --bab-image-size: 313px;

      position: relative;
      background: var(--bab-bg-media);
      width: var(--bab-image-size);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    /*
      The actual scroll container. Sized to 1.5 images so one image is fully
      visible and the next image peeks below — signals there's more to scroll.
      'scroll-snap-stop: always' on each image keeps the user on one image
      at a time when they (or our auto-scroll) move between them.
    */
    .bab-modal__media-scroller {
      width: 100%;
      height: calc(var(--bab-image-size) * 1.5);
      overflow-y: auto;
      scroll-snap-type: y mandatory;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    .bab-modal__media-scroller::-webkit-scrollbar {
      display: none;
    }

    .bab-modal__image {
      width: var(--bab-image-size);
      height: var(--bab-image-size);
      object-fit: cover;
      flex-shrink: 0;
      display: block;
      scroll-snap-align: start;
      scroll-snap-stop: always;
    }

    .bab-modal__card-label {
      position: absolute;
      top: 10px;
      right: 10px;
      background: var(--bab-light-green);
      color: var(--bab-fg);
      font-size: 12px;
      line-height: 1;
      padding: 6px;
      letter-spacing: 0.04em;
      z-index: 2;
    }

    .bab-modal__info {
      display: flex;
      flex-direction: column;
      gap: 24px;
      align-items: center;
      padding: 24px 0;
      width: 424px;
      max-width: 100%;
      /* Allow internal scrolling when the description accordion is expanded,
         instead of growing the modal past the viewport. */
      max-height: 92vh;
      overflow-y: auto;
      scrollbar-width: thin;
    }

    .bab-modal__header {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
      width: 100%;
      text-align: center;
    }

    .bab-modal__title {
      font-family: var(--font-heading--family, system-ui, sans-serif);
      font-weight: 600;
      font-size: 24px;
      line-height: 1;
      letter-spacing: 0;
      text-transform: uppercase;
      color: var(--bab-fg);
      margin: 0;
    }

    .bab-modal__subtitle {
      font-size: 12px;
      line-height: 1;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin: 0;
      color: var(--bab-fg);
    }

    .bab-modal__variants {
      display: flex;
      flex-direction: column;
      gap: 16px;
      width: 100%;
    }

    .bab-modal__variant-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
    }

    .bab-modal__variant-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      line-height: 1;
      color: var(--bab-fg);
    }

    .bab-modal__variant-name {
      font-weight: 700;
    }

    .bab-modal__variant-value {
      font-weight: 400;
    }

    .bab-modal__variant-options {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .bab-modal__variant-btn {
      appearance: none;
      background: var(--bab-bg);
      border: 1.5px solid var(--bab-border);
      padding: 8px;
      font-size: 14px;
      line-height: 1;
      color: var(--bab-fg);
      cursor: pointer;
      font-family: inherit;
      transition: background-color 0.15s ease, color 0.15s ease;
      min-width: 60px;
    }

    .bab-modal__variant-btn[aria-pressed='true'] {
      background: var(--bab-fg);
      color: var(--color-background-subdued, transparent);
      border-color: var(--bab-fg);
    }

    .bab-modal__variant-btn:hover:not([aria-pressed='true']):not([aria-disabled]) {
      background: rgba(61, 58, 53, 0.06);
    }

    /* Unavailable variant value: strike through, mute, mirror the product-page
       picker behaviour (still clickable; selecting it disables the CTA). */
    .bab-modal__variant-btn[aria-disabled] {
      position: relative;
      opacity: 0.55;
      color: rgba(61, 58, 53, 0.7);
      cursor: not-allowed;
    }

    .bab-modal__variant-btn[aria-disabled]::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      border-top: 1px solid currentColor;
      transform: rotate(-12deg);
      pointer-events: none;
    }

    .bab-modal__frequency {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
    }

    .bab-modal__frequency-label {
      font-size: 14px;
      font-weight: 700;
      line-height: 1;
      margin: 0 0 4px;
    }

    .bab-modal__dropdown {
      position: relative;
      width: 100%;
    }

    .bab-modal__dropdown-trigger {
      appearance: none;
      width: 100%;
      background: var(--bab-bg);
      border: 1px solid var(--bab-border);
      height: 42px;
      padding: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: inherit;
      font-size: 14px;
      color: var(--bab-fg);
      cursor: pointer;
    }

    .bab-modal__dropdown-value {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .bab-modal__save-badge {
      background: var(--bab-accent);
      color: var(--color-background-subdued, transparent);
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      padding: 4px 6px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }

    .bab-modal__save-badge[hidden] {
      display: none !important;
    }

    .bab-modal__caret {
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }

    .bab-modal__dropdown[data-open='true'] .bab-modal__caret {
      transform: rotate(180deg);
    }

    .bab-modal__dropdown-list {
      display: none;
      position: absolute;
      top: calc(100% - 1px);
      left: 0;
      right: 0;
      background: var(--bab-bg);
      border: 1px solid var(--bab-border);
      z-index: 5;
      max-height: 240px;
      overflow-y: auto;
    }

    .bab-modal__dropdown[data-open='true'] .bab-modal__dropdown-list {
      display: block;
    }

    .bab-modal__plan-option {
      appearance: none;
      width: 100%;
      background: var(--bab-bg);
      border: 0;
      padding: 10px 12px;
      font-family: inherit;
      font-size: 14px;
      color: var(--bab-fg);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      text-align: left;
      border-bottom: 1px solid rgba(61, 58, 53, 0.08);
    }

    .bab-modal__plan-option:last-child {
      border-bottom: 0;
    }

    .bab-modal__plan-option:hover,
    .bab-modal__plan-option[aria-selected='true'] {
      background: rgba(61, 58, 53, 0.06);
    }

    .bab-modal__details {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: var(--bab-fg);
      text-decoration: none;
      cursor: default;
      pointer-events: none;
    }

    .bab-modal__no-plans {
      font-size: 14px;
      line-height: 1.4;
      color: var(--bab-muted);
      margin: 0;
    }

    /* Quantity stepper (normal mode) */
    .bab-modal__quantity {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
    }

    .bab-modal__quantity-label {
      font-size: 14px;
      font-weight: 700;
      line-height: 1;
      margin: 0 0 4px;
    }

    .bab-modal__qty-stepper {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid var(--bab-border);
      width: fit-content;
      height: 42px;
    }

    .bab-modal__qty-btn {
      appearance: none;
      background: transparent;
      border: 0;
      width: 42px;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      color: var(--bab-fg);
      font-family: inherit;
    }

    .bab-modal__qty-btn:hover {
      background: rgba(61, 58, 53, 0.06);
    }

    .bab-modal__qty-input {
      width: 56px;
      border: 0;
      border-left: 1px solid var(--bab-border);
      border-right: 1px solid var(--bab-border);
      background: var(--bab-bg);
      text-align: center;
      font-size: 14px;
      color: var(--bab-fg);
      font-family: inherit;
      appearance: textfield;
      -moz-appearance: textfield;
    }

    .bab-modal__qty-input::-webkit-inner-spin-button,
    .bab-modal__qty-input::-webkit-outer-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    /* Product details accordion (both modes) */
    .bab-modal__details-section {
      width: 100%;
      border-top: 1px solid rgba(61, 58, 53, 0.12);
      padding-top: 16px;
    }

    .bab-modal__details-toggle {
      appearance: none;
      background: transparent;
      border: 0;
      width: 100%;
      padding: 0 0 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--bab-fg);
      cursor: pointer;
    }

    .bab-modal__details-section[data-open='true'] .bab-modal__caret {
      transform: rotate(180deg);
    }

    .bab-modal__details-body {
      display: none;
      font-size: 14px;
      line-height: 1.5;
      color: var(--bab-fg);
      padding-block: 8px 4px;
    }

    .bab-modal__details-section[data-open='true'] .bab-modal__details-body {
      display: block;
    }

    .bab-modal__details-body p:first-child {
      margin-top: 0;
    }

    .bab-modal__details-body p:last-child {
      margin-bottom: 0;
    }

    .bab-modal__loading-spinner {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 2px solid rgba(61, 58, 53, 0.15);
      border-top-color: var(--bab-fg);
      animation: babSpin 0.8s linear infinite;
      margin: 24px auto;
    }

    @keyframes babSpin {
      to { transform: rotate(360deg); }
    }

    .bab-modal__footer {
      display: flex;
      flex-direction: column;
      gap: 16px;
      align-items: center;
      width: 100%;
    }

    .bab-modal__price-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
    }

    .bab-modal__price-label {
      font-size: 16px;
      font-weight: 700;
    }

    .bab-modal__price-values {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
    }

    .bab-modal__price-strike {
      font-size: 16px;
      color: var(--bab-muted);
      text-decoration: line-through;
    }

    .bab-modal__price-now {
      font-size: 18px;
      font-weight: 700;
      color: var(--color-foreground, inherit);
    }

    /* Primary CTA — used by .bab-modal__product-link by default; the buy
       button uses the .bab-modal__cta--secondary modifier to render as an
       outline button. */
    .bab-modal__cta,
    .bab-modal__product-link {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 51px;
      background: var(--bab-fg);
      color: var(--bab-fg-onfill);
      border: 1.5px solid var(--bab-fg);
      font-family: var(--font-body--family, sans-serif);
      font-weight: 700;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      cursor: pointer;
      text-decoration: none;
      box-sizing: border-box;
    }

    .bab-modal__cta:hover,
    .bab-modal__product-link:hover {
      filter: brightness(1.1);
      color: var(--bab-fg-onfill);
    }

    .bab-modal__cta:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Secondary modifier — used by the buy button now that "See all purchase
       options" owns the primary slot. */
    .bab-modal__cta--secondary {
      background: var(--bab-bg);
      color: var(--bab-fg);
    }

    .bab-modal__cta--secondary:hover {
      filter: none;
      background: rgba(61, 58, 53, 0.06);
      color: var(--bab-fg);
    }

    .bab-modal__cancel {
      appearance: none;
      background: transparent;
      border: 0;
      padding: 0;
      font-family: var(--font-body--family, sans-serif);
      font-weight: 700;
      font-size: 16px;
      color: var(--bab-fg);
      text-decoration: underline;
      text-underline-offset: 3px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      cursor: pointer;
      text-align: center;
      width: 100%;
    }

    .bab-modal__cancel:hover {
      color: var(--bab-fg);
    }

    @media screen and (max-width: 749px) {
      [data-bundle-mode] dialog.quick-add-modal {
        width: 100%;
        max-width: 100%;
        height: auto;
        max-height: 100vh;
      }

      .bab-modal {
        --bab-image-size: min(70vw, 313px);

        grid-template-columns: 1fr;
        padding: 0;
        gap: 0;
      }

      .bab-modal__media {
        width: 100%;
      }

      .bab-modal__media-scroller {
        width: 100%;
        height: var(--bab-image-size);
        display: flex;
        flex-direction: row;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x mandatory;
      }

      .bab-modal__image {
        width: 100%;
        height: var(--bab-image-size);
        flex-shrink: 0;
        scroll-snap-align: start;
      }

      .bab-modal__info {
        width: 100%;
        padding: 16px;
      }
    }
  `;
  document.head.appendChild(style);
}

export { BundleStore };
