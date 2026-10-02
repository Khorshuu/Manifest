import { isDeliverableAddress, readEmailConfig, recipientAllowed, type EmailConfig } from "./config";
import {
  DeliveryError,
  type DeliveryResult,
  type NotificationProvider,
  type NotificationProviderHealth,
  type OutgoingNotification,
} from "./types";

/**
 * Real email, over SMTP (D-132): `NOTIFICATION_PROVIDER=smtp`.
 *
 * The one adapter behind the provider boundary. It carries what the outbox
 * hands it and decides nothing about what is said or to whom, so the outbox,
 * its retries and every call site are exactly what they were with the mock.
 *
 * What it guarantees on its own account:
 *
 *  - **Plain text only.** A message is the composed body as text; there is no
 *    HTML part, so nothing a customer typed (a name, an address line) can
 *    become markup in somebody's mail client.
 *  - **One recipient, checked.** The recipient must be a single well-formed
 *    address — no list, no display name, no line break — before the provider
 *    sees it. The subject is put on one line. Files and remote URLs are never
 *    read into a message.
 *  - **TLS or nothing.** Port 465 is TLS from the start; any other port must
 *    upgrade with STARTTLS before the login or the message is sent.
 *  - **A stable Message-ID** derived from the outbox row, the same on every
 *    attempt. SMTP has no idempotency key, so a crash between the provider
 *    accepting a message and the row being marked sent can still deliver it
 *    twice; the shared Message-ID is what lets a mail system, or a person,
 *    recognise the second as the first.
 *  - **Nothing secret in an error.** A failure is recorded as the provider's
 *    reply code and a short reason. The password, the user and the host are
 *    never part of it.
 *
 * SMS is a channel the outbox models and this provider does not carry: an SMS
 * row fails permanently with a reason, rather than being reported as sent.
 */

type SentInfo = { messageId?: string; rejected?: unknown[] };
type MailFields = {
  from: { name: string; address: string } | string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  messageId?: string;
  headers?: Record<string, string>;
  disableFileAccess: true;
  disableUrlAccess: true;
};

/** The part of a nodemailer transport this adapter uses; tests supply their own. */
export type MailTransport = {
  sendMail(message: MailFields): Promise<SentInfo>;
  verify?(): Promise<unknown>;
};

export type MailTransportFactory = (config: EmailConfig) => Promise<MailTransport>;

const defaultTransport: MailTransportFactory = async (config) => {
  const { createTransport } = await import("nodemailer");
  const secure = config.SMTP_SECURE || config.SMTP_PORT === 465;
  return createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure,
    // Not "use TLS if offered": a server that does not offer it is refused.
    requireTLS: !secure,
    tls: { minVersion: "TLSv1.2" },
    auth: config.SMTP_USER && config.SMTP_PASSWORD ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    connectionTimeout: config.SMTP_TIMEOUT_MS,
    greetingTimeout: config.SMTP_TIMEOUT_MS,
    socketTimeout: config.SMTP_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  }) as unknown as MailTransport;
};

