// Gmail SMTP Native Mailer for Switch
// Built with native Node.js `node:tls` — zero external dependencies, 100% reliable.
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedLogoBase64 = '';
try {
  const logoPath = path.resolve(__dirname, '../assets/logo.png');
  if (fs.existsSync(logoPath)) {
    cachedLogoBase64 = fs.readFileSync(logoPath).toString('base64');
  }
} catch (e) {
  console.warn('[switch-smtp] Could not load logo image for email:', e.message);
}

/**
 * Sends an email via Gmail SMTP using direct TLS (Port 465).
 * 
 * @param {Object} options
 * @param {string} options.host - SMTP server host (default: smtp.gmail.com)
 * @param {number} options.port - SMTP server port (default: 465)
 * @param {string} options.user - Gmail username / email address
 * @param {string} options.pass - Gmail 16-character App Password
 * @param {string} options.from - Sender address / name
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text body fallback
 */
export async function sendMailViaSmtp({
  host = 'smtp.gmail.com',
  port = 465,
  user,
  pass,
  from,
  to,
  subject,
  html,
  text,
}) {
  const senderEmail = from || user;
  const cleanPass = (pass || '').replace(/\s+/g, ''); // strip spaces in Gmail app passwords

  // If no SMTP credentials are provided, return mock success and log to console
  if (!user || !cleanPass) {
    console.log('\n========================================================');
    console.log('[SWITCH SMTP] Gmail SMTP credentials not configured in .env');
    console.log(`[SWITCH SMTP] To: ${to}`);
    console.log(`[SWITCH SMTP] Subject: ${subject}`);
    if (text) console.log(`[SWITCH SMTP] Body:\n${text}`);
    console.log('========================================================\n');
    return { ok: true, simulated: true };
  }

  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
      },
      () => {
        // Socket connected securely over TLS
      }
    );

    let step = 0;
    let buffer = '';

    const send = (cmd) => {
      socket.write(cmd + '\r\n');
    };

    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop(); // keep remainder

      for (const line of lines) {
        if (!line) continue;
        const code = parseInt(line.substring(0, 3), 10);
        // Multi-line SMTP responses have a dash after the code (e.g. 250-smtp.gmail.com)
        const isLastLine = line.charAt(3) === ' ';

        if (!isLastLine && (code === 250 || code === 220)) {
          continue; // wait for final response line
        }

        handleResponse(code, line);
      }
    });

    function handleResponse(code, line) {
      try {
        if (code >= 400) {
          socket.end();
          return reject(new Error(`SMTP Error (${code}): ${line}`));
        }

        switch (step) {
          case 0: // Server greeting (220)
            step = 1;
            send(`EHLO localhost`);
            break;

          case 1: // Response to EHLO (250)
            step = 2;
            send('AUTH LOGIN');
            break;

          case 2: // Prompt for username (334)
            step = 3;
            send(Buffer.from(user).toString('base64'));
            break;

          case 3: // Prompt for password (334)
            step = 4;
            send(Buffer.from(cleanPass).toString('base64'));
            break;

          case 4: // Authentication successful (235)
            step = 5;
            send(`MAIL FROM:<${user}>`);
            break;

          case 5: // Sender accepted (250)
            step = 6;
            send(`RCPT TO:<${to}>`);
            break;

          case 6: // Recipient accepted (250)
            step = 7;
            send('DATA');
            break;

          case 7: // Ready for data (354)
            step = 8;
            const relatedBoundary = `----=_Part_rel_${Date.now()}_${Math.random().toString(36).substring(2)}`;
            const altBoundary = `----=_Part_alt_${Date.now()}_${Math.random().toString(36).substring(2)}`;
            const plainText = text || 'Your Switch verification code.';
            const formattedFrom = from ? (from.replace(/Switch Vault/gi, 'Switch')) : `"Switch" <${user}>`;

            const rawHeaders = [
              `From: ${formattedFrom}`,
              `To: <${to}>`,
              `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
              `MIME-Version: 1.0`,
              `Date: ${new Date().toUTCString()}`,
              `Message-ID: <${Date.now()}.${Math.random().toString(36).substring(2)}@switch.local>`,
            ];

            let rawMessage = '';

            if (cachedLogoBase64) {
              const base64Lines = cachedLogoBase64.match(/.{1,76}/g)?.join('\r\n') || cachedLogoBase64;
              rawHeaders.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
              rawMessage = [
                ...rawHeaders,
                '',
                `--${relatedBoundary}`,
                `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
                '',
                `--${altBoundary}`,
                'Content-Type: text/plain; charset=UTF-8',
                'Content-Transfer-Encoding: 7bit',
                '',
                plainText,
                '',
                `--${altBoundary}`,
                'Content-Type: text/html; charset=UTF-8',
                'Content-Transfer-Encoding: 7bit',
                '',
                html,
                '',
                `--${altBoundary}--`,
                '',
                `--${relatedBoundary}`,
                'Content-Type: image/png; name="logo.png"',
                'Content-Transfer-Encoding: base64',
                'Content-ID: <switch-logo>',
                'Content-Disposition: inline; filename="logo.png"',
                '',
                base64Lines,
                '',
                `--${relatedBoundary}--`,
                '.',
              ].join('\r\n');
            } else {
              rawHeaders.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
              rawMessage = [
                ...rawHeaders,
                '',
                `--${altBoundary}`,
                'Content-Type: text/plain; charset=UTF-8',
                'Content-Transfer-Encoding: 7bit',
                '',
                plainText,
                '',
                `--${altBoundary}`,
                'Content-Type: text/html; charset=UTF-8',
                'Content-Transfer-Encoding: 7bit',
                '',
                html,
                '',
                `--${altBoundary}--`,
                '.',
              ].join('\r\n');
            }

            socket.write(rawMessage + '\r\n');
            break;

          case 8: // Data accepted (250)
            step = 9;
            send('QUIT');
            resolve({ ok: true, messageId: line });
            break;

          default:
            break;
        }
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    }

    socket.on('error', (err) => {
      reject(new Error(`SMTP Connection Error: ${err.message}`));
    });

    socket.setTimeout(12000, () => {
      socket.destroy();
      reject(new Error('SMTP Connection Timeout'));
    });
  });
}

