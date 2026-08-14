if (!customElements.get('recent-purchase-popup')) {
  class RecentPurchasePopup extends HTMLElement {
    constructor() {
      super();

      this.products = [];
      this.fallbackCities = [];
      this.fallbackTimes = [];

      this.currentIndex = -1;
      this.impressionCount = 0;
      this.hideTimer = null;
      this.nextTimer = null;
      this.remainingTime = 0;
      this.hideStartedAt = 0;
      this.isPaused = false;
      this.dismissed = false;

      this.sessionKey = `sethi-purchase-popup-${this.dataset.sectionId}`;
    }

    connectedCallback() {
      this.cacheElements();
      this.readSettings();
      this.readData();

      if (!this.shouldInitialize()) {
        this.remove();
        return;
      }

      this.bindEvents();
      this.hidden = false;

      this.scheduleNext(this.initialDelay);
    }

    disconnectedCallback() {
      this.clearTimers();
    }

    cacheElements() {
      this.card = this.querySelector('.sethi-purchase-popup__card');
      this.link = this.querySelector('.sethi-purchase-popup__link');
      this.image = this.querySelector('.sethi-purchase-popup__image');
      this.cityElement = this.querySelector(
        '.sethi-purchase-popup__city'
      );
      this.timeElement = this.querySelector(
        '.sethi-purchase-popup__time'
      );
      this.titleElement = this.querySelector(
        '.sethi-purchase-popup__product-title'
      );
      this.closeButton = this.querySelector(
        '.sethi-purchase-popup__close'
      );
    }

    readSettings() {
      this.initialDelay = this.toNumber(
        this.dataset.initialDelay,
        6000
      );

      this.displayDuration = this.toNumber(
        this.dataset.displayDuration,
        7000
      );

      this.intervalMin = this.toNumber(
        this.dataset.intervalMin,
        20000
      );

      this.intervalMax = this.toNumber(
        this.dataset.intervalMax,
        40000
      );

      this.maxImpressions = this.toNumber(
        this.dataset.maxImpressions,
        6
      );

      this.mobileEnabled = this.dataset.mobileEnabled === 'true';
      this.pageRestriction =
        this.dataset.pageRestriction || 'shopping';

      this.style.setProperty(
        '--sethi-display-duration',
        `${this.displayDuration}ms`
      );
    }

    readData() {
      const dataElement = this.querySelector(
        '.sethi-purchase-popup__data'
      );

      if (!dataElement) return;

      try {
        const parsedData = JSON.parse(dataElement.textContent);

        this.products = Array.isArray(parsedData.products)
          ? parsedData.products.filter(
              (product) =>
                product &&
                product.title &&
                product.url &&
                product.image &&
                product.image.src
            )
          : [];

        this.fallbackCities = Array.isArray(
          parsedData.fallbackCities
        )
          ? parsedData.fallbackCities.filter(Boolean)
          : [];

        this.fallbackTimes = Array.isArray(
          parsedData.fallbackTimes
        )
          ? parsedData.fallbackTimes.filter(Boolean)
          : [];
      } catch (error) {
        console.warn(
          'Sethi recent purchase popup data could not be read.',
          error
        );
      }
    }

    shouldInitialize() {
      if (!this.products.length) return false;

      if (!this.mobileEnabled && window.innerWidth < 750) {
        return false;
      }

      if (!this.isAllowedPage()) {
        return false;
      }

      try {
        const savedSession = JSON.parse(
          sessionStorage.getItem(this.sessionKey) || '{}'
        );

        this.impressionCount = Number(
          savedSession.impressions || 0
        );

        this.dismissed = Boolean(savedSession.dismissed);
      } catch (error) {
        this.impressionCount = 0;
        this.dismissed = false;
      }

      return (
        !this.dismissed &&
        this.impressionCount < this.maxImpressions
      );
    }

    isAllowedPage() {
      const main = document.querySelector(
        'main[data-template]'
      );

      const template =
        main?.dataset.template ||
        document.body.dataset.template ||
        '';

      if (this.pageRestriction === 'all') {
        return true;
      }

      if (this.pageRestriction === 'home') {
        return (
          template === 'index' ||
          window.location.pathname === '/'
        );
      }

      if (this.pageRestriction === 'shopping') {
        return (
          template === 'index' ||
          template === 'collection' ||
          template === 'product' ||
          window.location.pathname === '/'
        );
      }

      return true;
    }

    bindEvents() {
      this.closeButton?.addEventListener('click', () => {
        this.dismiss();
      });

      this.card?.addEventListener('mouseenter', () => {
        this.pause();
      });

      this.card?.addEventListener('mouseleave', () => {
        this.resume();
      });

      this.card?.addEventListener('focusin', () => {
        this.pause();
      });

      this.card?.addEventListener('focusout', (event) => {
        if (!this.card.contains(event.relatedTarget)) {
          this.resume();
        }
      });

      document.addEventListener(
        'visibilitychange',
        this.handleVisibilityChange
      );

      document.addEventListener(
        'shopify:section:unload',
        this.handleSectionUnload
      );
    }

    handleVisibilityChange = () => {
      if (document.hidden) {
        this.pause();
      } else {
        this.resume();
      }
    };

    handleSectionUnload = (event) => {
      if (event.detail.sectionId === this.dataset.sectionId) {
        this.clearTimers();
      }
    };

    show() {
      if (
        this.dismissed ||
        this.impressionCount >= this.maxImpressions ||
        !this.products.length
      ) {
        return;
      }

      const product = this.getNextProduct();

      if (!product) return;

      this.populate(product);

      this.classList.remove('is-visible', 'is-paused');

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.classList.add('is-visible');
        });
      });

      this.impressionCount += 1;
      this.saveSession();

      this.remainingTime = this.displayDuration;
      this.startHideTimer(this.remainingTime);
    }

    hide({ scheduleNext = true } = {}) {
      this.classList.remove('is-visible', 'is-paused');
      this.isPaused = false;

      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;

      if (
        scheduleNext &&
        !this.dismissed &&
        this.impressionCount < this.maxImpressions
      ) {
        const nextDelay = this.randomNumber(
          this.intervalMin,
          this.intervalMax
        );

        this.scheduleNext(nextDelay);
      }
    }

    dismiss() {
      this.dismissed = true;
      this.saveSession();
      this.clearTimers();
      this.hide({ scheduleNext: false });
    }

    pause() {
      if (
        this.isPaused ||
        !this.classList.contains('is-visible') ||
        !this.hideTimer
      ) {
        return;
      }

      const elapsed = Date.now() - this.hideStartedAt;

      this.remainingTime = Math.max(
        0,
        this.remainingTime - elapsed
      );

      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
      this.isPaused = true;

      this.classList.add('is-paused');
    }

    resume() {
      if (
        !this.isPaused ||
        !this.classList.contains('is-visible')
      ) {
        return;
      }

      this.isPaused = false;
      this.classList.remove('is-paused');

      if (this.remainingTime <= 0) {
        this.hide();
        return;
      }

      this.startHideTimer(this.remainingTime);
    }

    startHideTimer(duration) {
      this.hideStartedAt = Date.now();

      this.hideTimer = window.setTimeout(() => {
        this.hide();
      }, duration);
    }

    scheduleNext(delay) {
      window.clearTimeout(this.nextTimer);

      this.nextTimer = window.setTimeout(() => {
        this.show();
      }, delay);
    }

    populate(product) {
      const city =
        product.city || this.randomItem(this.fallbackCities);

      const time =
        product.time || this.randomItem(this.fallbackTimes);

      const displayTitle =
        product.customLabel || product.title;

      this.link.href = product.url;
      this.link.setAttribute(
        'aria-label',
        `View ${displayTitle}`
      );

      this.image.src = product.image.src;
      this.image.alt =
        product.image.alt || displayTitle;

      this.titleElement.textContent = displayTitle;
      this.cityElement.textContent = city || 'Delhi';
      this.timeElement.textContent =
        time || 'A few minutes ago';
    }

    getNextProduct() {
      if (this.products.length === 1) {
        this.currentIndex = 0;
        return this.products[0];
      }

      let nextIndex = this.currentIndex;

      while (nextIndex === this.currentIndex) {
        nextIndex = Math.floor(
          Math.random() * this.products.length
        );
      }

      this.currentIndex = nextIndex;

      return this.products[nextIndex];
    }

    randomItem(items) {
      if (!Array.isArray(items) || !items.length) {
        return '';
      }

      return items[
        Math.floor(Math.random() * items.length)
      ];
    }

    randomNumber(min, max) {
      const safeMin = Math.min(min, max);
      const safeMax = Math.max(min, max);

      return Math.floor(
        Math.random() * (safeMax - safeMin + 1) +
          safeMin
      );
    }

    toNumber(value, fallback) {
      const parsedValue = Number(value);

      return Number.isFinite(parsedValue)
        ? parsedValue
        : fallback;
    }

    saveSession() {
      try {
        sessionStorage.setItem(
          this.sessionKey,
          JSON.stringify({
            impressions: this.impressionCount,
            dismissed: this.dismissed
          })
        );
      } catch (error) {
        // Popup still works when sessionStorage is unavailable.
      }
    }

    clearTimers() {
      window.clearTimeout(this.hideTimer);
      window.clearTimeout(this.nextTimer);

      this.hideTimer = null;
      this.nextTimer = null;
    }
  }

  customElements.define(
    'recent-purchase-popup',
    RecentPurchasePopup
  );
}