/** One line, no control characters, bounded. */
function oneLine(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

type SmtpFailure = { code?: unknown; responseCode?: unknown; command?: unknown };

/**
 * What a failure is recorded as. Built from the reply code and nodemailer's
 * own classification rather than from whatever text the error carries, so
 * nothing from the configuration can reach the outbox row or a log line.
 */
export function describeSmtpFailure(error: unknown): { message: string; permanent: boolean } {
  const failure = (error ?? {}) as SmtpFailure;
  const code = typeof failure.code === "string" ? failure.code : null;
  const reply = typeof failure.responseCode === "number" ? failure.responseCode : null;
  switch (code) {
    case "EAUTH":
      return { message: "The email provider refused the login (check SMTP_USER and SMTP_PASSWORD).", permanent: false };
    case "ECONNECTION":
    case "ESOCKET":
    case "EDNS":
    case "ECONNREFUSED":
    case "ENOTFOUND":
      return { message: "The email provider could not be reached.", permanent: false };
    case "ETIMEDOUT":
    case "ETIMEOUT":
      return { message: "The email provider did not answer in time.", permanent: false };
    case "ETLS":
      return { message: "The email provider did not offer a secure (TLS) connection, so nothing was sent.", permanent: false };
  }
  if (reply !== null) {
    // 5xx on the recipient is a mailbox that does not exist or refuses mail:
    // repeating it changes nothing. Everything else may clear up.
    const recipientRefused = code === "EENVELOPE" || failure.command === "RCPT TO";
    const permanent = reply >= 500 && reply < 600 && recipientRefused;
    return {
      message: permanent ? `The email provider refused the recipient (${reply}).` : `The email provider answered ${reply}.`,
      permanent,
    };
  }
  return { message: "The email could not be sent.", permanent: false };
}

export class SmtpNotificationProvider implements NotificationProvider {
  readonly name = "smtp";
  private transport: Promise<MailTransport> | undefined;

  constructor(
    private readonly source: Record<string, string | undefined> = process.env,
    private readonly createTransport: MailTransportFactory = defaultTransport,
  ) {}

  private settings(): EmailConfig {
    const read = readEmailConfig(this.source);
    if (!read.ok) {
      // Not permanent: the message is fine, the environment is not, and it
      // should go out once somebody fixes the settings.
      throw new DeliveryError(`Email is not configured: ${read.problems.join("; ")}.`);
    }
    return read.config;
  }

  async send(message: OutgoingNotification): Promise<DeliveryResult> {
    if (message.channel !== "email") {
      throw new DeliveryError("No SMS provider is configured; this message was not sent.", { permanent: true });
    }
    const recipient = message.recipient.trim();
    if (!isDeliverableAddress(recipient)) {
      throw new DeliveryError("The recipient is not a valid email address.", { permanent: true });
    }
    const config = this.settings();
    if (!recipientAllowed(recipient, config.NOTIFICATION_RECIPIENT_ALLOWLIST)) {
      throw new DeliveryError("This environment only sends to its allow-listed recipients; this message was not sent.", { permanent: true });
    }

    const from = config.EMAIL_FROM!;
    const messageId = message.idempotencyKey
      ? `<${message.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, "")}@${from.split("@")[1]}>`
      : undefined;

    let info: SentInfo;
    try {
      this.transport ??= this.createTransport(config);
      const transport = await this.transport;
      info = await transport.sendMail({
        from: config.EMAIL_FROM_NAME ? { name: config.EMAIL_FROM_NAME, address: from } : from,
        to: recipient,
        replyTo: config.EMAIL_REPLY_TO,
        subject: oneLine(message.subject, 200),
        text: message.body,
        messageId,
        // Tells mail systems this is a machine's message, so no out-of-office
        // reply comes back to it.
        headers: { "Auto-Submitted": "auto-generated" },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (error) {
      // A broken connection is not reused by the next message.
      this.transport = undefined;
      const described = describeSmtpFailure(error);
      throw new DeliveryError(described.message, { permanent: described.permanent });
    }

    if (Array.isArray(info.rejected) && info.rejected.length > 0) {
      throw new DeliveryError("The email provider refused the recipient.", { permanent: true });
    }
    return { providerMessageId: oneLine(String(info.messageId ?? messageId ?? "accepted"), 200) };
  }

  /** Connects and logs in, and sends nothing. */
  async health(): Promise<NotificationProviderHealth> {
    const read = readEmailConfig(this.source);
    if (!read.ok) {
      return { provider: "smtp", state: "not_configured", message: `Email is not configured: ${read.problems.join("; ")}.` };
    }
    try {
      const transport = await this.createTransport({ ...read.config, SMTP_TIMEOUT_MS: Math.min(read.config.SMTP_TIMEOUT_MS, 5_000) });
      await transport.verify?.();
      return { provider: "smtp", state: "ready", message: "The email provider accepted the connection and the login." };
    } catch (error) {
      return { provider: "smtp", state: "unavailable", message: describeSmtpFailure(error).message };
    }
  }
}
