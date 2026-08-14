class SethiCompleteProduct {
  constructor(section) {
    this.section = section;

    this.variants = this.parseJSON('[data-product-variants-json]', []);
    this.currentProduct = this.parseJSON('[data-current-product-json]', {});

    this.activeMediaIndex = 0;
    this.currentVariant = null;
    this.contactType = 'Product enquiry';

    this.cacheElements();
    this.setInitialState();
    this.bindEvents();
    this.restoreSavedPincode();
  }

  parseJSON(selector, fallback) {
    const element = this.section.querySelector(selector);

    if (!element) return fallback;

    try {
      return JSON.parse(element.textContent);
    } catch (error) {
      console.error(`Sethi Product: Unable to parse ${selector}`, error);
      return fallback;
    }
  }

  cacheElements() {
    /* Gallery */
    this.galleryThumbnails = [
      ...this.section.querySelectorAll('[data-gallery-thumbnail]')
    ];

    this.galleryMedia = [
      ...this.section.querySelectorAll('[data-gallery-media]')
    ];

    this.galleryCurrent = this.section.querySelector('[data-gallery-current]');
    this.lightbox = this.section.querySelector('[data-image-lightbox]');
    this.lightboxContent = this.section.querySelector(
      '[data-lightbox-content]'
    );

    /* Product form and variants */
    this.productForm = this.section.querySelector('[data-product-form]');
    this.variantIdInput = this.section.querySelector('[data-variant-id]');

    this.optionInputs = [
      ...this.section.querySelectorAll('[data-option-input]')
    ];

    this.productPrice = this.section.querySelector('[data-product-price]');
    this.comparePrice = this.section.querySelector(
      '[data-product-compare-price]'
    );
    this.discountBadge = this.section.querySelector(
      '[data-product-discount]'
    );
    this.productSku = this.section.querySelector('[data-product-sku]');
    this.mobilePrice = this.section.querySelector('[data-mobile-price]');

    /* Stock and purchase */
    this.stockStatus = this.section.querySelector('[data-stock-status]');
    this.stockHeading = this.section.querySelector('[data-stock-heading]');
    this.stockText = this.section.querySelector('[data-stock-text]');

    this.purchaseActions = this.section.querySelector(
      '[data-purchase-actions]'
    );

    this.stockEnquiry = this.section.querySelector('[data-stock-enquiry]');

    this.quantityInput = this.section.querySelector('[data-quantity-input]');

    this.addToCartButton = this.section.querySelector('[data-add-to-cart]');
    this.addToCartText = this.section.querySelector(
      '[data-add-to-cart-text]'
    );

    this.buyNowButton = this.section.querySelector('[data-buy-now]');

    this.mobilePrimaryButton = this.section.querySelector(
      '[data-mobile-primary-action]'
    );

    /* Delivery */
    this.pincodeInput = this.section.querySelector('[data-pincode-input]');
    this.deliveryResult = this.section.querySelector(
      '[data-delivery-result]'
    );

    /* Bundle */
    this.bundleSection = this.section.querySelector('[data-bundle-section]');

    this.bundleCheckboxes = [
      ...this.section.querySelectorAll('[data-bundle-checkbox]')
    ];

    this.bundleCount = this.section.querySelector('[data-bundle-count]');
    this.bundleTotal = this.section.querySelector('[data-bundle-total]');
    this.bundleMessage = this.section.querySelector('[data-bundle-message]');
    this.addBundleButton = this.section.querySelector('[data-add-bundle]');

    /* Dialogs */
    this.emiDialog = this.section.querySelector('[data-emi-dialog]');
    this.sizeGuideDialog = this.section.querySelector(
      '[data-size-guide-dialog]'
    );
    this.contactDialog = this.section.querySelector('[data-contact-dialog]');

    this.contactEyebrow = this.section.querySelector(
      '[data-contact-eyebrow]'
    );
    this.contactHeading = this.section.querySelector(
      '[data-contact-heading]'
    );

    this.contactName = this.section.querySelector('[data-contact-name]');
    this.contactPhone = this.section.querySelector('[data-contact-phone]');
    this.contactEmail = this.section.querySelector('[data-contact-email]');

    this.contactMessageInput = this.section.querySelector(
      '[data-contact-message-input]'
    );

    this.contactStatus = this.section.querySelector('[data-contact-status]');

    /* Enquiry */
    this.enquiryName = this.section.querySelector('[data-enquiry-name]');
    this.enquiryPhone = this.section.querySelector('[data-enquiry-phone]');
    this.enquiryEmail = this.section.querySelector('[data-enquiry-email]');

    this.enquiryMessage = this.section.querySelector(
      '[data-enquiry-message]'
    );

    /* Product lists */
    this.recommendationsContainer = this.section.querySelector(
      '[data-product-recommendations]'
    );

    this.sameBrandContainer = this.section.querySelector(
      '[data-same-brand-products]'
    );

    this.recentlyViewedSection = this.section.querySelector(
      '[data-recently-viewed-section]'
    );

    this.recentlyViewedContainer = this.section.querySelector(
      '[data-recently-viewed-products]'
    );
  }

  setInitialState() {
    const initialVariantId = Number(this.variantIdInput?.value);

    this.currentVariant =
      this.variants.find((variant) => variant.id === initialVariantId) ||
      this.variants[0] ||
      null;

    const visibleMediaIndex = this.galleryMedia.findIndex(
      (media) => !media.hasAttribute('hidden')
    );

    this.activeMediaIndex =
      visibleMediaIndex >= 0 ? visibleMediaIndex : 0;

    this.updateGalleryCounter();
    this.updateBundleSummary();
  }

  bindEvents() {
    /* Gallery thumbnails */
    this.galleryThumbnails.forEach((thumbnail) => {
      thumbnail.addEventListener('click', () => {
        this.showMedia(thumbnail.dataset.mediaId);
      });
    });

    this.section
      .querySelector('[data-gallery-previous]')
      ?.addEventListener('click', () => {
        this.changeMedia(-1);
      });

    this.section
      .querySelector('[data-gallery-next]')
      ?.addEventListener('click', () => {
        this.changeMedia(1);
      });

    this.section.querySelectorAll('[data-open-lightbox]').forEach((button) => {
      button.addEventListener('click', () => {
        this.openLightbox();
      });
    });

    /* Variant inputs */
    this.optionInputs.forEach((input) => {
      input.addEventListener('change', () => {
        this.handleVariantChange();
      });
    });

    /* Quantity */
    this.section
      .querySelector('[data-quantity-minus]')
      ?.addEventListener('click', () => {
        this.changeQuantity(-1);
      });

    this.section
      .querySelector('[data-quantity-plus]')
      ?.addEventListener('click', () => {
        this.changeQuantity(1);
      });

    /* Product purchase */
    this.productForm?.addEventListener('submit', (event) => {
      this.addCurrentProductToCart(event, false);
    });

    this.buyNowButton?.addEventListener('click', () => {
      this.addCurrentProductToCart(null, true);
    });

    this.mobilePrimaryButton?.addEventListener('click', () => {
      const action = this.mobilePrimaryButton.dataset.action;

      if (action === 'enquiry') {
        this.stockEnquiry?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });

        return;
      }

      this.addCurrentProductToCart(null, false);
    });

    /* Offers */
    this.section
      .querySelector('[data-toggle-offers]')
      ?.addEventListener('click', (event) => {
        this.toggleOffers(event.currentTarget);
      });

    /* Delivery */
    this.section
      .querySelector('[data-check-pincode]')
      ?.addEventListener('click', () => {
        this.checkPincode();
      });

    this.pincodeInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.checkPincode();
      }
    });

    /* Enquiry buttons */
    this.section
      .querySelector('[data-submit-enquiry]')
      ?.addEventListener('click', () => {
        this.submitStockEnquiry(false);
      });

    this.section
      .querySelector('[data-notify-me]')
      ?.addEventListener('click', () => {
        this.submitStockEnquiry(true);
      });

    /* Bundle */
    this.bundleCheckboxes.forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        this.updateBundleSummary();
      });
    });

    this.addBundleButton?.addEventListener('click', () => {
      this.addSelectedBundle();
    });

    /* Dialog triggers */
    this.section.querySelectorAll('[data-open-emi]').forEach((button) => {
      button.addEventListener('click', () => {
        this.openDialog(this.emiDialog);
      });
    });

    this.section
      .querySelectorAll('[data-open-size-guide]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          this.openDialog(this.sizeGuideDialog);
        });
      });

    this.section
      .querySelectorAll('[data-request-callback]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          this.openContactDialog(
            'Callback request',
            'Request a callback'
          );
        });
      });

    this.section
      .querySelectorAll('[data-request-video-call]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          this.openContactDialog(
            'Video consultation',
            'Shop on a video call'
          );
        });
      });

    this.section
      .querySelectorAll('[data-book-appointment]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          this.openContactDialog(
            'Store appointment',
            'Book a store appointment'
          );
        });
      });

    this.section
      .querySelector('[data-submit-contact]')
      ?.addEventListener('click', () => {
        this.submitContactRequest();
      });

    this.section.querySelectorAll('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => {
        button.closest('dialog')?.close();
      });
    });

    this.section.querySelectorAll('dialog').forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) {
          dialog.close();
        }
      });
    });

    /* Share */
    this.section
      .querySelector('[data-share-product]')
      ?.addEventListener('click', () => {
        this.shareProduct();
      });

    /* Reviews */
    this.section
      .querySelector('[data-scroll-to-reviews]')
      ?.addEventListener('click', () => {
        this.section
          .querySelector('[data-reviews-section]')
          ?.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });
      });

    /* Wishlist */
    this.section.querySelectorAll('[data-wishlist-button]').forEach((button) => {
      button.addEventListener('click', () => {
        this.toggleWishlist(button);
      });
    });

    /* Compare */
    this.section
      .querySelector('[data-compare-product]')
      ?.addEventListener('click', (event) => {
        this.toggleCompare(event.currentTarget);
      });

    /* AR fallback */
    this.section
      .querySelector('[data-ar-unavailable]')
      ?.addEventListener('click', () => {
        const message = this.section.querySelector('[data-ar-message]');

        if (message) {
          message.textContent =
            'AR preview is not available for this product yet.';
        }
      });
  }

  showMedia(mediaId) {
    const newIndex = this.galleryMedia.findIndex(
      (media) => String(media.dataset.mediaId) === String(mediaId)
    );

    if (newIndex < 0) return;

    this.activeMediaIndex = newIndex;

    this.galleryMedia.forEach((media, index) => {
      const isActive = index === this.activeMediaIndex;

      media.toggleAttribute('hidden', !isActive);
      media.classList.toggle('is-active', isActive);

      if (!isActive) {
        media.querySelectorAll('video').forEach((video) => {
          video.pause();
        });
      }
    });

    this.galleryThumbnails.forEach((thumbnail) => {
      thumbnail.classList.toggle(
        'is-active',
        String(thumbnail.dataset.mediaId) === String(mediaId)
      );
    });

    this.updateGalleryCounter();
  }

  changeMedia(direction) {
    if (!this.galleryMedia.length) return;

    this.activeMediaIndex += direction;

    if (this.activeMediaIndex < 0) {
      this.activeMediaIndex = this.galleryMedia.length - 1;
    }

    if (this.activeMediaIndex >= this.galleryMedia.length) {
      this.activeMediaIndex = 0;
    }

    const mediaId =
      this.galleryMedia[this.activeMediaIndex]?.dataset.mediaId;

    if (mediaId) {
      this.showMedia(mediaId);
    }
  }

  updateGalleryCounter() {
    if (!this.galleryCurrent) return;

    this.galleryCurrent.textContent = String(this.activeMediaIndex + 1);
  }

  openLightbox() {
    const activeMedia = this.galleryMedia[this.activeMediaIndex];
    const image = activeMedia?.querySelector('img');

    if (!image || !this.lightbox || !this.lightboxContent) return;

    const lightboxImage = image.cloneNode(true);

    lightboxImage.removeAttribute('loading');
    lightboxImage.removeAttribute('width');
    lightboxImage.removeAttribute('height');

    lightboxImage.src = image.currentSrc || image.src;

    this.lightboxContent.replaceChildren(lightboxImage);
    this.openDialog(this.lightbox);
  }

  getSelectedOptions() {
    return this.optionInputs
      .filter((input) => input.checked)
      .sort(
        (first, second) =>
          Number(first.dataset.optionPosition) -
          Number(second.dataset.optionPosition)
      )
      .map((input) => input.value);
  }

  handleVariantChange() {
    const selectedOptions = this.getSelectedOptions();

    const matchingVariant = this.variants.find((variant) => {
      return variant.options.every(
        (option, index) => option === selectedOptions[index]
      );
    });

    if (!matchingVariant) return;

    this.currentVariant = matchingVariant;

    if (this.variantIdInput) {
      this.variantIdInput.value = matchingVariant.id;
    }

    this.updateSelectedOptionLabels();
    this.updateVariantDisplay(matchingVariant);
    this.updateVariantURL(matchingVariant);

    if (matchingVariant.featured_media?.id) {
      this.showMedia(matchingVariant.featured_media.id);
    }
  }

  updateSelectedOptionLabels() {
    this.optionInputs
      .filter((input) => input.checked)
      .forEach((input) => {
        const label = this.section.querySelector(
          `[data-option-label="${input.dataset.optionPosition}"]`
        );

        if (label) {
          label.textContent = input.value;
        }
      });
  }

  updateVariantDisplay(variant) {
    const formattedPrice = this.formatMoney(variant.price);

    if (this.productPrice) {
      this.productPrice.textContent = formattedPrice;
    }

    if (this.mobilePrice) {
      this.mobilePrice.textContent = formattedPrice;
    }

    const hasDiscount =
      Number(variant.compare_at_price) > Number(variant.price);

    if (this.comparePrice) {
      this.comparePrice.hidden = !hasDiscount;

      if (hasDiscount) {
        this.comparePrice.textContent = this.formatMoney(
          variant.compare_at_price
        );
      }
    }

    if (this.discountBadge) {
      this.discountBadge.hidden = !hasDiscount;

      if (hasDiscount) {
        const discount = Math.round(
          ((variant.compare_at_price - variant.price) /
            variant.compare_at_price) *
            100
        );

        this.discountBadge.textContent = `${discount}% OFF`;
      }
    }

    if (this.productSku) {
      this.productSku.textContent = variant.sku
        ? `Model: ${variant.sku}`
        : '';
    }

    this.updateAvailability(variant);
    this.updateBundleSummary();
  }

  updateAvailability(variant) {
    const available = Boolean(variant.available);

    this.stockStatus?.classList.toggle('is-unavailable', !available);

    if (this.stockHeading) {
      this.stockHeading.textContent = available
        ? 'In stock'
        : 'Currently unavailable';
    }

    if (this.stockText) {
      this.stockText.textContent = available
        ? 'Ready for dispatch'
        : 'Enquire for availability or similar options';
    }

    if (this.purchaseActions) {
      this.purchaseActions.hidden = !available;
    }

    if (this.stockEnquiry) {
      this.stockEnquiry.hidden = available;
    }

    if (this.mobilePrimaryButton) {
      this.mobilePrimaryButton.dataset.action = available
        ? 'cart'
        : 'enquiry';

      this.mobilePrimaryButton.textContent = available
        ? 'Add to cart'
        : 'Enquire now';
    }
  }

  updateVariantURL(variant) {
    if (!variant?.id || !window.history.replaceState) return;

    const currentURL = new URL(window.location.href);

    currentURL.searchParams.set('variant', variant.id);

    window.history.replaceState(
      {},
      '',
      currentURL.toString()
    );
  }

  changeQuantity(amount) {
    if (!this.quantityInput) return;

    const currentQuantity = Number(this.quantityInput.value) || 1;
    const newQuantity = Math.max(1, currentQuantity + amount);

    this.quantityInput.value = String(newQuantity);
  }

  async addCurrentProductToCart(event = null, goToCheckout = false) {
    event?.preventDefault();

    if (!this.currentVariant?.available) {
      this.stockEnquiry?.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });

      return;
    }

    const quantity = Math.max(
      1,
      Number(this.quantityInput?.value) || 1
    );

    const originalButtonText =
      this.addToCartText?.textContent || 'Add to cart';

    try {
      this.setAddButtonLoading(true, 'Adding…');

      await this.addCartItems([
        {
          id: this.currentVariant.id,
          quantity
        }
      ]);

      if (goToCheckout) {
        window.location.href = `${window.Shopify.routes.root}checkout`;
        return;
      }

      this.setAddButtonLoading(false, 'Added ✓');

      document.dispatchEvent(
        new CustomEvent('cart:refresh', {
          bubbles: true
        })
      );

      setTimeout(() => {
        this.setAddButtonLoading(false, originalButtonText);
      }, 1800);
    } catch (error) {
      console.error('Sethi Product cart error:', error);

      this.setAddButtonLoading(
        false,
        error.message || 'Unable to add'
      );

      setTimeout(() => {
        this.setAddButtonLoading(false, originalButtonText);
      }, 2500);
    }
  }

  async addCartItems(items) {
    const response = await fetch(
      `${window.Shopify.routes.root}cart/add.js`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ items })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.description ||
          data.message ||
          'Unable to add the selected item.'
      );
    }

    return data;
  }

  setAddButtonLoading(disabled, text) {
    if (this.addToCartButton) {
      this.addToCartButton.disabled = disabled;
    }

    if (this.buyNowButton) {
      this.buyNowButton.disabled = disabled;
    }

    if (this.mobilePrimaryButton) {
      this.mobilePrimaryButton.disabled = disabled;
    }

    if (this.addToCartText && text) {
      this.addToCartText.textContent = text;
    }
  }

  toggleOffers(button) {
    const extraOffers = [
      ...this.section.querySelectorAll('[data-extra-offer]')
    ];

    const shouldShow = extraOffers.some(
      (offer) => offer.hasAttribute('hidden')
    );

    extraOffers.forEach((offer) => {
      offer.hidden = !shouldShow;
    });

    button.textContent = shouldShow ? 'Show less' : 'View all';
  }

  restoreSavedPincode() {
    if (!this.pincodeInput) return;

    try {
      const savedPincode = localStorage.getItem(
        'sethi_delivery_pincode'
      );

      if (savedPincode) {
        this.pincodeInput.value = savedPincode;
      }
    } catch (error) {
      console.warn('Unable to restore pincode.', error);
    }
  }

  checkPincode() {
    if (!this.pincodeInput || !this.deliveryResult) return;

    const pincode = this.pincodeInput.value.trim();

    this.deliveryResult.hidden = false;
    this.deliveryResult.classList.remove('is-error');

    if (!/^[1-9][0-9]{5}$/.test(pincode)) {
      this.deliveryResult.classList.add('is-error');
      this.deliveryResult.textContent =
        'Please enter a valid six-digit Indian pincode.';
      return;
    }

    try {
      localStorage.setItem('sethi_delivery_pincode', pincode);
    } catch (error) {
      console.warn('Unable to save pincode.', error);
    }

    const deliveryDays = this.getEstimatedDeliveryDays(pincode);
    const deliveryDate = this.addWorkingDays(
      new Date(),
      deliveryDays
    );

    const formattedDate = deliveryDate.toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });

    this.deliveryResult.innerHTML = `
      <strong>Estimated delivery by ${formattedDate}</strong><br>
      Free insured shipping is currently available for pincode ${pincode}.
    `;
  }

  getEstimatedDeliveryDays(pincode) {
    const firstTwoDigits = Number(pincode.slice(0, 2));

    if (firstTwoDigits >= 11 && firstTwoDigits <= 20) {
      return 2;
    }

    if (firstTwoDigits >= 21 && firstTwoDigits <= 50) {
      return 3;
    }

    return 5;
  }

  addWorkingDays(startDate, workingDays) {
    const result = new Date(startDate);
    let addedDays = 0;

    while (addedDays < workingDays) {
      result.setDate(result.getDate() + 1);

      const day = result.getDay();

      if (day !== 0) {
        addedDays += 1;
      }
    }

    return result;
  }

    formatMoney(cents) {
    const currency =
      window.Shopify?.currency?.active || 'INR';

    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0
    }).format(Number(cents) / 100);
  }

  updateBundleSummary() {
    if (!this.bundleCount || !this.bundleTotal) return;

    const mainPrice = Number(this.currentVariant?.price || 0);

    const selectedCheckboxes = this.bundleCheckboxes.filter(
      (checkbox) => checkbox.checked
    );

    const accessoriesTotal = selectedCheckboxes.reduce(
      (total, checkbox) => {
        const card = checkbox.closest('[data-bundle-item]');
        const price = Number(card?.dataset.price || 0);

        return total + price;
      },
      0
    );

    const totalItems = 1 + selectedCheckboxes.length;
    const totalPrice = mainPrice + accessoriesTotal;

    this.bundleCount.textContent = String(totalItems);
    this.bundleTotal.textContent = this.formatMoney(totalPrice);
  }

  async addSelectedBundle() {
    if (!this.currentVariant?.available || !this.addBundleButton) return;

    const selectedItems = [
      {
        id: this.currentVariant.id,
        quantity: 1
      }
    ];

    this.bundleCheckboxes
      .filter((checkbox) => checkbox.checked)
      .forEach((checkbox) => {
        selectedItems.push({
          id: Number(checkbox.value),
          quantity: 1
        });
      });

    const originalText = this.addBundleButton.textContent;

    try {
      this.addBundleButton.disabled = true;
      this.addBundleButton.textContent = 'Adding bundle…';

      await this.addCartItems(selectedItems);

      this.addBundleButton.textContent = 'Bundle added ✓';

      if (this.bundleMessage) {
        this.bundleMessage.textContent =
          `${selectedItems.length} items were added to your cart.`;
      }

      document.dispatchEvent(
        new CustomEvent('cart:refresh', {
          bubbles: true
        })
      );

      setTimeout(() => {
        this.addBundleButton.textContent = originalText;
        this.addBundleButton.disabled = false;
      }, 1800);
    } catch (error) {
      console.error('Bundle error:', error);

      this.addBundleButton.textContent = 'Unable to add bundle';

      if (this.bundleMessage) {
        this.bundleMessage.textContent =
          error.message || 'Please try again.';
      }

      setTimeout(() => {
        this.addBundleButton.textContent = originalText;
        this.addBundleButton.disabled = false;
      }, 2500);
    }
  }

  submitStockEnquiry(notificationOnly = false) {
    const name = this.enquiryName?.value.trim();
    const phone = this.enquiryPhone?.value.trim();
    const email = this.enquiryEmail?.value.trim();

    if (!name) {
      this.showEnquiryMessage('Please enter your name.');
      return;
    }

    if (!/^[6-9][0-9]{9}$/.test(phone || '')) {
      this.showEnquiryMessage(
        'Please enter a valid 10-digit phone number.'
      );
      return;
    }

    if (email && !this.isValidEmail(email)) {
      this.showEnquiryMessage('Please enter a valid email address.');
      return;
    }

    const enquiryType = notificationOnly
      ? 'Back-in-stock notification request'
      : 'Out-of-stock product enquiry';

    const message = [
      enquiryType,
      '',
      `Product: ${this.currentProduct.title || document.title}`,
      `Variant ID: ${this.currentVariant?.id || ''}`,
      `Name: ${name}`,
      `Phone: ${phone}`,
      `Email: ${email || 'Not provided'}`,
      `Page: ${window.location.href}`
    ].join('\n');

    this.openWhatsApp(message);

    this.showEnquiryMessage(
      'Your enquiry is ready. Please send the WhatsApp message.'
    );
  }

  showEnquiryMessage(message) {
    if (this.enquiryMessage) {
      this.enquiryMessage.textContent = message;
    }
  }

  openContactDialog(type, heading) {
    this.contactType = type;

    if (this.contactEyebrow) {
      this.contactEyebrow.textContent = type;
    }

    if (this.contactHeading) {
      this.contactHeading.textContent = heading;
    }

    if (this.contactMessageInput) {
      this.contactMessageInput.value =
        `I need assistance with ${this.currentProduct.title || 'this watch'}.`;
    }

    if (this.contactStatus) {
      this.contactStatus.textContent = '';
    }

    this.openDialog(this.contactDialog);
  }

  submitContactRequest() {
    const name = this.contactName?.value.trim();
    const phone = this.contactPhone?.value.trim();
    const email = this.contactEmail?.value.trim();
    const customerMessage = this.contactMessageInput?.value.trim();

    if (!name) {
      this.showContactStatus('Please enter your name.');
      return;
    }

    if (!/^[6-9][0-9]{9}$/.test(phone || '')) {
      this.showContactStatus(
        'Please enter a valid 10-digit phone number.'
      );
      return;
    }

    if (email && !this.isValidEmail(email)) {
      this.showContactStatus('Please enter a valid email address.');
      return;
    }

    const message = [
      this.contactType,
      '',
      `Product: ${this.currentProduct.title || document.title}`,
      `Name: ${name}`,
      `Phone: ${phone}`,
      `Email: ${email || 'Not provided'}`,
      `Message: ${customerMessage || 'No additional message'}`,
      `Page: ${window.location.href}`
    ].join('\n');

    this.openWhatsApp(message);

    this.showContactStatus(
      'Your request is ready. Please send the WhatsApp message.'
    );
  }

  showContactStatus(message) {
    if (this.contactStatus) {
      this.contactStatus.textContent = message;
    }
  }

  isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  getWhatsAppNumber() {
    const whatsappLink = this.section.querySelector(
      '[data-whatsapp-link]'
    );

    if (!whatsappLink) return '';

    const match = whatsappLink.href.match(/wa\.me\/([0-9]+)/);

    return match ? match[1] : '';
  }

  openWhatsApp(message) {
    const number = this.getWhatsAppNumber();

    if (!number) {
      this.showContactStatus(
        'WhatsApp number is not configured in the Theme Editor.'
      );

      this.showEnquiryMessage(
        'WhatsApp number is not configured in the Theme Editor.'
      );

      return;
    }

    const url =
      `https://wa.me/${number}?text=${encodeURIComponent(message)}`;

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  openDialog(dialog) {
    if (!dialog) return;

    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
      return;
    }

    dialog.setAttribute('open', '');
  }

  async shareProduct() {
    const shareData = {
      title: this.currentProduct.title || document.title,
      text: `View ${this.currentProduct.title || 'this watch'}`,
      url: window.location.href
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }

      await navigator.clipboard.writeText(window.location.href);

      const shareButton = this.section.querySelector(
        '[data-share-product]'
      );

      if (shareButton) {
        const originalText = shareButton.textContent;

        shareButton.textContent = 'Link copied';

        setTimeout(() => {
          shareButton.textContent = originalText;
        }, 1600);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('Unable to share product.', error);
      }
    }
  }

  toggleWishlist(button) {
    const productId = String(this.currentProduct.id || '');

    if (!productId) return;

    const wishlist = this.readStorageArray('sethi_wishlist');
    const alreadyAdded = wishlist.includes(productId);

    const updatedWishlist = alreadyAdded
      ? wishlist.filter((id) => id !== productId)
      : [...wishlist, productId];

    this.writeStorageArray('sethi_wishlist', updatedWishlist);

    this.section
      .querySelectorAll('[data-wishlist-button]')
      .forEach((wishlistButton) => {
        wishlistButton.classList.toggle('is-active', !alreadyAdded);
        wishlistButton.setAttribute(
          'aria-pressed',
          String(!alreadyAdded)
        );
      });

    if (button) {
      const originalText = button.dataset.originalText ||
        button.textContent.trim();

      button.dataset.originalText = originalText;

      if (button.closest('.sethi-gallery__stage')) {
        button.innerHTML = !alreadyAdded
          ? '<span aria-hidden="true">♥</span>'
          : '<span aria-hidden="true">♡</span>';
      } else {
        button.textContent = !alreadyAdded
          ? '♥ Added to wishlist'
          : '♡ Wishlist';
      }
    }
  }

  toggleCompare(button) {
    const productId = String(this.currentProduct.id || '');

    if (!productId) return;

    const compareProducts = this.readStorageArray('sethi_compare');
    const alreadyAdded = compareProducts.includes(productId);

    let updatedCompare;

    if (alreadyAdded) {
      updatedCompare = compareProducts.filter(
        (id) => id !== productId
      );
    } else {
      if (compareProducts.length >= 4) {
        button.textContent = 'Maximum 4 watches';

        setTimeout(() => {
          button.textContent = '⇄ Compare';
        }, 1800);

        return;
      }

      updatedCompare = [...compareProducts, productId];
    }

    this.writeStorageArray('sethi_compare', updatedCompare);

    button.classList.toggle('is-active', !alreadyAdded);
    button.textContent = !alreadyAdded
      ? `✓ Added to compare (${updatedCompare.length})`
      : '⇄ Compare';
  }

  readStorageArray(key) {
    try {
      const storedValue = localStorage.getItem(key);
      const parsedValue = storedValue
        ? JSON.parse(storedValue)
        : [];

      return Array.isArray(parsedValue) ? parsedValue : [];
    } catch (error) {
      console.warn(`Unable to read ${key}.`, error);
      return [];
    }
  }

  writeStorageArray(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn(`Unable to save ${key}.`, error);
    }
  }

  saveRecentlyViewedProduct() {
    if (!this.currentProduct?.id) return;

    try {
      const storedProducts = localStorage.getItem(
        'sethi_recently_viewed'
      );

      const recentlyViewed = storedProducts
        ? JSON.parse(storedProducts)
        : [];

      const filteredProducts = Array.isArray(recentlyViewed)
        ? recentlyViewed.filter(
            (item) =>
              String(item.id) !== String(this.currentProduct.id)
          )
        : [];

      filteredProducts.unshift(this.currentProduct);

      localStorage.setItem(
        'sethi_recently_viewed',
        JSON.stringify(filteredProducts.slice(0, 8))
      );
    } catch (error) {
      console.warn('Unable to save recently viewed product.', error);
    }
  }

  renderRecentlyViewedProducts() {
    if (
      !this.recentlyViewedContainer ||
      !this.recentlyViewedSection
    ) {
      return;
    }

    try {
      const storedProducts = localStorage.getItem(
        'sethi_recently_viewed'
      );

      const recentlyViewed = storedProducts
        ? JSON.parse(storedProducts)
        : [];

      const productsToRender = Array.isArray(recentlyViewed)
        ? recentlyViewed.filter(
            (item) =>
              String(item.id) !== String(this.currentProduct.id)
          )
        : [];

      if (!productsToRender.length) {
        this.recentlyViewedSection.hidden = true;
        return;
      }

      this.recentlyViewedContainer.innerHTML =
        productsToRender
          .slice(0, 4)
          .map((product) => this.createProductCard(product))
          .join('');

      this.recentlyViewedSection.hidden = false;
    } catch (error) {
      console.warn('Unable to render recently viewed products.', error);
    }
  }

  async loadRecommendations() {
    if (!this.recommendationsContainer) return;

    const productId =
      this.recommendationsContainer.dataset.productId;

    const limit =
      this.recommendationsContainer.dataset.limit || 8;

    if (!productId) return;

    try {
      const endpoint =
        `${window.Shopify.routes.root}` +
        `recommendations/products.json` +
        `?product_id=${encodeURIComponent(productId)}` +
        `&limit=${encodeURIComponent(limit)}` +
        `&intent=related`;

      const response = await fetch(endpoint, {
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Unable to load product recommendations.');
      }

      const data = await response.json();
      const products = data.products || [];

      if (!products.length) {
        this.recommendationsContainer.innerHTML =
          '<div class="sethi-product-slider__loading">No recommendations available yet.</div>';
        return;
      }

      this.recommendationsContainer.innerHTML = products
        .map((product) => this.createProductCard(product))
        .join('');
    } catch (error) {
      console.warn('Recommendations error:', error);

      this.recommendationsContainer.innerHTML =
        '<div class="sethi-product-slider__loading">Recommendations are currently unavailable.</div>';
    }
  }

  async loadSameBrandProducts() {
    if (!this.sameBrandContainer) return;

    const vendor = this.sameBrandContainer.dataset.vendor;
    const currentProductId =
      this.sameBrandContainer.dataset.currentProduct;

    if (!vendor) return;

    try {
      const endpoint =
        `${window.Shopify.routes.root}search/suggest.json` +
        `?q=${encodeURIComponent(vendor)}` +
        `&resources[type]=product` +
        `&resources[limit]=8` +
        `&resources[options][unavailable_products]=hide`;

      const response = await fetch(endpoint, {
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Unable to load same-brand products.');
      }

      const data = await response.json();

      const products =
        data.resources?.results?.products || [];

      const filteredProducts = products.filter(
        (product) =>
          String(product.id) !== String(currentProductId)
      );

      if (!filteredProducts.length) {
        this.sameBrandContainer.innerHTML =
          '<div class="sethi-product-slider__loading">No additional watches from this brand are currently available.</div>';
        return;
      }

      this.sameBrandContainer.innerHTML = filteredProducts
        .slice(0, 8)
        .map((product) => this.createProductCard(product))
        .join('');
    } catch (error) {
      console.warn('Same-brand products error:', error);

      this.sameBrandContainer.innerHTML =
        '<div class="sethi-product-slider__loading">Brand products are currently unavailable.</div>';
    }
  }

  createProductCard(product) {
    const title = this.escapeHTML(product.title || '');
    const vendor = this.escapeHTML(product.vendor || '');
    const url = this.normalizeProductURL(product.url || '#');

    const image =
      product.image ||
      product.featured_image?.url ||
      product.featured_image ||
      '';

    const price = this.resolveProductPrice(product);

    return `
      <article class="sethi-slider-product-card">
        <a
          href="${url}"
          class="sethi-slider-product-card__image"
          aria-label="${title}"
        >
          ${
            image
              ? `<img src="${this.escapeAttribute(image)}" alt="${title}" loading="lazy">`
              : ''
          }
        </a>

        <div class="sethi-slider-product-card__details">
          <span class="sethi-slider-product-card__vendor">
            ${vendor}
          </span>

          <a
            href="${url}"
            class="sethi-slider-product-card__title"
          >
            ${title}
          </a>

          <strong class="sethi-slider-product-card__price">
            ${this.formatMoney(price)}
          </strong>
        </div>
      </article>
    `;
  }

  resolveProductPrice(product) {
    if (typeof product.price === 'number') {
      return product.price;
    }

    if (typeof product.price === 'string') {
      const numericPrice = Number(
        product.price.replace(/[^0-9.]/g, '')
      );

      if (Number.isFinite(numericPrice)) {
        return Math.round(numericPrice * 100);
      }
    }

    if (typeof product.price_min === 'number') {
      return product.price_min;
    }

    return 0;
  }

  normalizeProductURL(url) {
    if (!url) return '#';

    if (
      url.startsWith('http://') ||
      url.startsWith('https://')
    ) {
      return url;
    }

    if (url.startsWith('/')) {
      return url;
    }

    return `${window.Shopify.routes.root}${url}`;
  }

  escapeHTML(value) {
    const element = document.createElement('div');

    element.textContent = String(value);

    return element.innerHTML;
  }

  escapeAttribute(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }
}

function initializeSethiCompleteProducts(container = document) {
  container
    .querySelectorAll('[data-sethi-product]')
    .forEach((section) => {
      if (section.dataset.sethiInitialized === 'true') return;

      section.dataset.sethiInitialized = 'true';

      const productPage = new SethiCompleteProduct(section);

      productPage.saveRecentlyViewedProduct();
      productPage.renderRecentlyViewedProducts();
      productPage.loadRecommendations();
      productPage.loadSameBrandProducts();
    });
}

document.addEventListener('DOMContentLoaded', () => {
  initializeSethiCompleteProducts();
});

document.addEventListener('shopify:section:load', (event) => {
  initializeSethiCompleteProducts(event.target);
});