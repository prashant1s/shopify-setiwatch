(() => {
  'use strict';

  const STORAGE_KEY = 'sethi-exact-compare';
  const MAX_COMPARE_ITEMS = 4;
  const FILTER_DEBOUNCE_MS = 250;

  let filterTimer = null;

  /* =========================================================
     COMPARE
     ========================================================= */

  function getStoredItems() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.warn(
        'Sethi compare data could not be read.',
        error
      );

      return [];
    }
  }

  function saveItems(items) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(
          items.slice(0, MAX_COMPARE_ITEMS)
        )
      );
    } catch (error) {
      console.warn(
        'Sethi compare data could not be saved.',
        error
      );
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function getProductFromCard(card) {
    return {
      id: card.dataset.productId || '',

      title:
        card.dataset.productTitle || '',

      vendor:
        card.dataset.productVendor || '',

      price:
        card.dataset.productPrice || '',

      compareAtPrice:
        card.dataset.productComparePrice || '',

      url:
        card.dataset.productUrl || '#',

      image:
        card.dataset.productImage || '',

      model:
        card.dataset.productModel || '',

      collection:
        card.dataset.productCollection || '',

      watchColor:
        card.dataset.productWatchColor || '',

      caseShape:
        card.dataset.productCaseShape || '',

      caseSize:
        card.dataset.productCaseSize || '',

      movement:
        card.dataset.productMovement || '',

      strapMaterial:
        card.dataset.productStrapMaterial || '',

      specification:
        card.dataset.productSpecification || '',

      warranty:
        card.dataset.productWarranty || '',

      dialColor:
        card.dataset.productDialColor || '',

      bandColor:
        card.dataset.productBandColor || '',

      caseColor:
        card.dataset.productCaseColor || '',

      material:
        card.dataset.productMaterial || '',

      watchMaterial:
        card.dataset.productWatchMaterial || '',

      targetGender:
        card.dataset.productTargetGender || '',

      ageGroup:
        card.dataset.productAgeGroup || '',

      watchDisplay:
        card.dataset.productWatchDisplay || '',

      watchFeatures:
        card.dataset.productWatchFeatures || '',

      available:
        card.dataset.productAvailable === 'true'
    };
  }

  function updateCompareCounters(items) {
    document
      .querySelectorAll('[data-compare-count]')
      .forEach((counter) => {
        counter.textContent = items.length;
      });
  }

  function updateCompareButtons(items) {
    document
      .querySelectorAll('[data-compare-product]')
      .forEach((card) => {
        const button = card.querySelector(
          '[data-compare-toggle]'
        );

        if (!button) return;

        const isSelected = items.some(
          (item) =>
            String(item.id) ===
            String(card.dataset.productId)
        );

        button.setAttribute(
          'aria-pressed',
          isSelected ? 'true' : 'false'
        );

        const productTitle =
          card.dataset.productTitle ||
          'this watch';

        button.setAttribute(
          'aria-label',
          isSelected
            ? `Remove ${productTitle} from compare`
            : `Add ${productTitle} to compare`
        );
      });
  }

  function createTrayItem(item) {
    const imageMarkup = item.image
      ? `
        <img
          src="${escapeHtml(item.image)}"
          alt="${escapeHtml(item.title)}"
          loading="lazy"
          width="42"
          height="54"
        >
      `
      : '';

    return `
      <div class="sethi-exact-compare-tray__item">
        <a
          href="${escapeHtml(item.url)}"
          title="${escapeHtml(item.title)}"
        >
          ${imageMarkup}
        </a>

        <button
          type="button"
          data-compare-remove="${escapeHtml(item.id)}"
          aria-label="Remove ${escapeHtml(item.title)} from compare"
        >
          ×
        </button>
      </div>
    `;
  }

  function updateCompareTray(items) {
    document
      .querySelectorAll('[data-compare-tray]')
      .forEach((tray) => {
        tray.hidden = items.length === 0;

        const holder = tray.querySelector(
          '[data-compare-items]'
        );

        if (holder) {
          holder.innerHTML = items
            .map(createTrayItem)
            .join('');
        }
      });
  }

  function refreshCompareInterface() {
    const items = getStoredItems();

    updateCompareCounters(items);
    updateCompareButtons(items);
    updateCompareTray(items);
  }

  function toggleCompareProduct(card) {
    if (!card) return;

    const product = getProductFromCard(card);
    const items = getStoredItems();

    const existingIndex = items.findIndex(
      (item) =>
        String(item.id) ===
        String(product.id)
    );

    if (existingIndex >= 0) {
      items.splice(existingIndex, 1);
    } else {
      if (
        items.length >=
        MAX_COMPARE_ITEMS
      ) {
        window.alert(
          `You can compare up to ${MAX_COMPARE_ITEMS} watches.`
        );

        return;
      }

      items.push(product);
    }

    saveItems(items);
    refreshCompareInterface();
  }

  function removeCompareProduct(productId) {
    const updatedItems = getStoredItems().filter(
      (item) =>
        String(item.id) !==
        String(productId)
    );

    saveItems(updatedItems);
    refreshCompareInterface();
  }

  function closeCompareTray() {
    document
      .querySelectorAll('[data-compare-tray]')
      .forEach((tray) => {
        tray.hidden = true;
      });
  }

  /* =========================================================
     MOBILE FILTER DRAWER
     ========================================================= */

  function getSidebar() {
    return document.querySelector(
      '.sethi-exact-sidebar'
    );
  }

  function openMobileFilters() {
    const sidebar = getSidebar();

    if (!sidebar) return;

    sidebar.classList.add('is-open');

    document.body.classList.add(
      'sethi-filter-drawer-open'
    );
  }

  function closeMobileFilters() {
    const sidebar = getSidebar();

    if (!sidebar) return;

    sidebar.classList.remove('is-open');

    document.body.classList.remove(
      'sethi-filter-drawer-open'
    );
  }

  function ensureMobileFilterCloseButton() {
    const sidebar = getSidebar();

    if (
      !sidebar ||
      sidebar.querySelector(
        '[data-mobile-filter-close]'
      )
    ) {
      return;
    }

    const button =
      document.createElement('button');

    button.type = 'button';

    button.className =
      'sethi-mobile-filter-close';

    button.setAttribute(
      'data-mobile-filter-close',
      ''
    );

    button.setAttribute(
      'aria-label',
      'Close filters'
    );

    button.innerHTML =
      '<span>Filters</span><b aria-hidden="true">×</b>';

    sidebar.prepend(button);
  }

  /* =========================================================
     FILTERING + SORTING
     Reliable URL-based Shopify storefront filtering
     ========================================================= */

  function getFilterForm() {
    const sidebar = getSidebar();

    if (!sidebar) return null;

    return (
      sidebar.querySelector(
        'form#FacetFiltersForm'
      ) ||
      sidebar.querySelector('form') ||
      null
    );
  }

  function isFilterParameter(name) {
    return (
      name.startsWith('filter.') ||
      name === 'filter.v.price.gte' ||
      name === 'filter.v.price.lte'
    );
  }

  function buildFilteredUrl() {
    const url = new URL(
      window.location.href
    );

    const params = new URLSearchParams(
      url.search
    );

    const filterForm = getFilterForm();

    Array.from(params.keys()).forEach(
      (key) => {
        if (
          isFilterParameter(key) ||
          key === 'page' ||
          key === 'sort_by'
        ) {
          params.delete(key);
        }
      }
    );

    if (filterForm) {
      const formData =
        new FormData(filterForm);

      for (
        const [name, rawValue]
        of formData.entries()
      ) {
        const value =
          String(rawValue).trim();

        if (!name || !value) continue;

        if (
          !isFilterParameter(name)
        ) {
          continue;
        }

        params.append(name, value);
      }
    }

    const sortSelect =
      document.querySelector(
        '#SethiSortBy'
      );

    if (
      sortSelect &&
      sortSelect.value
    ) {
      params.set(
        'sort_by',
        sortSelect.value
      );
    }

    url.search =
      params.toString();

    return url.toString();
  }

  function navigateToFilteredResults() {
    const targetUrl =
      buildFilteredUrl();

    document.documentElement
      .classList.add(
        'sethi-filter-loading'
      );

    window.location.assign(targetUrl);
  }

  function scheduleFilterNavigation() {
    window.clearTimeout(filterTimer);

    filterTimer = window.setTimeout(
      navigateToFilteredResults,
      FILTER_DEBOUNCE_MS
    );
  }

  function handleFilterChange(event) {
    const target = event.target;

    if (
      !(
        target instanceof
        HTMLInputElement
      )
    ) {
      return;
    }

    if (
      !target.closest(
        '#main-collection-filters'
      )
    ) {
      return;
    }

    if (
      !isFilterParameter(
        target.name
      )
    ) {
      return;
    }

    event.stopImmediatePropagation();

    scheduleFilterNavigation();
  }

  function handlePriceInputKeydown(
    event
  ) {
    const target = event.target;

    if (
      !(
        target instanceof
        HTMLInputElement
      )
    ) {
      return;
    }

    if (
      !target.closest(
        '#main-collection-filters'
      )
    ) {
      return;
    }

    if (
      !isFilterParameter(
        target.name
      )
    ) {
      return;
    }

    if (
      event.key !== 'Enter'
    ) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    navigateToFilteredResults();
  }

  function handleSortChange(event) {
    const target = event.target;

    if (
      !(
        target instanceof
        HTMLSelectElement
      )
    ) {
      return;
    }

    if (
      target.id !==
      'SethiSortBy'
    ) {
      return;
    }

    event.stopImmediatePropagation();

    navigateToFilteredResults();
  }

  function handleFilterFormSubmit(
    event
  ) {
    const form = event.target;

    if (
      !(
        form instanceof
        HTMLFormElement
      )
    ) {
      return;
    }

    if (
      !form.closest(
        '#main-collection-filters'
      )
    ) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    navigateToFilteredResults();
  }

  /* =========================================================
     ACTIVE FILTER REMOVE / CLEAR ALL
     ========================================================= */

  function handleActiveFilterLink(
    event
  ) {
    const link = event.target.closest(
      '#main-collection-filters .active-facets a, ' +
      '#main-collection-filters a.active-facets__button, ' +
      '#main-collection-filters .active-facets__button-remove, ' +
      '#main-collection-filters facet-remove a'
    );

    if (!link) return;

    const href =
      link.getAttribute('href');

    if (
      !href ||
      href === '#'
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    document.documentElement
      .classList.add(
        'sethi-filter-loading'
      );

    window.location.assign(href);
  }

  /* =========================================================
     SHARED EVENTS
     ========================================================= */

  function handleDocumentClick(event) {
    const compareButton =
      event.target.closest(
        '[data-compare-toggle]'
      );

    if (compareButton) {
      event.preventDefault();
      event.stopPropagation();

      const productCard =
        compareButton.closest(
          '[data-compare-product]'
        );

      toggleCompareProduct(
        productCard
      );

      return;
    }

    const compareRemoveButton =
      event.target.closest(
        '[data-compare-remove]'
      );

    if (compareRemoveButton) {
      event.preventDefault();
      event.stopPropagation();

      const removeId =
        compareRemoveButton.getAttribute(
          'data-compare-remove'
        );

      removeCompareProduct(
        removeId
      );

      return;
    }

    const compareCloseButton =
      event.target.closest(
        '[data-compare-close]'
      );

    if (compareCloseButton) {
      event.preventDefault();

      closeCompareTray();

      return;
    }

    const compareTopButton =
      event.target.closest(
        '.sethi-exact-compare-top'
      );

    if (compareTopButton) {
      event.preventDefault();

      const items =
        getStoredItems();

      if (
        items.length < 2
      ) {
        window.alert(
          'Please select at least 2 watches to compare.'
        );

        return;
      }

      window.location.href =
        '/pages/compare';

      return;
    }

    const compareNowButton =
      event.target.closest(
        '.sethi-exact-compare-tray__button'
      );

    if (compareNowButton) {
      const items =
        getStoredItems();

      if (
        items.length < 2
      ) {
        event.preventDefault();

        window.alert(
          'Please select at least 2 watches to compare.'
        );

        return;
      }
    }

    const filterOpenButton =
      event.target.closest(
        '[data-mobile-filter-open]'
      );

    if (filterOpenButton) {
      event.preventDefault();

      openMobileFilters();

      return;
    }

    const filterCloseButton =
      event.target.closest(
        '[data-mobile-filter-close]'
      );

    if (filterCloseButton) {
      event.preventDefault();

      closeMobileFilters();

      return;
    }

    const sidebar = getSidebar();

    if (
      sidebar &&
      sidebar.classList.contains(
        'is-open'
      ) &&
      !sidebar.contains(
        event.target
      ) &&
      !event.target.closest(
        '[data-mobile-filter-open]'
      )
    ) {
      closeMobileFilters();
    }
  }

  function handleEscapeKey(event) {
    if (
      event.key === 'Escape'
    ) {
      closeMobileFilters();
    }
  }

  function handleWindowResize() {
    if (
      window.innerWidth > 989
    ) {
      closeMobileFilters();
    }
  }

  function initialiseSethiCollection() {
    ensureMobileFilterCloseButton();
    refreshCompareInterface();
  }

  /* Capture phase intentionally use ki gayi hai,
     taaki Dawn facets.js custom layout ko intercept na kare. */

  document.addEventListener(
    'change',
    handleFilterChange,
    true
  );

  document.addEventListener(
    'change',
    handleSortChange,
    true
  );

  document.addEventListener(
    'submit',
    handleFilterFormSubmit,
    true
  );

  document.addEventListener(
    'keydown',
    handlePriceInputKeydown,
    true
  );

  document.addEventListener(
    'click',
    handleActiveFilterLink,
    true
  );

  document.addEventListener(
    'click',
    handleDocumentClick
  );

  document.addEventListener(
    'keydown',
    handleEscapeKey
  );

  document.addEventListener(
    'DOMContentLoaded',
    initialiseSethiCollection
  );

  document.addEventListener(
    'shopify:section:load',
    initialiseSethiCollection
  );

  document.addEventListener(
    'shopify:section:select',
    initialiseSethiCollection
  );

  document.addEventListener(
    'shopify:section:reorder',
    initialiseSethiCollection
  );

  window.addEventListener(
    'resize',
    handleWindowResize
  );

  window.addEventListener(
    'storage',
    (event) => {
      if (
        event.key === STORAGE_KEY
      ) {
        refreshCompareInterface();
      }
    }
  );

  initialiseSethiCollection();
})();