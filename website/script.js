// Switch Promotional Simulator Script
document.addEventListener('DOMContentLoaded', () => {
  // -------------------------------------------------------------------------
  // Operator-configurable site values (see config.js).
  // The committed defaults are placeholders; this keeps a personal address or
  // an unverified legal identity from being hard-coded into twenty places.
  // -------------------------------------------------------------------------
  const SITE = Object.assign(
    {
      apiBaseUrl: '',
      contactEmail: 'contact@your-domain.example',
      donationUpi: '',
      donationUpiName: '',
      donationQrImage: '',
      legalEntity: '[Legal entity name — not yet configured]',
      governingLaw: '[Governing law / jurisdiction — not yet configured]',
      privacyContact: 'privacy@your-domain.example',
      securityContact: 'security@your-domain.example',
    },
    window.SWITCH_SITE || {},
  );

  function applySiteConfig() {
    const EMAIL_PLACEHOLDER = 'contact@your-domain.example';
    const UPI_PLACEHOLDER = 'your-vpa@bank';

    // Rewrite every mailto link, preserving any pre-set subject.
    document.querySelectorAll('a[href*="mailto:"]').forEach((el) => {
      const href = el.getAttribute('href') || '';
      if (!href.includes(EMAIL_PLACEHOLDER)) return;
      el.setAttribute('href', href.split(EMAIL_PLACEHOLDER).join(SITE.contactEmail));
    });

    // Replace visible placeholder text anywhere on the page (footer, support,
    // donation box, inline copy). This keeps one source of truth in config.js.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => {
      const value = node.nodeValue || '';
      if (value.includes(EMAIL_PLACEHOLDER) || value.includes(UPI_PLACEHOLDER)) {
        node.nodeValue = value
          .split(EMAIL_PLACEHOLDER)
          .join(SITE.contactEmail)
          .split(UPI_PLACEHOLDER)
          .join(SITE.donationUpi);
      }
    });

    document.querySelectorAll('[data-site-legal-entity]').forEach((el) => {
      el.textContent = SITE.legalEntity;
    });
    document.querySelectorAll('[data-site-privacy-contact]').forEach((el) => {
      el.textContent = SITE.privacyContact;
    });
    document.querySelectorAll('[data-site-security-contact]').forEach((el) => {
      el.textContent = SITE.securityContact;
    });
    document.querySelectorAll('[data-site-governing-law]').forEach((el) => {
      el.textContent = SITE.governingLaw;
    });

    // Only render a donation QR when the operator supplies a local image.
    // Never call a third-party QR service from a privacy-focused site.
    const qrWrap = document.getElementById('donateQrWrap');
    if (qrWrap && SITE.donationQrImage) {
      qrWrap.innerHTML = '';
      const img = document.createElement('img');
      img.src = SITE.donationQrImage;
      img.alt = `UPI QR code for ${SITE.donationUpi}`;
      img.className = 'qr-code-img';
      img.width = 200;
      img.height = 200;
      qrWrap.appendChild(img);
    }

    // A blank VPA means "not configured": hide the payment surface instead of
    // showing a QR that cannot be paid. A placeholder address must never be
    // displayed as if it were real.
    if (!SITE.donationUpi) {
      document.querySelectorAll('.donate-stage, .donate-card, .upi-box, .donate-qr-frame').forEach((el) => {
        el.hidden = true;
      });
      const notice = document.getElementById('donateNotConfigured');
      if (notice) notice.hidden = false;
    }
  }

  applySiteConfig();

  const btnTriggerSwap = document.getElementById('btnTriggerSwap');
  const animStage = document.getElementById('animStage');
  const slabOld = document.getElementById('slabOld');
  const slabNew = document.getElementById('slabNew');
  const demoToastTitle = document.getElementById('demoToastTitle');
  const demoToastBody = document.getElementById('demoToastBody');
  const btnSwapText = document.getElementById('btnSwapText');
  const btnDismissDemo = document.getElementById('btnDismissDemo');
  const btnNotNowDemo = document.getElementById('btnNotNowDemo');
  const toastWrapper = document.getElementById('toastWrapper');

  let isSwappedState = false;

  function runSwapCycle() {
    btnTriggerSwap.disabled = true;
    btnSwapText.textContent = isSwappedState ? 'Restoring…' : 'Switching…';

    // 1. Reveal Holographic Animation Modal
    setTimeout(() => {
      animStage.classList.add('active');
      slabOld.classList.add('ejected');
      slabNew.classList.add('docked');
    }, 180);

    // 2. Play through complete 2.1s key transfer lifecycle
    setTimeout(() => {
      animStage.classList.remove('active');
      slabOld.classList.remove('ejected');
      slabNew.classList.remove('docked');
      btnTriggerSwap.disabled = false;

      // Toggle state representation
      isSwappedState = !isSwappedState;

      if (isSwappedState) {
        demoToastTitle.textContent = 'Swapped Session';
        demoToastBody.innerHTML = 'Running active session from <strong>Chrome 155 · Windows 10/11</strong>.';
        btnSwapText.textContent = 'Restore Original Cookies';
      } else {
        demoToastTitle.textContent = 'Swap Session Available';
        demoToastBody.innerHTML = 'Active session available from <strong>Chrome 155 · Windows 10/11</strong> (17 tokens).';
        btnSwapText.textContent = 'Swap Session';
      }
    }, 2100);
  }

  if (btnTriggerSwap) {
    btnTriggerSwap.addEventListener('click', runSwapCycle);
  }

  // Dismiss & Reset
  function resetDemo() {
    toastWrapper.style.opacity = '0';
    toastWrapper.style.transform = 'translateY(12px)';
    setTimeout(() => {
      isSwappedState = false;
      demoToastTitle.textContent = 'Swap Session Available';
      demoToastBody.innerHTML = 'Active session available from <strong>Chrome 155 · Windows 10/11</strong> (17 tokens).';
      btnSwapText.textContent = 'Swap Session';
      toastWrapper.style.opacity = '1';
      toastWrapper.style.transform = 'translateY(0)';
    }, 600);
  }

  if (btnDismissDemo) btnDismissDemo.addEventListener('click', resetDemo);
  if (btnNotNowDemo) btnNotNowDemo.addEventListener('click', resetDemo);

  // Copy UPI ID to clipboard
  const copyUpiBtn = document.getElementById('copyUpiBtn');
  const copyUpiText = document.getElementById('copyUpiText');
  if (copyUpiBtn) {
    copyUpiBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(SITE.donationUpi);
        copyUpiText.textContent = 'Copied!';
        copyUpiBtn.classList.add('copied');
        copyUpiBtn.style.color = '#10b981';
        setTimeout(() => {
          copyUpiText.textContent = 'Copy';
          copyUpiBtn.classList.remove('copied');
          copyUpiBtn.style.color = '';
        }, 2000);
      } catch (err) {
        // Fallback: select the text so the user can copy it manually.
        const target = document.getElementById('upiAddressText');
        if (target) {
          const range = document.createRange();
          range.selectNode(target);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        }
        copyUpiText.textContent = 'Selected!';
      }
    });
  }

  // Scroll Reveal Observer for Text & Cards
  const revealTargets = document.querySelectorAll(
    '.reveal-on-scroll, .section-lead, .arch-card, .fleet-card, .donate-card'
  );

  if ('IntersectionObserver' in window) {
    const observerOptions = {
      root: null,
      threshold: 0.12,
      rootMargin: '0px 0px -40px 0px'
    };

    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    }, observerOptions);

    revealTargets.forEach(el => {
      el.classList.add('reveal-on-scroll');
      revealObserver.observe(el);
    });
  } else {
    // Fallback for older browsers
    revealTargets.forEach(el => el.classList.add('revealed'));
  }

  // =========================================================================
  // Smart Browser Detection for Download Page
  // =========================================================================
  const detectedName = document.getElementById('detectedName');
  const detectedDesc = document.getElementById('detectedDesc');
  const detectedBtn = document.getElementById('detectedBtn');
  const detectedBtnText = document.getElementById('detectedBtnText');
  const detectedSpriteIcon = document.getElementById('detectedSpriteIcon');

  if (detectedName && detectedBtn) {
    const ua = navigator.userAgent;
    const DEV_BUILD = {
      btnText: 'Developer build — load unpacked',
      url: '#install-dev',
    };
    let browser = {
      name: 'Google Chrome',
      posClass: 'chrome-pos',
      desc: 'Switch targets Chromium browsers. Chrome is the primary development target.',
      ...DEV_BUILD,
    };

    if (/Edg/i.test(ua)) {
      browser = {
        name: 'Microsoft Edge',
        posClass: 'edge-pos',
        desc: 'Edge is Chromium-based and can load the same unpacked developer build.',
        ...DEV_BUILD,
      };
    } else if ((navigator.brave && navigator.brave.isBrave) || /Brave/i.test(ua)) {
      browser = {
        name: 'Brave Browser',
        posClass: 'brave-pos',
        desc: 'Brave is Chromium-based; Brave Shields may affect third-party cookie behaviour on some sites.',
        ...DEV_BUILD,
      };
    } else if (/Firefox/i.test(ua)) {
      browser = {
        name: 'Mozilla Firefox',
        posClass: 'firefox-pos',
        desc: 'Firefox is not supported yet. Switch uses Chromium extension APIs and ships no Gecko build.',
        btnText: 'See the roadmap',
        url: '#roadmap',
      };
    } else if (/Arc/i.test(ua)) {
      browser = {
        name: 'Arc Browser',
        posClass: 'arc-pos',
        desc: 'Arc is Chromium-based and can load the unpacked developer build.',
        ...DEV_BUILD,
      };
    } else if (/OPR|Opera/i.test(ua)) {
      browser = {
        name: 'Opera Browser',
        posClass: 'chrome-pos',
        desc: 'Opera is Chromium-based and can load the unpacked developer build.',
        ...DEV_BUILD,
      };
    }

    // Apply detected browser
    detectedName.textContent = browser.name;
    detectedDesc.textContent = browser.desc;
    detectedBtnText.textContent = browser.btnText;
    detectedBtn.href = browser.url;
    if (detectedSpriteIcon) {
      detectedSpriteIcon.className = `browser-sprite-icon-lg ${browser.posClass}`;
    }
  }

  // =========================================================================
  // Interactive FAQ Accordion for Support Page
  // =========================================================================
  const faqTriggers = document.querySelectorAll('.faq-trigger');
  faqTriggers.forEach(trigger => {
    trigger.addEventListener('click', () => {
      const parentCard = trigger.closest('.faq-card');
      const isCurrentlyOpen = parentCard.classList.contains('open');

      // Close all other accordions for clean UX
      document.querySelectorAll('.faq-card').forEach(c => {
        c.classList.remove('open');
        const btn = c.querySelector('.faq-trigger');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });

      if (!isCurrentlyOpen) {
        parentCard.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // =========================================================================
  // Copy support email address
  // =========================================================================
  const copyEmailBtn = document.getElementById('copyEmailBtn');
  const copyEmailText = document.getElementById('copyEmailText');
  if (copyEmailBtn) {
    copyEmailBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(SITE.contactEmail);
        copyEmailText.textContent = 'Copied!';
        copyEmailBtn.classList.add('copied');
        copyEmailBtn.style.color = '#10b981';
        setTimeout(() => {
          copyEmailText.textContent = 'Copy';
          copyEmailBtn.classList.remove('copied');
          copyEmailBtn.style.color = '';
        }, 2000);
      } catch (err) {
        const emailEl = document.getElementById('supportEmailText');
        if (emailEl) {
          const range = document.createRange();
          range.selectNode(emailEl);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        }
        copyEmailText.textContent = 'Selected!';
      }
    });
  }



  // =========================================================================
  // Mobile Navigation Drawer Toggle
  // =========================================================================
  const mobileMenuToggle = document.getElementById('mobileMenuToggle');
  const mobileNavDrawer = document.getElementById('mobileNavDrawer');
  if (mobileMenuToggle && mobileNavDrawer) {
    mobileMenuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = mobileNavDrawer.classList.contains('open');
      mobileMenuToggle.classList.toggle('active');
      mobileNavDrawer.classList.toggle('open');
      mobileMenuToggle.setAttribute('aria-expanded', !isOpen);
    });

    // Close mobile drawer when clicking a link inside it
    const drawerLinks = mobileNavDrawer.querySelectorAll('a');
    drawerLinks.forEach(link => {
      link.addEventListener('click', () => {
        mobileMenuToggle.classList.remove('active');
        mobileNavDrawer.classList.remove('open');
        mobileMenuToggle.setAttribute('aria-expanded', 'false');
      });
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!mobileNavDrawer.contains(e.target) && !mobileMenuToggle.contains(e.target)) {
        mobileMenuToggle.classList.remove('active');
        mobileNavDrawer.classList.remove('open');
        mobileMenuToggle.setAttribute('aria-expanded', 'false');
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mobileNavDrawer.classList.contains('open')) {
        mobileMenuToggle.classList.remove('active');
        mobileNavDrawer.classList.remove('open');
        mobileMenuToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // =========================================================================
  // Smooth Back-to-Top Action
  // =========================================================================
  const backToTopBtn = document.getElementById('backToTopBtn');
  if (backToTopBtn) {
    backToTopBtn.addEventListener('click', () => {
      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    });
  }

  // =========================================================================
  // Minimal Feedback Popup Modal Logic (Bug, Improvement, Suggestion)
  // =========================================================================
  const feedbackModal = document.getElementById('feedbackModal');
  const openFeedbackModalBtn = document.getElementById('openFeedbackModalBtn');
  const feedbackModalCloseBtn = document.getElementById('feedbackModalCloseBtn');
  const modalCloseSuccessBtn = document.getElementById('modalCloseSuccessBtn');
  const modalFormView = document.getElementById('modalFormView');
  const modalSuccessView = document.getElementById('modalSuccessView');

  const feedbackForm = document.getElementById('feedbackForm');
  const feedbackTypeChips = document.querySelectorAll('.modal-type-chip');
  const feedbackDescription = document.getElementById('feedbackDescription');
  const feedbackCharCounter = document.getElementById('feedbackCharCounter');
  const feedbackSubmitBtn = document.getElementById('feedbackSubmitBtn');
  const feedbackSpinner = document.getElementById('feedbackSpinner');
  const feedbackError = document.getElementById('feedbackError');
  const feedbackResetBtn = document.getElementById('feedbackResetBtn');
  const modalHeaderBadgeText = document.getElementById('modalHeaderBadgeText');

  // Success view elements
  const successSmileyFace = document.getElementById('successSmileyFace');
  const modalSmileyHalo = document.getElementById('modalSmileyHalo');
  const successDynamicTag = document.getElementById('successDynamicTag');
  const successDynamicMessage = document.getElementById('successDynamicMessage');

  const typeConfigs = {
    bug: {
      label: 'Bug Report',
      icon: '🐞',
      badgeText: 'Bug Report Logged 🐞',
      headerBadge: 'Bug Report',
      smiley: '😊',
      haloBorder: 'rgba(244, 63, 94, 0.6)',
      haloShadow: '0 6px 20px rgba(0, 0, 0, 0.5), 0 0 24px rgba(244, 63, 94, 0.4)',
      tagColor: '#fda4af',
      tagBg: 'rgba(244, 63, 94, 0.12)',
      tagBorder: 'rgba(244, 63, 94, 0.35)',
      message: 'Thank you for reporting this bug! Our team will investigate and squash it right away.',
      placeholder: 'Describe what happened: steps to reproduce or browser version...'
    },
    improvement: {
      label: 'Improvement',
      icon: '🚀',
      badgeText: 'Improvement Logged 🚀',
      headerBadge: 'Improvement',
      smiley: '🚀',
      haloBorder: 'rgba(56, 189, 248, 0.6)',
      haloShadow: '0 6px 20px rgba(0, 0, 0, 0.5), 0 0 24px rgba(56, 189, 248, 0.4)',
      tagColor: '#7dd3fc',
      tagBg: 'rgba(14, 165, 233, 0.12)',
      tagBorder: 'rgba(14, 165, 233, 0.35)',
      message: 'Thanks for helping us level up! Your improvement request has been added to our backlog.',
      placeholder: 'What could be faster or more intuitive? Tell us your idea...'
    },
    suggestion: {
      label: 'Suggestion',
      icon: '💡',
      badgeText: 'Suggestion Received 💡',
      headerBadge: 'Suggestion',
      smiley: '💡',
      haloBorder: 'rgba(192, 132, 252, 0.6)',
      haloShadow: '0 6px 20px rgba(0, 0, 0, 0.5), 0 0 24px rgba(168, 85, 247, 0.4)',
      tagColor: '#d8b4fe',
      tagBg: 'rgba(168, 85, 247, 0.12)',
      tagBorder: 'rgba(168, 85, 247, 0.35)',
      message: 'Thank you for your inspiring suggestion! Great ideas help shape the future of Switch.',
      placeholder: 'Describe your idea, new feature concept, or browser support request...'
    }
  };

  let activeType = 'bug';

  function openFeedbackModal(preferredType) {
    if (!feedbackModal) return;
    if (preferredType && typeConfigs[preferredType]) {
      setFeedbackType(preferredType);
    }
    feedbackModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      if (feedbackDescription && modalFormView && !modalFormView.classList.contains('hidden')) {
        feedbackDescription.focus();
      }
    }, 100);
  }

  function closeFeedbackModal() {
    if (!feedbackModal) return;
    feedbackModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function setFeedbackType(type) {
    if (!typeConfigs[type]) return;
    activeType = type;
    const config = typeConfigs[type];

    feedbackTypeChips.forEach(chip => {
      chip.classList.toggle('active', chip.getAttribute('data-type') === type);
    });

    if (feedbackDescription) {
      feedbackDescription.placeholder = config.placeholder;
    }
    if (modalHeaderBadgeText) {
      modalHeaderBadgeText.textContent = config.headerBadge;
    }
  }

  if (openFeedbackModalBtn) {
    openFeedbackModalBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openFeedbackModal();
    });
  }

  // Intercept any link pointing to #feedback
  document.querySelectorAll('a[href="#feedback"], a[href$="#feedback"]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openFeedbackModal();
    });
  });

  // Auto-open modal if page loaded with #feedback hash
  if (window.location.hash === '#feedback') {
    setTimeout(() => openFeedbackModal(), 200);
  }

  if (feedbackModalCloseBtn) {
    feedbackModalCloseBtn.addEventListener('click', closeFeedbackModal);
  }
  if (modalCloseSuccessBtn) {
    modalCloseSuccessBtn.addEventListener('click', closeFeedbackModal);
  }

  // Close on backdrop click
  if (feedbackModal) {
    feedbackModal.addEventListener('click', (e) => {
      if (e.target === feedbackModal) {
        closeFeedbackModal();
      }
    });
  }

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && feedbackModal && !feedbackModal.classList.contains('hidden')) {
      closeFeedbackModal();
    }
  });

  // Chip selection
  feedbackTypeChips.forEach(chip => {
    chip.addEventListener('click', () => {
      setFeedbackType(chip.getAttribute('data-type'));
    });
  });

  // Character counter
  if (feedbackDescription && feedbackCharCounter) {
    feedbackDescription.addEventListener('input', () => {
      const len = feedbackDescription.value.length;
      feedbackCharCounter.textContent = `${len}/500`;
      feedbackCharCounter.classList.toggle('near-limit', len > 450);
    });
  }

  // Submit Handler
  if (feedbackForm) {
    feedbackForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const desc = feedbackDescription ? feedbackDescription.value.trim() : '';
      if (!desc || desc.length < 3) {
        if (feedbackDescription) {
          feedbackDescription.focus();
          feedbackDescription.classList.add('error');
          setTimeout(() => feedbackDescription.classList.remove('error'), 1200);
        }
        return;
      }

      if (feedbackSubmitBtn) {
        feedbackSubmitBtn.disabled = true;
        if (feedbackSpinner) feedbackSpinner.classList.remove('hidden');
      }
      if (feedbackError) {
        feedbackError.hidden = true;
        feedbackError.textContent = '';
      }

      const showFeedbackError = (message) => {
        if (feedbackError) {
          // Build the node tree instead of injecting server/config text as HTML.
          feedbackError.textContent = '';
          feedbackError.append(document.createTextNode(`${message} `));
          const link = document.createElement('a');
          link.href = `mailto:${SITE.contactEmail}`;
          link.textContent = SITE.contactEmail;
          feedbackError.append(document.createTextNode('You can also email '));
          feedbackError.append(link);
          feedbackError.append(document.createTextNode('.'));
          feedbackError.hidden = false;
        }
        if (feedbackSubmitBtn) feedbackSubmitBtn.disabled = false;
        if (feedbackSpinner) feedbackSpinner.classList.add('hidden');
      };

      const apiBase = String(SITE.apiBaseUrl || '').replace(/\/+$/, '');
      if (!apiBase) {
        // No endpoint configured: say so rather than faking a successful send.
        showFeedbackError('Online feedback is not configured on this deployment.');
        return;
      }

      const payload = {
        type: activeType,
        description: desc,
      };

      try {
        const res = await fetch(`${apiBase}/v1/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const reason =
            res.status === 429
              ? 'Too many submissions from this network. Try again later.'
              : body.message || `The server rejected the submission (HTTP ${res.status}).`;
          showFeedbackError(reason);
          return;
        }
      } catch (err) {
        console.warn('[switch] feedback API unreachable:', err);
        showFeedbackError('Could not reach the feedback service.');
        return;
      }

      // Do not persist feedback text in localStorage: it may contain personal
      // details, and a fake local copy is not a substitute for delivery.

      // Render Dynamic Success State
      const currentConfig = typeConfigs[activeType] || typeConfigs.bug;
      if (successSmileyFace) successSmileyFace.textContent = currentConfig.smiley;
      if (successDynamicTag) {
        successDynamicTag.textContent = currentConfig.badgeText;
        successDynamicTag.style.color = currentConfig.tagColor;
        successDynamicTag.style.background = currentConfig.tagBg;
        successDynamicTag.style.borderColor = currentConfig.tagBorder;
      }
      if (successDynamicMessage) successDynamicMessage.textContent = currentConfig.message;
      if (modalSmileyHalo) {
        modalSmileyHalo.style.borderColor = currentConfig.haloBorder;
        modalSmileyHalo.style.boxShadow = currentConfig.haloShadow;
      }

      // Switch to success view inside modal
      setTimeout(() => {
        if (modalFormView) modalFormView.classList.add('hidden');
        if (modalSuccessView) modalSuccessView.classList.remove('hidden');

        if (feedbackSubmitBtn) {
          feedbackSubmitBtn.disabled = false;
          if (feedbackSpinner) feedbackSpinner.classList.add('hidden');
        }
      }, 250);
    });
  }

  // Reset / Send another
  if (feedbackResetBtn) {
    feedbackResetBtn.addEventListener('click', () => {
      if (feedbackDescription) {
        feedbackDescription.value = '';
      }
      if (feedbackCharCounter) feedbackCharCounter.textContent = '0/500';
      setFeedbackType(activeType);

      if (modalSuccessView) modalSuccessView.classList.add('hidden');
      if (modalFormView) modalFormView.classList.remove('hidden');
      if (feedbackDescription) feedbackDescription.focus();
    });
  }
});
