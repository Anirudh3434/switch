// Switch Promotional Simulator Script
document.addEventListener('DOMContentLoaded', () => {
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
        await navigator.clipboard.writeText('anigokala3@oksbi');
        copyUpiText.textContent = 'Copied!';
        copyUpiBtn.classList.add('copied');
        copyUpiBtn.style.color = '#10b981';
        setTimeout(() => {
          copyUpiText.textContent = 'Copy';
          copyUpiBtn.classList.remove('copied');
          copyUpiBtn.style.color = '';
        }, 2000);
      } catch (err) {
        // Fallback
        const range = document.createRange();
        range.selectNode(document.getElementById('upiAddressText'));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
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
    let browser = {
      name: 'Google Chrome',
      posClass: 'chrome-pos',
      desc: 'Optimized for Chrome & Chromium engines. Native Manifest V3 session bridge.',
      btnText: 'Add to Chrome — Free',
      url: 'https://chromewebstore.google.com'
    };

    if (/Edg/i.test(ua)) {
      browser = {
        name: 'Microsoft Edge',
        posClass: 'edge-pos',
        desc: 'Verified for Microsoft Edge on Windows 10/11 & macOS. Enterprise session bridge.',
        btnText: 'Get Edge Add-on — Free',
        url: 'https://microsoftedge.microsoft.com/addons'
      };
    } else if (navigator.brave && navigator.brave.isBrave || /Brave/i.test(ua)) {
      browser = {
        name: 'Brave Browser',
        posClass: 'brave-pos',
        desc: 'Chromium native. Fully honors Brave Shields and private window session security.',
        btnText: 'Add to Brave — Free',
        url: 'https://chromewebstore.google.com'
      };
    } else if (/Firefox/i.test(ua)) {
      browser = {
        name: 'Mozilla Firefox',
        posClass: 'firefox-pos',
        desc: 'Tailored for Mozilla Firefox Gecko engine and multi-account container profiles.',
        btnText: 'Get Firefox Add-on — Free',
        url: 'https://addons.mozilla.org'
      };
    } else if (/Arc/i.test(ua)) {
      browser = {
        name: 'Arc Browser',
        posClass: 'arc-pos',
        desc: 'Power-user Chromium build. Seamless session handoff across custom Arc Spaces.',
        btnText: 'Add to Arc — Free',
        url: 'https://chromewebstore.google.com'
      };
    } else if (/OPR|Opera/i.test(ua)) {
      browser = {
        name: 'Opera Browser',
        posClass: 'chrome-pos',
        desc: 'Chromium-compatible engine. Install directly via Chrome Web Store.',
        btnText: 'Add to Opera — Free',
        url: 'https://chromewebstore.google.com'
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
  // Copy Support Email Address (anigokala3@gmail.com)
  // =========================================================================
  const copyEmailBtn = document.getElementById('copyEmailBtn');
  const copyEmailText = document.getElementById('copyEmailText');
  if (copyEmailBtn) {
    copyEmailBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText('anigokala3@gmail.com');
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
        const range = document.createRange();
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

      const payload = {
        type: activeType,
        description: desc,
        timestamp: new Date().toISOString()
      };

      try {
        await fetch('http://localhost:8080/v1/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (err) {
        console.warn('[switch] feedback API offline, saved locally:', err);
      }

      try {
        const existing = JSON.parse(localStorage.getItem('switch_feedback_history') || '[]');
        existing.push(payload);
        localStorage.setItem('switch_feedback_history', JSON.stringify(existing.slice(-20)));
      } catch (storageErr) {
        console.warn('[switch] localStorage write error:', storageErr);
      }

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
