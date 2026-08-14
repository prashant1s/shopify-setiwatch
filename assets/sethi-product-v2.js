class SethiV2 {
  constructor(root) {
    this.root = root;

    this.variants = this.parseJSON('[data-variants-json]', []);

    this.currentVariant =
      this.variants.find(
        (variant) =>
          String(variant.id) ===
          String(this.query('[data-variant-id]')?.value)
      ) || this.variants[0];

    this.galleryMedia = [
      ...this.queryAll('[data-gallery-media]')
    ];

    this.galleryThumbnails = [
      ...this.queryAll('[data-gallery-thumb]')
    ];

    this.activeMediaIndex = Math.max(
      0,
      this.galleryMedia.findIndex((media) => !media.hidden)
    );

    this.bindEvents();
    this.updateGalleryCounter();
    this.loadRecommendations();
    this.initializeStickyBar();
    this.updateBundleTotal();
    this.restoreSavedPincode();
    this.initializeGalleryGestures();
    this.initializeCardWishlists();
    this.initializeAccordionBehaviour();

    const mainWishlistButton = this.query('[data-wishlist]');

    if (mainWishlistButton) {
      this.updateWishlistButton(
        mainWishlistButton,
        this.readWishlist().includes(
          String(this.root.dataset.productId || '')
        )
      );
    }
  }

  query(selector) {
    return this.root.querySelector(selector);
  }

  queryAll(selector) {
    return this.root.querySelectorAll(selector);
  }

  parseJSON(selector, fallback) {
    try {
      return JSON.parse(
        this.query(selector)?.textContent || ''
      );
    } catch (error) {
      console.warn(`Unable to parse ${selector}`, error);
      return fallback;
    }
  }

  bindEvents() {
    this.galleryThumbnails.forEach((button) => {
      button.addEventListener('click', () => {
        this.showMedia(button.dataset.galleryThumb);
      });
    });

    this.query('[data-gallery-prev]')?.addEventListener(
      'click',
      () => {
        this.changeMedia(-1);
      }
    );

    this.query('[data-gallery-next]')?.addEventListener(
      'click',
      () => {
        this.changeMedia(1);
      }
    );

    this.queryAll('[data-open-lightbox]').forEach((button) => {
      button.addEventListener('click', () => {
        this.openLightbox();
      });
    });

    this.queryAll('[data-option-input]').forEach((input) => {
      input.addEventListener('change', () => {
        this.changeVariant();
      });
    });

    this.query('[data-product-form]')?.addEventListener(
      'submit',
      (event) => {
        this.addCurrentProduct(event, false);
      }
    );

    this.query('[data-buy-now]')?.addEventListener(
      'click',
      () => {
        this.addCurrentProduct(null, true);
      }
    );

    this.query('[data-sticky-cart]')?.addEventListener(
      'click',
      () => {
        const stickyButton = this.query('[data-sticky-cart]');

        if (stickyButton?.dataset.action === 'enquiry') {
          this.query('[data-enquiry]')?.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
          });

          return;
        }

        this.addCurrentProduct();
      }
    );

    this.query('[data-check-pincode]')?.addEventListener(
      'click',
      () => {
        this.checkPincode();
      }
    );

    this.query('[data-pincode]')?.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.checkPincode();
        }
      }
    );

    this.query('[data-submit-enquiry]')?.addEventListener(
      'click',
      () => {
        this.submitEnquiry(false);
      }
    );

    this.query('[data-notify-me]')?.addEventListener(
      'click',
      () => {
        this.submitEnquiry(true);
      }
    );

    this.queryAll('[data-open-dialog]').forEach((button) => {
      button.addEventListener('click', () => {
        this.openDialog(button.dataset.openDialog);
      });
    });

    this.queryAll('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => {
        button.closest('dialog')?.close();
      });
    });

    this.queryAll('dialog').forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) {
          dialog.close();
        }
      });
    });

    this.queryAll('[data-open-360]').forEach((button) => {
      button.addEventListener('click', () => {
        this.openDialog('360');
        this.initialize360Viewer();
      });
    });

    this.queryAll('[data-open-3d]').forEach((button) => {
      button.addEventListener('click', () => {
        const model = this.query('[data-media-type="model"]');

        if (!model) return;

        this.showMedia(model.dataset.galleryMedia);

        model.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      });
    });

    this.query('[data-wishlist]')?.addEventListener(
      'click',
      (event) => {
        this.toggleWishlist(event.currentTarget);
      }
    );

    this.queryAll('[data-bundle-checkbox]').forEach(
      (checkbox) => {
        checkbox.addEventListener('change', () => {
          this.updateBundleTotal();
        });
      }
    );

    this.query('[data-add-bundle]')?.addEventListener(
      'click',
      () => {
        this.addBundle();
      }
    );

    this.query('[data-scroll-reviews]')?.addEventListener(
      'click',
      () => {
        this.query('[data-reviews]')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      }
    );

    this.query('[data-open-reservation]')?.addEventListener(
      'click',
      () => {
        this.openDialog('reservation');
      }
    );

    this.query('[data-pay-reservation]')?.addEventListener(
      'click',
      () => {
        this.reserveTimepiece();
      }
    );

    this.root.addEventListener('keydown', (event) => {
      const activeElement = document.activeElement;

      const isTyping =
        activeElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(
          activeElement.tagName
        );

      if (isTyping) return;

      if (event.key === 'ArrowLeft') {
        this.changeMedia(-1);
      }

      if (event.key === 'ArrowRight') {
        this.changeMedia(1);
      }

      if (event.key === 'Escape') {
        this.queryAll('dialog[open]').forEach((dialog) => {
          dialog.close();
        });
      }
    });
  }

  initializeGalleryGestures() {
    const stage = this.query('.sethi-v2-gallery__stage');

    if (!stage || this.galleryMedia.length < 2) return;

    let pointerStartX = null;
    let pointerStartY = null;

    stage.addEventListener(
      'pointerdown',
      (event) => {
        if (
          event.target.closest(
            'button, a, video, model-viewer, iframe, input, select'
          )
        ) {
          return;
        }

        pointerStartX = event.clientX;
        pointerStartY = event.clientY;
      },
      { passive: true }
    );

    stage.addEventListener(
      'pointerup',
      (event) => {
        if (
          pointerStartX === null ||
          pointerStartY === null
        ) {
          return;
        }

        const differenceX =
          event.clientX - pointerStartX;

        const differenceY =
          event.clientY - pointerStartY;

        pointerStartX = null;
        pointerStartY = null;

        if (
          Math.abs(differenceX) < 45 ||
          Math.abs(differenceX) <= Math.abs(differenceY)
        ) {
          return;
        }

        this.changeMedia(
          differenceX < 0 ? 1 : -1
        );
      },
      { passive: true }
    );
  }

  restoreSavedPincode() {
    const input = this.query('[data-pincode]');

    if (!input || input.value) return;

    try {
      const savedPincode =
        localStorage.getItem(
          'sethi_delivery_pincode'
        );

      if (
        /^[1-9][0-9]{5}$/.test(
          savedPincode || ''
        )
      ) {
        input.value = savedPincode;
      }
    } catch (error) {
      console.warn(
        'Unable to restore saved pincode.',
        error
      );
    }
  }

  initializeAccordionBehaviour() {
    const groups = [
      ...this.queryAll(
        '.sethi-v2-accordions, .sethi-v2-faq'
      )
    ];

    groups.forEach((group) => {
      group.addEventListener('toggle', (event) => {
        const openedItem = event.target;

        if (
          !(
            openedItem instanceof
            HTMLDetailsElement
          ) ||
          !openedItem.open
        ) {
          return;
        }

        group
          .querySelectorAll('details[open]')
          .forEach((item) => {
            if (item !== openedItem) {
              item.removeAttribute('open');
            }
          });
      });
    });
  }
    initializeCardWishlists() {
    this.root.addEventListener('click', (event) => {
      const button = event.target.closest(
        '[data-card-wishlist]'
      );

      if (
        !button ||
        !this.root.contains(button)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const productId = String(
        button.dataset.cardWishlist || ''
      );

      if (!productId) return;

      const wishlist = this.readWishlist();

      const isAdded =
        wishlist.includes(productId);

      const updatedWishlist = isAdded
        ? wishlist.filter(
            (id) => id !== productId
          )
        : [...wishlist, productId];

      this.writeWishlist(updatedWishlist);

      this.updateWishlistButton(
        button,
        !isAdded
      );
    });

    const wishlist = this.readWishlist();

    this.queryAll(
      '[data-card-wishlist]'
    ).forEach((button) => {
      this.updateWishlistButton(
        button,
        wishlist.includes(
          String(
            button.dataset.cardWishlist
          )
        )
      );
    });
  }

  readWishlist() {
    try {
      const value = JSON.parse(
        localStorage.getItem(
          'sethi_wishlist'
        ) || '[]'
      );

      return Array.isArray(value)
        ? value.map(String)
        : [];
    } catch (error) {
      return [];
    }
  }

  writeWishlist(wishlist) {
    try {
      const uniqueWishlist = [
        ...new Set(
          wishlist.map(String)
        )
      ];

      localStorage.setItem(
        'sethi_wishlist',
        JSON.stringify(
          uniqueWishlist
        )
      );
    } catch (error) {
      console.warn(
        'Unable to update wishlist.',
        error
      );
    }
  }

  updateWishlistButton(
    button,
    isAdded
  ) {
    if (!button) return;

    button.textContent =
      isAdded ? '♥' : '♡';

    button.classList.toggle(
      'is-active',
      isAdded
    );

    button.setAttribute(
      'aria-pressed',
      String(isAdded)
    );
  }

  showMedia(mediaId) {
    const index =
      this.galleryMedia.findIndex(
        (media) =>
          String(
            media.dataset.galleryMedia
          ) === String(mediaId)
      );

    if (index < 0) return;

    this.activeMediaIndex = index;

    this.galleryMedia.forEach(
      (media, mediaIndex) => {
        const isActive =
          mediaIndex === index;

        media.hidden = !isActive;

        media.classList.toggle(
          'is-active',
          isActive
        );

        if (!isActive) {
          media
            .querySelectorAll('video')
            .forEach((video) => {
              video.pause();
            });
        }
      }
    );

    this.galleryThumbnails.forEach(
      (thumbnail) => {
        const isActive =
          String(
            thumbnail.dataset.galleryThumb
          ) === String(mediaId);

        thumbnail.classList.toggle(
          'is-active',
          isActive
        );

        thumbnail.setAttribute(
          'aria-current',
          isActive
            ? 'true'
            : 'false'
        );
      }
    );

    this.updateGalleryCounter();
  }

  changeMedia(direction) {
    if (!this.galleryMedia.length) {
      return;
    }

    this.activeMediaIndex =
      (
        this.activeMediaIndex +
        direction +
        this.galleryMedia.length
      ) %
      this.galleryMedia.length;

    const activeMedia =
      this.galleryMedia[
        this.activeMediaIndex
      ];

    this.showMedia(
      activeMedia.dataset.galleryMedia
    );
  }

  updateGalleryCounter() {
    const counter = this.query(
      '[data-gallery-current]'
    );

    if (counter) {
      counter.textContent = String(
        this.activeMediaIndex + 1
      );
    }
  }

  openLightbox() {
    const activeMedia =
      this.galleryMedia[
        this.activeMediaIndex
      ];

    const image =
      activeMedia?.querySelector('img');

    const dialog = this.query(
      '[data-dialog="lightbox"]'
    );

    const content = this.query(
      '[data-lightbox-content]'
    );

    if (
      !image ||
      !dialog ||
      !content
    ) {
      return;
    }

    const clonedImage =
      image.cloneNode(true);

    clonedImage.src =
      image.currentSrc ||
      image.src;

    clonedImage.removeAttribute(
      'loading'
    );

    clonedImage.setAttribute(
      'decoding',
      'async'
    );

    content.replaceChildren(
      clonedImage
    );

    this.openDialog('lightbox');
  }

  getSelectedOptions() {
    return [
      ...this.queryAll(
        '[data-option-input]:checked'
      )
    ]
      .sort(
        (first, second) =>
          Number(
            first.dataset.optionPosition
          ) -
          Number(
            second.dataset.optionPosition
          )
      )
      .map(
        (input) => input.value
      );
  }

  changeVariant() {
    const selectedOptions =
      this.getSelectedOptions();

    const variant =
      this.variants.find((item) =>
        item.options.every(
          (option, index) =>
            option ===
            selectedOptions[index]
        )
      );

    if (!variant) return;

    this.currentVariant = variant;

    const variantInput =
      this.query(
        '[data-variant-id]'
      );

    if (variantInput) {
      variantInput.value =
        variant.id;
    }

    this.queryAll(
      '[data-option-input]:checked'
    ).forEach((input) => {
      const label = this.query(
        `[data-option-label="${input.dataset.optionPosition}"]`
      );

      if (label) {
        label.textContent =
          input.value;
      }
    });

    this.updateVariantUI(
      variant
    );

    if (
      variant.featured_media?.id
    ) {
      this.showMedia(
        variant.featured_media.id
      );
    }

    const url = new URL(
      window.location.href
    );

    url.searchParams.set(
      'variant',
      variant.id
    );

    window.history.replaceState(
      {},
      '',
      url.toString()
    );
  }

  updateVariantUI(variant) {
    const formattedPrice =
      this.formatMoney(
        variant.price
      );

    const priceElement =
      this.query(
        '[data-product-price]'
      );

    const stickyPrice =
      this.query(
        '[data-sticky-price]'
      );

    if (priceElement) {
      priceElement.textContent =
        formattedPrice;
    }

    if (stickyPrice) {
      stickyPrice.textContent =
        formattedPrice;
    }

    const comparePrice =
      this.query(
        '[data-compare-price]'
      );

    const discount =
      this.query(
        '[data-discount]'
      );

    const savingElement =
      this.query(
        '.sethi-v2-price__saving'
      );

    const isOnSale =
      Number(
        variant.compare_at_price
      ) >
      Number(
        variant.price
      );

    if (comparePrice) {
      comparePrice.hidden =
        !isOnSale;

      if (isOnSale) {
        comparePrice.textContent =
          this.formatMoney(
            variant.compare_at_price
          );
      }
    }

    if (discount) {
      discount.hidden =
        !isOnSale;

      if (isOnSale) {
        const percentage =
          Math.round(
            (
              (
                variant.compare_at_price -
                variant.price
              ) /
              variant.compare_at_price
            ) *
            100
          );

        discount.textContent =
          `Save ${percentage}%`;
      }
    }

    if (savingElement) {
      savingElement.hidden =
        !isOnSale;

      if (isOnSale) {
        const saving =
          Number(
            variant.compare_at_price
          ) -
          Number(
            variant.price
          );

        savingElement.textContent =
          `You save ${this.formatMoney(
            saving
          )}`;
      }
    }

    const sku = this.query(
      '[data-product-sku]'
    );

    if (sku) {
      sku.textContent =
        variant.sku
          ? `Model No. ${variant.sku}`
          : '';
    }

    const isAvailable =
      Boolean(
        variant.available
      );

    const purchaseActions =
      this.query(
        '[data-purchase-actions]'
      );

    const enquiry =
      this.query(
        '[data-enquiry]'
      );

    const stock =
      this.query(
        '[data-stock]'
      );

    const stockTitle =
      this.query(
        '[data-stock-title]'
      );

    const stockMessage =
      this.query(
        '[data-stock-message]'
      );

    const stickyButton =
      this.query(
        '[data-sticky-cart]'
      );

    if (purchaseActions) {
      purchaseActions.hidden =
        !isAvailable;
    }

    if (enquiry) {
      enquiry.hidden =
        isAvailable;
    }

    stock?.classList.toggle(
      'is-out',
      !isAvailable
    );

    if (stockTitle) {
      stockTitle.textContent =
        isAvailable
          ? 'In stock'
          : 'Currently unavailable';
    }

    if (stockMessage) {
      stockMessage.textContent =
        isAvailable
          ? 'Ready for dispatch'
          : 'Enquire for availability';
    }

    if (stickyButton) {
      stickyButton.dataset.action =
        isAvailable
          ? 'cart'
          : 'enquiry';

      stickyButton.textContent =
        isAvailable
          ? 'Add to cart'
          : 'Enquire now';
    }

    this.updateBundleTotal();
  }
    formatMoney(cents) {
    const amount = Number(cents || 0);

    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency:
        window.Shopify?.currency?.active ||
        'INR',
      maximumFractionDigits: 0
    }).format(amount / 100);
  }

  async addCartItems(items) {
    const response = await fetch(
      `${window.Shopify.routes.root}cart/add.js`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
          Accept:
            'application/json'
        },
        body: JSON.stringify({
          items
        })
      }
    );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.description ||
        data.message ||
        'Unable to add item.'
      );
    }

    return data;
  }

  async addCurrentProduct(
    event = null,
    goToCheckout = false
  ) {
    event?.preventDefault();

    if (
      !this.currentVariant ||
      !this.currentVariant.available
    ) {
      return;
    }

    const addButton =
      this.query(
        '[data-add-cart]'
      );

    const addButtonText =
      this.query(
        '[data-add-cart-text]'
      );

    const buyNowButton =
      this.query(
        '[data-buy-now]'
      );

    try {
      if (addButton) {
        addButton.disabled = true;
        addButton.setAttribute(
          'aria-busy',
          'true'
        );
      }

      if (buyNowButton) {
        buyNowButton.disabled = true;
      }

      if (addButtonText) {
        addButtonText.textContent =
          goToCheckout
            ? 'Processing…'
            : 'Adding…';
      }

      await this.addCartItems([
        {
          id:
            this.currentVariant.id,
          quantity: 1
        }
      ]);

      if (goToCheckout) {
        window.location.href =
          `${window.Shopify.routes.root}checkout`;

        return;
      }

      if (addButtonText) {
        addButtonText.textContent =
          'Added ✓';
      }

      document.dispatchEvent(
        new CustomEvent(
          'cart:refresh',
          {
            bubbles: true
          }
        )
      );

      document.dispatchEvent(
        new CustomEvent(
          'cart:updated',
          {
            bubbles: true
          }
        )
      );

      setTimeout(() => {
        if (addButtonText) {
          addButtonText.textContent =
            'Add to cart';
        }

        if (addButton) {
          addButton.disabled = false;

          addButton.removeAttribute(
            'aria-busy'
          );
        }

        if (buyNowButton) {
          buyNowButton.disabled = false;
        }
      }, 1500);
    } catch (error) {
      if (addButtonText) {
        addButtonText.textContent =
          error.message ||
          'Try again';
      }

      if (addButton) {
        addButton.disabled = false;

        addButton.removeAttribute(
          'aria-busy'
        );
      }

      if (buyNowButton) {
        buyNowButton.disabled = false;
      }

      setTimeout(() => {
        if (addButtonText) {
          addButtonText.textContent =
            'Add to cart';
        }
      }, 2500);
    }
  }

  checkPincode() {
    const input =
      this.query(
        '[data-pincode]'
      );

    const result =
      this.query(
        '[data-delivery-result]'
      );

    const pincode =
      input?.value.trim() || '';

    if (!result) return;

    result.hidden = false;

    result.classList.remove(
      'is-error'
    );

    result.classList.remove(
      'is-success'
    );

    if (
      !/^[1-9][0-9]{5}$/.test(
        pincode
      )
    ) {
      result.classList.add(
        'is-error'
      );

      result.textContent =
        'Enter a valid 6-digit pincode.';

      input?.setAttribute(
        'aria-invalid',
        'true'
      );

      return;
    }

    input?.removeAttribute(
      'aria-invalid'
    );

    try {
      localStorage.setItem(
        'sethi_delivery_pincode',
        pincode
      );
    } catch (error) {
      console.warn(
        'Unable to save pincode.',
        error
      );
    }

    const deliveryDate =
      new Date();

    const firstDigit =
      Number(
        pincode.charAt(0)
      );

    const deliveryDays =
      [1, 2].includes(
        firstDigit
      )
        ? 2
        : 4;

    deliveryDate.setDate(
      deliveryDate.getDate() +
      deliveryDays
    );

    const formattedDate =
      deliveryDate.toLocaleDateString(
        'en-IN',
        {
          weekday: 'short',
          day: 'numeric',
          month: 'short'
        }
      );

    result.classList.add(
      'is-success'
    );

    result.innerHTML = `
      <strong>
        Delivery by ${formattedDate}
      </strong>

      <span>
        Free insured shipping available.
      </span>
    `;
  }

  submitEnquiry(
    notificationOnly
  ) {
    const nameInput =
      this.query(
        '[data-enquiry-name]'
      );

    const phoneInput =
      this.query(
        '[data-enquiry-phone]'
      );

    const message =
      this.query(
        '[data-enquiry-message]'
      );

    const name =
      nameInput?.value.trim() ||
      '';

    const phone =
      phoneInput?.value.trim() ||
      '';

    if (
      !name ||
      !/^[6-9][0-9]{9}$/.test(
        phone
      )
    ) {
      if (message) {
        message.textContent =
          'Enter your name and a valid 10-digit phone number.';
      }

      nameInput?.classList.toggle(
        'is-error',
        !name
      );

      phoneInput?.classList.toggle(
        'is-error',
        !/^[6-9][0-9]{9}$/.test(
          phone
        )
      );

      return;
    }

    nameInput?.classList.remove(
      'is-error'
    );

    phoneInput?.classList.remove(
      'is-error'
    );

    const productName =
      document.querySelector(
        '.sethi-v2-buybox h1'
      )?.textContent.trim() ||
      document.title;

    const productSku =
      this.query(
        '[data-product-sku]'
      )?.textContent.trim() ||
      '';

    const enquiryText = [
      notificationOnly
        ? 'Back-in-stock request'
        : 'Product enquiry',
      '',
      `Product: ${productName}`,
      productSku
        ? productSku
        : '',
      `Variant: ${
        this.currentVariant?.title ||
        'Default'
      }`,
      `Name: ${name}`,
      `Phone: ${phone}`,
      `Page: ${window.location.href}`
    ]
      .filter(Boolean)
      .join('\n');

    this.openWhatsApp(
      enquiryText
    );

    if (message) {
      message.textContent =
        notificationOnly
          ? 'Back-in-stock request is ready on WhatsApp.'
          : 'Your enquiry is ready on WhatsApp.';
    }
  }

  openWhatsApp(text) {
    const number =
      String(
        this.root.dataset.whatsapp ||
        ''
      ).replace(/\D/g, '');

    if (!number) {
      console.warn(
        'WhatsApp number is missing.'
      );

      return;
    }

    const url =
      `https://wa.me/${number}` +
      `?text=${encodeURIComponent(
        text
      )}`;

    window.open(
      url,
      '_blank',
      'noopener,noreferrer'
    );
  }

  openDialog(name) {
    const dialog =
      this.query(
        `[data-dialog="${name}"]`
      );

    if (!dialog) return;

    if (
      typeof dialog.showModal ===
      'function'
    ) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      dialog.setAttribute(
        'open',
        ''
      );
    }

    const closeButton =
      dialog.querySelector(
        '[data-close-dialog]'
      );

    requestAnimationFrame(() => {
      closeButton?.focus();
    });
  }

  toggleWishlist(button) {
    const productId =
      String(
        this.root.dataset.productId ||
        ''
      );

    if (!productId) return;

    const wishlist =
      this.readWishlist();

    const isAdded =
      wishlist.includes(
        productId
      );

    const updatedWishlist =
      isAdded
        ? wishlist.filter(
            (id) =>
              id !== productId
          )
        : [
            ...wishlist,
            productId
          ];

    this.writeWishlist(
      updatedWishlist
    );

    this.updateWishlistButton(
      button,
      !isAdded
    );
  }
    updateBundleTotal() {
    if (!this.currentVariant) return;

    const selectedCheckboxes = [
      ...this.queryAll(
        '[data-bundle-checkbox]:checked'
      )
    ];

    const accessoriesTotal =
      selectedCheckboxes.reduce(
        (total, checkbox) => {
          const productCard =
            checkbox.closest(
              '[data-bundle-item]'
            );

          const itemPrice =
            Number(
              productCard?.dataset.price ||
              0
            );

          return total + itemPrice;
        },
        0
      );

    const total =
      Number(
        this.currentVariant.price ||
        0
      ) +
      accessoriesTotal;

    const totalElement =
      this.query(
        '[data-bundle-total]'
      );

    const countElement =
      this.query(
        '[data-bundle-count]'
      );

    const addBundleButton =
      this.query(
        '[data-add-bundle]'
      );

    if (totalElement) {
      totalElement.textContent =
        this.formatMoney(total);
    }

    if (countElement) {
      countElement.textContent =
        String(
          1 +
          selectedCheckboxes.length
        );
    }

    if (addBundleButton) {
      addBundleButton.disabled =
        !this.currentVariant.available;

      addBundleButton.textContent =
        selectedCheckboxes.length > 0
          ? `Add ${selectedCheckboxes.length + 1} items`
          : 'Add selected bundle';
    }
  }

  async addBundle() {
    if (
      !this.currentVariant ||
      !this.currentVariant.available
    ) {
      return;
    }

    const message =
      this.query(
        '[data-bundle-message]'
      );

    const button =
      this.query(
        '[data-add-bundle]'
      );

    const selectedItems = [
      {
        id:
          this.currentVariant.id,
        quantity: 1
      },
      ...[
        ...this.queryAll(
          '[data-bundle-checkbox]:checked'
        )
      ].map((checkbox) => ({
        id:
          Number(
            checkbox.value
          ),
        quantity: 1
      }))
    ];

    try {
      if (button) {
        button.disabled = true;
        button.textContent =
          'Adding bundle…';
      }

      if (message) {
        message.textContent = '';
        message.classList.remove(
          'is-error',
          'is-success'
        );
      }

      await this.addCartItems(
        selectedItems
      );

      if (message) {
        message.textContent =
          `${selectedItems.length} items added to cart.`;

        message.classList.add(
          'is-success'
        );
      }

      if (button) {
        button.textContent =
          'Bundle added ✓';
      }

      document.dispatchEvent(
        new CustomEvent(
          'cart:refresh',
          {
            bubbles: true
          }
        )
      );

      document.dispatchEvent(
        new CustomEvent(
          'cart:updated',
          {
            bubbles: true
          }
        )
      );

      setTimeout(() => {
        if (button) {
          button.disabled = false;

          button.textContent =
            selectedItems.length > 1
              ? `Add ${selectedItems.length} items`
              : 'Add selected bundle';
        }
      }, 1600);
    } catch (error) {
      if (message) {
        message.textContent =
          error.message ||
          'Unable to add bundle.';

        message.classList.add(
          'is-error'
        );
      }

      if (button) {
        button.disabled = false;
        button.textContent =
          'Add selected bundle';
      }
    }
  }

  initializeStickyBar() {
    const stickyBar =
      this.query(
        '[data-sticky-bar]'
      );

    const hero =
      this.query(
        '.sethi-v2__hero'
      );

    if (
      !stickyBar ||
      !hero
    ) {
      return;
    }

    const observer =
      new IntersectionObserver(
        ([entry]) => {
          const shouldShow =
            !entry.isIntersecting &&
            window.scrollY > 250;

          stickyBar.classList.toggle(
            'is-visible',
            shouldShow
          );

          stickyBar.setAttribute(
            'aria-hidden',
            String(!shouldShow)
          );
        },
        {
          threshold: 0.08,
          rootMargin:
            '-80px 0px 0px 0px'
        }
      );

    observer.observe(hero);

    window.addEventListener(
      'resize',
      () => {
        if (
          window.innerWidth < 750
        ) {
          stickyBar.classList.remove(
            'is-visible'
          );
        }
      },
      {
        passive: true
      }
    );
  }

  initialize360Viewer() {
    const viewer =
      this.query(
        '[data-360-viewer]'
      );

    if (
      !viewer ||
      viewer.dataset.ready ===
        'true'
    ) {
      return;
    }

    let imageData = [];

    try {
      imageData = JSON.parse(
        viewer.dataset.images ||
        '[]'
      );
    } catch (error) {
      imageData = [];
    }

    if (
      !Array.isArray(
        imageData
      ) ||
      !imageData.length
    ) {
      viewer.innerHTML = `
        <div class="sethi-v2-360-empty">
          <strong>
            360° view unavailable
          </strong>

          <span>
            Add image files to the
            watch_360_images metafield.
          </span>
        </div>
      `;

      return;
    }

    const imageUrls =
      imageData
        .map((item) => {
          if (
            typeof item ===
            'string'
          ) {
            return item;
          }

          return (
            item?.url ||
            item?.preview_image?.src ||
            item?.src ||
            ''
          );
        })
        .filter(Boolean);

    if (!imageUrls.length) {
      viewer.innerHTML = `
        <div class="sethi-v2-360-empty">
          <strong>
            No valid 360° images found
          </strong>
        </div>
      `;

      return;
    }

    let currentIndex = 0;
    let startPosition = null;
    let isDragging = false;

    const image =
      document.createElement(
        'img'
      );

    const hint =
      document.createElement(
        'span'
      );

    hint.className =
      'sethi-v2-360-hint';

    hint.textContent =
      'Drag to rotate';

    image.src =
      imageUrls[
        currentIndex
      ];

    image.alt =
      '360 degree watch view';

    image.draggable =
      false;

    image.style.cssText = `
      display:block;
      width:100%;
      max-height:520px;
      object-fit:contain;
      touch-action:none;
      user-select:none;
      cursor:grab;
    `;

    viewer.replaceChildren(
      image,
      hint
    );

    const updateImage =
      (direction) => {
        currentIndex =
          (
            currentIndex +
            direction +
            imageUrls.length
          ) %
          imageUrls.length;

        image.src =
          imageUrls[
            currentIndex
          ];
      };

    image.addEventListener(
      'pointerdown',
      (event) => {
        startPosition =
          event.clientX;

        isDragging =
          true;

        image.style.cursor =
          'grabbing';

        image.setPointerCapture(
          event.pointerId
        );
      }
    );

    image.addEventListener(
      'pointermove',
      (event) => {
        if (
          !isDragging ||
          startPosition ===
            null
        ) {
          return;
        }

        const difference =
          event.clientX -
          startPosition;

        if (
          Math.abs(
            difference
          ) < 10
        ) {
          return;
        }

        updateImage(
          difference < 0
            ? 1
            : -1
        );

        startPosition =
          event.clientX;
      }
    );

    const stopDragging =
      () => {
        startPosition =
          null;

        isDragging =
          false;

        image.style.cursor =
          'grab';
      };

    image.addEventListener(
      'pointerup',
      stopDragging
    );

    image.addEventListener(
      'pointercancel',
      stopDragging
    );

    image.addEventListener(
      'lostpointercapture',
      stopDragging
    );

    image.addEventListener(
      'keydown',
      (event) => {
        if (
          event.key ===
          'ArrowLeft'
        ) {
          updateImage(-1);
        }

        if (
          event.key ===
          'ArrowRight'
        ) {
          updateImage(1);
        }
      }
    );

    image.tabIndex = 0;

    imageUrls
      .slice(0, 8)
      .forEach((url) => {
        const preload =
          new Image();

        preload.src = url;
      });

    viewer.dataset.ready =
      'true';
  }
    async loadRecommendations() {
    const container =
      this.query(
        '[data-recommendations]'
      );

    if (!container) return;

    const productId =
      container.dataset.productId;

    const limit =
      container.dataset.limit ||
      5;

    container.setAttribute(
      'aria-busy',
      'true'
    );

    try {
      const response =
        await fetch(
          `${window.Shopify.routes.root}` +
          `recommendations/products.json` +
          `?product_id=${encodeURIComponent(
            productId
          )}` +
          `&limit=${encodeURIComponent(
            limit
          )}` +
          `&intent=related`,
          {
            headers: {
              Accept:
                'application/json'
            }
          }
        );

      if (!response.ok) {
        throw new Error(
          'Recommendations unavailable.'
        );
      }

      const data =
        await response.json();

      const products =
        Array.isArray(
          data.products
        )
          ? data.products
          : [];

      container.innerHTML =
        products.length
          ? products
              .map((product) =>
                this.createProductCard(
                  product
                )
              )
              .join('')
          : `
              <div class="sethi-v2-empty">
                No similar watches available yet.
              </div>
            `;

      const wishlist =
        this.readWishlist();

      container
        .querySelectorAll(
          '[data-card-wishlist]'
        )
        .forEach((button) => {
          this.updateWishlistButton(
            button,
            wishlist.includes(
              String(
                button.dataset
                  .cardWishlist
              )
            )
          );
        });
    } catch (error) {
      console.warn(
        'Unable to load recommendations.',
        error
      );

      container.innerHTML = `
        <div class="sethi-v2-empty">
          Recommendations are currently unavailable.
        </div>
      `;
    } finally {
      container.removeAttribute(
        'aria-busy'
      );
    }
  }

  createProductCard(product) {
    const image =
      product.featured_image ||
      product.image ||
      '';

    const title =
      this.escapeHTML(
        product.title || ''
      );

    const vendor =
      this.escapeHTML(
        product.vendor || ''
      );

    const url =
      this.escapeHTML(
        product.url || '#'
      );

    const productId =
      this.escapeHTML(
        product.id || ''
      );

    const price =
      Number(
        product.price || 0
      );

    const compareAtPrice =
      Number(
        product.compare_at_price ||
        product.compare_at_price_max ||
        0
      );

    const isOnSale =
      compareAtPrice > price;

    const discountPercentage =
      isOnSale
        ? Math.round(
            (
              (
                compareAtPrice -
                price
              ) /
              compareAtPrice
            ) *
            100
          )
        : 0;

    const safeImage =
      this.escapeHTML(
        typeof image ===
          'string'
          ? image
          : image?.src || ''
      );

    return `
      <article class="sethi-v2-card">
        <div class="sethi-v2-card__visual">

          ${
            isOnSale
              ? `
                <span class="sethi-v2-card__badge">
                  ${discountPercentage}% off
                </span>
              `
              : ''
          }

          <button
            type="button"
            class="sethi-v2-card__wishlist"
            data-card-wishlist="${productId}"
            aria-label="Add ${title} to wishlist"
            aria-pressed="false"
          >
            ♡
          </button>

          <a
            class="sethi-v2-card__image"
            href="${url}"
            aria-label="${title}"
          >
            ${
              safeImage
                ? `
                  <img
                    src="${safeImage}"
                    alt="${title}"
                    loading="lazy"
                    decoding="async"
                  >
                `
                : `
                  <span class="sethi-v2-card__placeholder">
                    Image unavailable
                  </span>
                `
            }
          </a>
        </div>

        <div class="sethi-v2-card__body">
          <span class="sethi-v2-card__vendor">
            ${vendor}
          </span>

          <a
            class="sethi-v2-card__title"
            href="${url}"
          >
            ${title}
          </a>

          <div class="sethi-v2-card__pricing">
            <strong class="sethi-v2-card__price">
              ${this.formatMoney(
                price
              )}
            </strong>

            ${
              isOnSale
                ? `
                  <del>
                    ${this.formatMoney(
                      compareAtPrice
                    )}
                  </del>
                `
                : ''
            }
          </div>

          <span class="sethi-v2-card__explore">
            Explore timepiece
            <b aria-hidden="true">
              →
            </b>
          </span>
        </div>
      </article>
    `;
  }

  escapeHTML(value) {
    const element =
      document.createElement(
        'div'
      );

    element.textContent =
      String(
        value || ''
      );

    return element.innerHTML;
  }

  async reserveTimepiece() {
    const store =
      this.query(
        '[data-reservation-store]'
      )?.value.trim();

    const date =
      this.query(
        '[data-reservation-date]'
      )?.value;

    const timeSlot =
      this.query(
        '[data-reservation-slot]'
      )?.value;

    const name =
      this.query(
        '[data-reservation-name]'
      )?.value.trim();

    const phone =
      this.query(
        '[data-reservation-phone]'
      )?.value.trim();

    const email =
      this.query(
        '[data-reservation-email]'
      )?.value.trim();

    const button =
      this.query(
        '[data-pay-reservation]'
      );

    const message =
      this.query(
        '[data-reservation-message]'
      );

    const depositVariantId =
      Number(
        button?.dataset
          .depositVariant
      );

    if (message) {
      message.textContent =
        '';

      message.classList.remove(
        'is-error',
        'is-success'
      );
    }

    const isPhoneValid =
      /^[6-9][0-9]{9}$/.test(
        phone || ''
      );

    const isEmailValid =
      !email ||
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email
      );

    if (
      !store ||
      !date ||
      !timeSlot ||
      !name ||
      !isPhoneValid ||
      !isEmailValid
    ) {
      if (message) {
        message.textContent =
          !isEmailValid
            ? 'Enter a valid email address.'
            : 'Complete store, date, time slot, name and valid phone number.';

        message.classList.add(
          'is-error'
        );
      }

      return;
    }

    const selectedDate =
      new Date(
        `${date}T00:00:00`
      );

    const today =
      new Date();

    today.setHours(
      0,
      0,
      0,
      0
    );

    if (
      Number.isNaN(
        selectedDate.getTime()
      ) ||
      selectedDate < today
    ) {
      if (message) {
        message.textContent =
          'Choose a valid future pickup date.';

        message.classList.add(
          'is-error'
        );
      }

      return;
    }

    if (!depositVariantId) {
      if (message) {
        message.textContent =
          'Reservation deposit variant is not configured.';

        message.classList.add(
          'is-error'
        );
      }

      return;
    }

    try {
      if (button) {
        button.disabled = true;

        button.setAttribute(
          'aria-busy',
          'true'
        );

        button.textContent =
          'Creating reservation…';
      }

      await this.addCartItems([
        {
          id:
            depositVariantId,
          quantity: 1,
          properties: {
            '_Reserved watch':
              document.title,

            '_Watch variant':
              String(
                this.currentVariant
                  ?.id || ''
              ),

            'Pickup store':
              store,

            'Pickup date':
              date,

            'Pickup time':
              timeSlot,

            'Customer name':
              name,

            'Customer phone':
              phone,

            'Customer email':
              email || ''
          }
        }
      ]);

      if (message) {
        message.textContent =
          'Reservation created. Redirecting to secure checkout…';

        message.classList.add(
          'is-success'
        );
      }

      window.location.href =
        `${window.Shopify.routes.root}checkout`;
    } catch (error) {
      if (message) {
        message.textContent =
          error.message ||
          'Unable to create reservation.';

        message.classList.add(
          'is-error'
        );
      }

      if (button) {
        button.disabled = false;

        button.removeAttribute(
          'aria-busy'
        );

        button.textContent =
          'Pay advance and reserve';
      }
    }
  }
    async loadSameBrandProducts() {
    const container = this.query(
      '[data-same-brand-products]'
    );

    if (!container) return;

    const vendor = String(
      container.dataset.vendor || ''
    ).trim();

    const currentProductId = String(
      container.dataset.currentProduct || ''
    );

    if (!vendor) {
      container.innerHTML = `
        <div class="sethi-v2-empty">
          Brand products are currently unavailable.
        </div>
      `;

      return;
    }

    container.setAttribute(
      'aria-busy',
      'true'
    );

    try {
      const searchQuery = encodeURIComponent(
        vendor
      );

      const response = await fetch(
        `${window.Shopify.routes.root}` +
          `search/suggest.json` +
          `?q=${searchQuery}` +
          `&resources[type]=product` +
          `&resources[limit]=10` +
          `&resources[options][unavailable_products]=last`,
        {
          headers: {
            Accept: 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error(
          'Unable to load brand products.'
        );
      }

      const data = await response.json();

      const searchProducts =
        data?.resources?.results?.products ||
        [];

      const products = searchProducts
        .filter((item) => {
          const sameVendor =
            String(
              item.vendor || ''
            ).toLowerCase() ===
            vendor.toLowerCase();

          const isDifferentProduct =
            String(item.id) !==
            currentProductId;

          return (
            sameVendor &&
            isDifferentProduct
          );
        })
        .slice(0, 5);

      container.innerHTML =
        products.length
          ? products
              .map((product) =>
                this.createProductCard(
                  product
                )
              )
              .join('')
          : `
              <div class="sethi-v2-empty">
                No additional ${this.escapeHTML(
                  vendor
                )} watches are available right now.
              </div>
            `;

      const wishlist =
        this.readWishlist();

      container
        .querySelectorAll(
          '[data-card-wishlist]'
        )
        .forEach((button) => {
          const productId = String(
            button.dataset
              .cardWishlist || ''
          );

          this.updateWishlistButton(
            button,
            wishlist.includes(
              productId
            )
          );
        });
    } catch (error) {
      console.warn(
        'Unable to load same-brand products.',
        error
      );

      container.innerHTML = `
        <div class="sethi-v2-empty">
          More ${this.escapeHTML(
            vendor
          )} watches are currently unavailable.
        </div>
      `;
    } finally {
      container.removeAttribute(
        'aria-busy'
      );
    }
  }
}

function initializeSethiV2(
  container = document
) {
  container
    .querySelectorAll(
      '[data-sethi-v2]'
    )
    .forEach((element) => {
      if (
        element.dataset
          .sethiInitialized ===
        'true'
      ) {
        return;
      }

      element.dataset
        .sethiInitialized =
        'true';

      const sethiProductPage =
        new SethiV2(element);

      sethiProductPage
        .loadSameBrandProducts();
    });
}

function destroySethiV2(
  container = document
) {
  container
    .querySelectorAll(
      '[data-sethi-v2]'
    )
    .forEach((element) => {
      delete element.dataset
        .sethiInitialized;
    });
}

if (
  document.readyState ===
  'loading'
) {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      initializeSethiV2();
    },
    {
      once: true
    }
  );
} else {
  initializeSethiV2();
}

document.addEventListener(
  'shopify:section:load',
  (event) => {
    initializeSethiV2(
      event.target
    );
  }
);

document.addEventListener(
  'shopify:section:unload',
  (event) => {
    destroySethiV2(
      event.target
    );
  }
);

document.addEventListener(
  'shopify:section:reorder',
  () => {
    initializeSethiV2();
  }
);
