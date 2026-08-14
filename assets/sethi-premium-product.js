class SethiPremiumProduct {
  constructor(section) {
    this.section = section;
    this.variants = this.getVariants();
    this.activeMediaIndex = 0;

    this.cacheElements();
    this.bindEvents();
    this.setInitialMediaIndex();
  }

  cacheElements() {
    this.thumbnails = [...this.section.querySelectorAll('[data-media-target]')];
    this.mediaItems = [...this.section.querySelectorAll('[data-media-id]')];

    this.variantIdInput = this.section.querySelector('[data-variant-id]');
    this.optionInputs = [...this.section.querySelectorAll('[data-option-position]')];

    this.price = this.section.querySelector('[data-product-price]');
    this.comparePrice = this.section.querySelector('[data-compare-price]');
    this.discountBadge = this.section.querySelector('[data-discount-badge]');
    this.mobilePrice = this.section.querySelector('[data-mobile-price]');

    this.stockStatus = this.section.querySelector('[data-stock-status]');
    this.stockLabel = this.section.querySelector('[data-stock-label]');
    this.stockMessage = this.section.querySelector('[data-stock-message]');

    this.purchaseActions = this.section.querySelector('[data-purchase-actions]');
    this.stockEnquiry = this.section.querySelector('[data-stock-enquiry]');

    this.form = this.section.querySelector('[data-type="add-to-cart-form"]');
    this.addButton = this.section.querySelector('[data-add-to-cart]');
    this.addButtonText = this.section.querySelector('[data-add-to-cart-text]');
    this.buyNowButton = this.section.querySelector('[data-buy-now]');

    this.quantityInput = this.section.querySelector('[data-quantity-input]');
    this.mobileAddButton = this.section.querySelector('[data-mobile-add]');

    this.pincodeInput = this.section.querySelector('[data-pincode-input]');
    this.pincodeResult = this.section.querySelector('[data-pincode-result]');

    this.galleryDialog = this.section.querySelector('[data-gallery-dialog]');
    this.lightboxContent = this.section.querySelector('[data-lightbox-content]');

    this.currentMediaCounter = this.section.querySelector('[data-current-media]');
  }

  bindEvents() {
    this.thumbnails.forEach((thumbnail) => {
      thumbnail.addEventListener('click', () => {
        const mediaId = thumbnail.dataset.mediaTarget;
        this.showMediaById(mediaId);
      });
    });

    this.section
      .querySelector('[data-gallery-prev]')
      ?.addEventListener('click', () => this.changeMedia(-1));

    this.section
      .querySelector('[data-gallery-next]')
      ?.addEventListener('click', () => this.changeMedia(1));

    this.section
      .querySelector('[data-open-gallery]')
      ?.addEventListener('click', () => this.openLightbox());

    this.section
      .querySelector('[data-close-gallery]')
      ?.addEventListener('click', () => this.galleryDialog?.close());

    this.optionInputs.forEach((input) => {
      input.addEventListener('change', () => this.onVariantChange());
    });

    this.section
      .querySelector('[data-quantity-minus]')
      ?.addEventListener('click', () => this.changeQuantity(-1));

    this.section
      .querySelector('[data-quantity-plus]')
      ?.addEventListener('click', () => this.changeQuantity(1));

    this.section
      .querySelector('[data-check-pincode]')
      ?.addEventListener('click', () => this.checkPincode());

    this.pincodeInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.checkPincode();
      }
    });

    this.form?.addEventListener('submit', (event) => this.addToCart(event));

    this.buyNowButton?.addEventListener('click', () => {
      this.addToCart(null, true);
    });

    this.mobileAddButton?.addEventListener('click', () => {
      const currentVariant = this.getCurrentVariant();

      if (currentVariant?.available) {
        this.addToCart();
      } else {
        this.stockEnquiry?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }
    });

    this.section
      .querySelector('[data-submit-enquiry]')
      ?.addEventListener('click', () => this.submitEnquiry(false));

    this.section
      .querySelector('[data-notify-me]')
      ?.addEventListener('click', () => this.submitEnquiry(true));

    this.galleryDialog?.addEventListener('click', (event) => {
      if (event.target === this.galleryDialog) {
        this.galleryDialog.close();
      }
    });
  }

  getVariants() {
    const jsonElement = this.section.querySelector('[data-product-json]');

    if (!jsonElement) return [];

    try {
      return JSON.parse(jsonElement.textContent);
    } catch (error) {
      console.error('Unable to parse product variants.', error);
      return [];
    }
  }

  setInitialMediaIndex() {
    this.activeMediaIndex = this.mediaItems.findIndex(
      (item) => !item.hasAttribute('hidden')
    );

    if (this.activeMediaIndex < 0) {
      this.activeMediaIndex = 0;
    }

    this.updateMediaCounter();
  }

  showMediaById(mediaId) {
    const newIndex = this.mediaItems.findIndex(
      (item) => String(item.dataset.mediaId) === String(mediaId)
    );

    if (newIndex < 0) return;

    this.activeMediaIndex = newIndex;

    this.mediaItems.forEach((media, index) => {
      const active = index === this.activeMediaIndex;
      media.toggleAttribute('hidden', !active);
      media.classList.toggle('is-active', active);

      if (!active) {
        media.querySelectorAll('video').forEach((video) => video.pause());
      }
    });

    this.thumbnails.forEach((thumbnail) => {
      thumbnail.classList.toggle(
        'is-active',
        String(thumbnail.dataset.mediaTarget) === String(mediaId)
      );
    });

    this.updateMediaCounter();
  }

  changeMedia(direction) {
    if (!this.mediaItems.length) return;

    this.activeMediaIndex += direction;

    if (this.activeMediaIndex < 0) {
      this.activeMediaIndex = this.mediaItems.length - 1;
    }

    if (this.activeMediaIndex >= this.mediaItems.length) {
      this.activeMediaIndex = 0;
    }

    const mediaId = this.mediaItems[this.activeMediaIndex].dataset.mediaId;
    this.showMediaById(mediaId);
  }

  updateMediaCounter() {
    if (this.currentMediaCounter) {
      this.currentMediaCounter.textContent = String(this.activeMediaIndex + 1);
    }
  }

  openLightbox() {
    const activeMedia = this.mediaItems[this.activeMediaIndex];
    const image = activeMedia?.querySelector('img');

    if (!image || !this.galleryDialog || !this.lightboxContent) return;

    const fullImage = image.cloneNode(true);
    fullImage.removeAttribute('loading');
    fullImage.src = image.currentSrc || image.src;

    this.lightboxContent.replaceChildren(fullImage);
    this.galleryDialog.showModal();
  }

  onVariantChange() {
    const selectedOptions = this.getSelectedOptions();

    const matchedVariant = this.variants.find((variant) => {
      return variant.options.every(
        (option, index) => option === selectedOptions[index]
      );
    });

    if (!matchedVariant) return;

    if (this.variantIdInput) {
      this.variantIdInput.value = matchedVariant.id;
    }

    this.updateSelectedOptionLabels();
    this.updateVariantUI(matchedVariant);
    this.updateUrl(matchedVariant);

    if (matchedVariant.featured_media?.id) {
      this.showMediaById(matchedVariant.featured_media.id);
    }
  }

  getSelectedOptions() {
    const selected = [];

    this.optionInputs
      .filter((input) => input.checked)
      .sort(
        (a, b) =>
          Number(a.dataset.optionPosition) -
          Number(b.dataset.optionPosition)
      )
      .forEach((input) => selected.push(input.value));

    return selected;
  }

  updateSelectedOptionLabels() {
    this.optionInputs
      .filter((input) => input.checked)
      .forEach((input) => {
        const label = this.section.querySelector(
          `[data-selected-option="${input.dataset.optionPosition}"]`
        );

        if (label) {
          label.textContent = input.value;
        }
      });
  }

  updateVariantUI(variant) {
    const formattedPrice = this.formatMoney(variant.price);
    const hasDiscount =
      variant.compare_at_price &&
      variant.compare_at_price > variant.price;

    if (this.price) this.price.textContent = formattedPrice;
    if (this.mobilePrice) this.mobilePrice.textContent = formattedPrice;

    if (hasDiscount) {
      const discount = Math.round(
        ((variant.compare_at_price - variant.price) /
          variant.compare_at_price) *
          100
      );

      if (this.comparePrice) {
        this.comparePrice.textContent = this.formatMoney(
          variant.compare_at_price
        );
        this.comparePrice.hidden = false;
      }

      if (this.discountBadge) {
        this.discountBadge.textContent = `${discount}% OFF`;
        this.discountBadge.hidden = false;
      }
    } else {
      if (this.comparePrice) this.comparePrice.hidden = true;
      if (this.discountBadge) this.discountBadge.hidden = true;
    }

    this.stockStatus?.classList.toggle('is-sold-out', !variant.available);

    if (this.stockLabel) {
      this.stockLabel.textContent = variant.available
        ? 'In stock'
        : 'Currently unavailable';
    }

    if (this.stockMessage) {
      this.stockMessage.textContent = variant.available
        ? 'Ready to dispatch'
        : 'Submit an enquiry and our team will contact you';
    }

    if (this.purchaseActions) {
      this.purchaseActions.hidden = !variant.available;
    }

    if (this.stockEnquiry) {
      this.stockEnquiry.hidden = variant.available;
    }

    if (this.mobileAddButton) {
      this.mobileAddButton.disabled = false;
      this.mobileAddButton.textContent = variant.available
        ? 'Add to cart'
        : 'Enquire now';
    }
  }

  updateUrl(variant) {
    if (!variant?.id || !window.history.replaceState) return;

    const url = new URL(window.location.href);
    url.searchParams.set('variant', variant.id);

    window.history.replaceState({}, '', url.toString());
  }

  getCurrentVariant() {
    const variantId = Number(this.variantIdInput?.value);

    return this.variants.find((variant) => variant.id === variantId);
  }

  changeQuantity(amount) {
    if (!this.quantityInput) return;

    const currentValue = Number(this.quantityInput.value) || 1;
    this.quantityInput.value = String(Math.max(1, currentValue + amount));
  }

  async addToCart(event = null, redirectToCheckout = false) {
    event?.preventDefault();

    if (!this.form || !this.variantIdInput?.value) return;

    const submitButton = this.addButton;
    const originalText = this.addButtonText?.textContent;

    try {
      if (submitButton) submitButton.disabled = true;
      if (this.addButtonText) this.addButtonText.textContent = 'Adding…';

      const formData = new FormData(this.form);

      const response = await fetch(`${window.Shopify.routes.root}cart/add.js`, {
        method: 'POST',
        headers: {
          Accept: 'application/json'
        },
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.description || 'Unable to add this item.');
      }

      if (redirectToCheckout) {
        window.location.href = `${window.Shopify.routes.root}checkout`;
        return;
      }

      document.dispatchEvent(
        new CustomEvent('cart:refresh', {
          bubbles: true,
          detail: { product: data }
        })
      );

      if (this.addButtonText) {
        this.addButtonText.textContent = 'Added to cart ✓';
      }

      setTimeout(() => {
        if (this.addButtonText) {
          this.addButtonText.textContent = originalText || 'Add to cart';
        }
      }, 1800);
    } catch (error) {
      console.error(error);

      if (this.addButtonText) {
        this.addButtonText.textContent = error.message;
      }

      setTimeout(() => {
        if (this.addButtonText) {
          this.addButtonText.textContent = originalText || 'Add to cart';
        }
      }, 2500);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  }

  checkPincode() {
    if (!this.pincodeInput || !this.pincodeResult) return;

    const pincode = this.pincodeInput.value.trim();

    this.pincodeResult.hidden = false;
    this.pincodeResult.classList.remove('is-error');

    if (!/^[1-9][0-9]{5}$/.test(pincode)) {
      this.pincodeResult.classList.add('is-error');
      this.pincodeResult.textContent =
        'Please enter a valid 6-digit Indian pincode.';
      return;
    }

    /*
      Temporary delivery calculation.
      In the next step, this will be connected with the shipping/delivery API.
    */
    const today = new Date();
    const deliveryDays = this.getEstimatedDeliveryDays(pincode);
    const deliveryDate = new Date(today);

    deliveryDate.setDate(today.getDate() + deliveryDays);

    const formattedDate = deliveryDate.toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });

    localStorage.setItem('sethi_delivery_pincode', pincode);

    this.pincodeResult.innerHTML = `
      <strong>Delivery expected by ${formattedDate}</strong><br>
      Free insured shipping available for ${pincode}.
    `;
  }

  getEstimatedDeliveryDays(pincode) {
    const firstDigit = Number(pincode.charAt(0));

    if ([1, 2].includes(firstDigit)) return 2;
    if ([3, 4, 5].includes(firstDigit)) return 3;

    return 5;
  }

  submitEnquiry(isNotificationRequest) {
    const name = this.section.querySelector('[data-enquiry-name]')?.value.trim();
    const phone = this.section
      .querySelector('[data-enquiry-phone]')
      ?.value.trim();
    const message = this.section.querySelector('[data-enquiry-message]');

    if (!name || !/^[6-9][0-9]{9}$/.test(phone || '')) {
      if (message) {
        message.textContent =
          'Please enter your name and a valid 10-digit phone number.';
      }
      return;
    }

    const productTitle =
      this.section.querySelector('.sethi-buybox__title')?.textContent.trim() ||
      'this watch';

    const enquiryType = isNotificationRequest
      ? 'Back-in-stock notification'
      : 'Product availability enquiry';

    const text = encodeURIComponent(
      `${enquiryType}\n\nProduct: ${productTitle}\nName: ${name}\nPhone: ${phone}\nPage: ${window.location.href}`
    );

    const whatsappLink = this.section.querySelector(
      '.sethi-expert__actions a[href*="wa.me"]'
    );

    const number = whatsappLink?.href.split('wa.me/')[1]?.split('?')[0];

    if (!number) {
      if (message) {
        message.textContent =
          'WhatsApp number is not configured in the Theme Editor.';
      }
      return;
    }

    window.open(`https://wa.me/${number}?text=${text}`, '_blank', 'noopener');

    if (message) {
      message.textContent =
        'Your enquiry is ready. Please send the pre-filled WhatsApp message.';
    }
  }

  formatMoney(cents) {
    if (window.Shopify?.currency?.active) {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: window.Shopify.currency.active,
        maximumFractionDigits: 0
      }).format(cents / 100);
    }

    return `₹${(cents / 100).toLocaleString('en-IN')}`;
  }
}

function initializeSethiProducts(container = document) {
  container
    .querySelectorAll('[id^="SethiPremiumProduct-"]')
    .forEach((section) => {
      if (section.dataset.initialized === 'true') return;

      section.dataset.initialized = 'true';
      new SethiPremiumProduct(section);
    });
}

document.addEventListener('DOMContentLoaded', () => {
  initializeSethiProducts();

  document
    .querySelectorAll('[data-pincode-input]')
    .forEach((input) => {
      const savedPincode = localStorage.getItem('sethi_delivery_pincode');

      if (savedPincode && !input.value) {
        input.value = savedPincode;
      }
    });
});

document.addEventListener('shopify:section:load', (event) => {
  initializeSethiProducts(event.target);
});