/**
 * Formats a modern branded Switch OTP Email template with ultra-minimal text.
 * Inspired by Linear & Vercel design systems.
 */
export function buildOtpEmailHtml({ otp, email, purpose = 'verification' }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Switch — ${otp}</title>
</head>
<body style="margin:0; padding:0; background-color:#05070d; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', Helvetica, Arial, sans-serif; color:#f8fafc; -webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#05070d; padding:44px 16px;">
    <tr>
      <td align="center">
        <!-- Minimal Obsidian Card (Linear/Vercel Aesthetic) -->
        <table role="presentation" width="100%" style="max-width:390px; background:#0c1017; border:1px solid #1e2638; border-radius:14px; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.8), 0 0 35px rgba(14,165,233,0.12);" cellspacing="0" cellpadding="0" border="0">
          
          <!-- Top Cyber Gradient Accent Line -->
          <tr>
            <td style="height:2px; line-height:2px; font-size:0; background:linear-gradient(90deg, #00f2fe 0%, #0ea5e9 40%, #6366f1 70%, #a855f7 100%);">&nbsp;</td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding:34px 28px 24px;" align="center">
              
              <!-- Switch Official Logo (CID Attached for 100% Gmail & Mobile Support) -->
              <img src="cid:switch-logo" width="44" height="44" alt="Switch" style="display:block; width:44px; height:44px; border-radius:11px; margin:0 auto 16px auto; box-shadow:0 4px 16px rgba(14,165,233,0.25);" />

              <!-- Brand Title -->
              <div style="font-size:18px; font-weight:700; letter-spacing:-0.02em; color:#ffffff; margin-bottom:12px;">
                Switch
              </div>

              <!-- Verification Instruction Line -->
              <div style="font-size:13.5px; color:#cbd5e1; line-height:1.55; margin-bottom:20px;">
                ${purpose === 'password reset'
                  ? 'Use the following verification code to reset your Switch Master Password:'
                  : 'Verify your email to finish signing up with Switch. Use the following code:'}
              </div>

              <!-- High-Contrast Linear-Style Monospace OTP Block -->
              <div style="background:#04070d; border:1px solid #1e293b; border-radius:10px; padding:15px 0; text-align:center; font-family:'JetBrains Mono', Consolas, Menlo, monospace; font-size:32px; font-weight:700; letter-spacing:0.28em; color:#00f2fe; text-shadow:0 0 10px rgba(0,242,254,0.35); margin-bottom:18px;">
                ${otp}
              </div>

              <!-- Validity Line -->
              <div style="font-size:12.5px; color:#94a3b8; line-height:1.5;">
                The verification code is valid for 10 min.
              </div>

              <!-- Complete Copyright Line -->
              <div style="border-top:1px solid #151d2b; margin-top:24px; padding-top:16px; font-size:11.5px; color:#64748b; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                © 2026 Switch Technologies, Inc. All rights reserved.
              </div>

            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
