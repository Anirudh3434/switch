# Privacy Policy for Switch

*Last Updated: October 27, 2026*

## Introduction

Switch ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains how our browser extension and backend service work.

## Zero-Knowledge Architecture

Switch is built on a **zero-knowledge** principle:
- **We cannot see your data**: All session data (cookies, localStorage) is encrypted on your device before leaving it. We never have access to your encryption keys.
- **Client-side encryption**: Your master password is used to derive encryption keys locally. These keys never leave your device.
- **Server stores only ciphertext**: Our backend only stores encrypted blobs that are meaningless without your keys.

## What We Collect

### Information We Do NOT Collect
- We do not collect your passwords
- We do not collect your cookies or session tokens in plaintext
- We do not collect your browsing history
- We do not track your activity across websites

### Information We May Collect
- **Account Information**: Email address for authentication (stored on our backend)
- **Device Information**: Device ID and browser information for multi-device management
- **Usage Data**: Basic error logs (with no sensitive data) for service improvement
- **IP Address**: For rate limiting and security purposes

## How We Use Your Information

- To authenticate your account
- To sync encrypted session data across your devices (if using our backend)
- To prevent abuse and ensure security
- To provide customer support

## Data Storage and Security

- **Local Storage**: All session data is encrypted at rest using AES-256-GCM
- **Transmission**: All data is transmitted over HTTPS
- **Backend**: Encrypted blobs are stored in MongoDB; we cannot decrypt them
- **Keys**: Your encryption keys are derived from your password and never sent to our servers

## Your Rights (GDPR & DPDP Compliance)

You have the right to:
- **Access**: Request a copy of your data
- **Deletion**: Delete your account and all associated data
- **Portability**: Export your encrypted data
- **Withdraw Consent**: Revoke access at any time

To exercise these rights, contact us or use the deletion options in the extension.

## Third-Party Services

- **MongoDB**: For storing encrypted data (if using our hosted backend)
- **SMTP Provider**: For sending OTP emails (email addresses only)

## Changes to This Policy

We may update this Privacy Policy from time to time. We will notify you of any changes by updating the "Last Updated" date.

## Contact

For questions about this Privacy Policy, please contact the development team.
