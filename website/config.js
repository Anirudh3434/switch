// Switch website configuration.
//
// Everything here is an OPERATOR-SUPPLIED value. The committed defaults are
// intentionally obvious placeholders so a deployment cannot accidentally
// publish a personal address or an unverified legal identity.
//
// Before publishing the site, replace each placeholder and re-check:
//   - contactEmail          real support address you monitor
//   - donationUpi           real VPA, or leave blank to hide donation UI
//   - donationQrImage       local image path (never a third-party QR service)
//   - legalEntity           registered legal name (or "not yet incorporated")
//   - governingLaw          jurisdiction you actually operate from
//   - privacyContact        data-protection / grievance contact
//
// Run `grep -n "example" website/` after editing to confirm no placeholder is
// left in production copy.
window.SWITCH_SITE = {
  // Base URL of the Switch API used by the website feedback form. Leave this
  // empty to disable online feedback (the form will point users at the contact
  // email instead of silently pretending to send). Do not use localhost in a
  // published build.
  apiBaseUrl: '',
  contactEmail: 'contact@your-domain.example',
  donationUpi: '', // leave blank until a real merchant VPA exists
  donationUpiName: '',
  donationQrImage: '', // e.g. 'assets/donate-qr.png' — generate it locally
  legalEntity: '[Legal entity name — not yet configured]',
  governingLaw: '[Governing law / jurisdiction — not yet configured]',
  privacyContact: 'privacy@your-domain.example',
  securityContact: 'security@your-domain.example',
};
