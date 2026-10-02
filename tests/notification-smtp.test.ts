/**
 * Real email through the provider boundary (D-132).
 *
 * Nothing here opens a connection or sends a message. The messages are built
 * by nodemailer's own JSON transport, which composes exactly what the SMTP
 * transport would put on the wire and hands it back instead, so what is
 * asserted is the real envelope and the real headers.
 */
import { createTransport } from "nodemailer";
import { describe, expect, it } from "vitest";
import {
  DeliveryError,
  MockNotificationProvider,
  SmtpNotificationProvider,
  type OutgoingNotification,
} from "@/lib/providers/notification";
import { isDeliverableAddress, readEmailConfig, recipientAllowed } from "@/lib/providers/notification/config";
import { describeSmtpFailure, type MailTransport, type MailTransportFactory } from "@/lib/providers/notification/smtp";

const SETTINGS = {
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "apikey",
  SMTP_PASSWORD: "s3cr3t-smtp-password",
  EMAIL_FROM: "orders@shop.example",
  EMAIL_FROM_NAME: "Manifest",
};

const MESSAGE: OutgoingNotification = {
  channel: "email",
  recipient: "nadia@example.com",
  subject: "Your order ORD-2026-000001 is confirmed",
  body: "Thank you.\n\n<script>alert(1)</script> is only text here.",
  idempotencyKey: "0b0e7f3c-58a2-4f6f-9d52-0d6a3c1f7a11",
};

type Composed = {
  from: { address: string; name: string };
  to: { address: string; name: string }[];
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  headers: Record<string, string>;
};

/** A provider whose messages are composed for real and sent nowhere. */
function composing(settings: Record<string, string | undefined> = SETTINGS) {
  const composed: Composed[] = [];
  const factory: MailTransportFactory = async () => {
    const transport = createTransport({ jsonTransport: true });
    return {
      async sendMail(fields) {
        const info = await transport.sendMail(fields);
        composed.push(JSON.parse(String(info.message)));
        return { messageId: info.messageId };
      },
    } satisfies MailTransport;
  };
  return { provider: new SmtpNotificationProvider(settings, factory), composed };
}

function failing(error: unknown, settings: Record<string, string | undefined> = SETTINGS) {
  let created = 0;
  const provider = new SmtpNotificationProvider(settings, async () => {
    created += 1;
    return {
      async sendMail() {
        throw error;
      },
      async verify() {
        throw error;
      },
    };
  });
  return { provider, created: () => created };
}

async function refusal(work: Promise<unknown>): Promise<DeliveryError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(DeliveryError);
    return error as DeliveryError;
  }
  throw new Error("Expected the delivery to be refused.");
}

describe("email settings", () => {
  it("needs a host and a sender, and says which is missing without quoting any value", () => {
    const read = readEmailConfig({ SMTP_USER: "apikey", SMTP_PASSWORD: "s3cr3t-smtp-password" });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems).toEqual(["SMTP_HOST is not set", "EMAIL_FROM is not set"]);
    expect(JSON.stringify(read.problems)).not.toContain("s3cr3t");
  });

  it("refuses half a login", () => {
    const read = readEmailConfig({ ...SETTINGS, SMTP_PASSWORD: "" });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems).toEqual(["SMTP_USER and SMTP_PASSWORD must be set together"]);
  });

  it("refuses a sender that could carry a second header", () => {
    expect(readEmailConfig({ ...SETTINGS, EMAIL_FROM: "orders@shop.example\r\nBcc: x@evil.example" }).ok).toBe(false);
    expect(readEmailConfig({ ...SETTINGS, EMAIL_FROM_NAME: "Shop\r\nBcc: x@evil.example" }).ok).toBe(false);
    expect(readEmailConfig({ ...SETTINGS, SMTP_HOST: "smtp.example.test/../x" }).ok).toBe(false);
  });

  it("treats blank values as not set and defaults the port to 587", () => {
    const read = readEmailConfig({ ...SETTINGS, SMTP_PORT: "  ", EMAIL_REPLY_TO: "" });
    expect(read.ok && read.config.SMTP_PORT).toBe(587);
  });

  it("accepts one address and nothing else as a recipient", () => {
    expect(isDeliverableAddress("nadia@example.com")).toBe(true);
    for (const bad of ["", "nadia", "a@b", "a@example.com, b@example.com", "a@example.com\nBcc: b@example.com", "Nadia <a@example.com>", "a b@example.com"]) {
      expect(isDeliverableAddress(bad), bad).toBe(false);
    }
  });

  it("allows every recipient without a list, and only the listed ones with it", () => {
    expect(recipientAllowed("anyone@example.com", undefined)).toBe(true);
    expect(recipientAllowed("anyone@example.com", " ")).toBe(true);
    const list = "qa@shop.example, @team.example";
    expect(recipientAllowed("QA@shop.example", list)).toBe(true);
    expect(recipientAllowed("anyone@team.example", list)).toBe(true);
    expect(recipientAllowed("customer@gmail.com", list)).toBe(false);
    // "@team.example" is a whole domain, not a suffix of someone else's.
    expect(recipientAllowed("x@notteam.example", list)).toBe(false);
  });
});

describe("the SMTP provider", () => {
  it("names itself, so an outbox failure can say which provider it was", () => {
    expect(new SmtpNotificationProvider(SETTINGS).name).toBe("smtp");
    expect(new MockNotificationProvider().name).toBe("mock");
  });

  it("sends one plain-text message from the configured sender to the one recipient", async () => {
    const { provider, composed } = composing();
    const result = await provider.send(MESSAGE);

    expect(composed).toHaveLength(1);
    const [mail] = composed;
    expect(mail.from).toEqual({ address: "orders@shop.example", name: "Manifest" });
    expect(mail.to).toEqual([{ address: "nadia@example.com", name: "" }]);
    expect(mail.subject).toBe(MESSAGE.subject);
    expect(mail.text).toBe(MESSAGE.body);
    // No HTML part exists, so markup in a body is never markup in a mail client.
    expect(mail.html).toBeUndefined();
    expect(mail.headers["Auto-Submitted"] ?? mail.headers["auto-submitted"]).toBe("auto-generated");
    expect(result.providerMessageId).toBe(mail.messageId);
  });

  it("gives every attempt at one message the same Message-ID", async () => {
    const { provider, composed } = composing();
    await provider.send(MESSAGE);
    await provider.send(MESSAGE);
    await provider.send({ ...MESSAGE, idempotencyKey: "another-row" });

    expect(composed[0].messageId).toBe("<0b0e7f3c-58a2-4f6f-9d52-0d6a3c1f7a11@shop.example>");
    expect(composed[1].messageId).toBe(composed[0].messageId);
    expect(composed[2].messageId).toBe("<another-row@shop.example>");
  });

  it("keeps a subject on one line", async () => {
    const { provider, composed } = composing();
    await provider.send({ ...MESSAGE, subject: "Order confirmed\r\nBcc: someone@evil.example" });
    expect(composed[0].subject).toBe("Order confirmed Bcc: someone@evil.example");
    expect(JSON.stringify(composed[0].headers)).not.toContain("evil.example");
  });

  it("refuses a recipient that is not one address, permanently, before any connection", async () => {
    const { provider, created } = failing(new Error("must not be reached"));
    for (const recipient of ["", "not-an-address", "a@example.com, b@example.com", "a@example.com\r\nBcc: b@example.com"]) {
      const error = await refusal(provider.send({ ...MESSAGE, recipient }));
      expect(error.permanent).toBe(true);
      expect(error.message).toBe("The recipient is not a valid email address.");
    }
    expect(created()).toBe(0);
  });

  it("does not carry SMS, and says so instead of reporting it sent", async () => {
    const { provider, composed } = composing();
    const error = await refusal(provider.send({ ...MESSAGE, channel: "sms", recipient: "+8801712345678" }));
    expect(error.permanent).toBe(true);
    expect(error.message).toMatch(/No SMS provider is configured/);
    expect(composed).toHaveLength(0);
  });

  it("writes only to allow-listed recipients when the environment has a list", async () => {
    const { provider, composed } = composing({ ...SETTINGS, NOTIFICATION_RECIPIENT_ALLOWLIST: "qa@shop.example" });
    const error = await refusal(provider.send(MESSAGE));
    expect(error.permanent).toBe(true);
    expect(composed).toHaveLength(0);

    await provider.send({ ...MESSAGE, recipient: "qa@shop.example" });
    expect(composed).toHaveLength(1);
  });

  it("fails without sending when it is not configured, and may be retried once it is", async () => {
    const { provider, created } = failing(new Error("must not be reached"), { SMTP_HOST: "smtp.example.test" });
    const error = await refusal(provider.send(MESSAGE));
    expect(error.permanent).toBe(false);
    expect(error.message).toBe("Email is not configured: EMAIL_FROM is not set.");
    expect(created()).toBe(0);
  });

  it("records a failure by its kind, never by the provider's own text", async () => {
    const secretive = Object.assign(new Error("Invalid login: 535 user apikey password s3cr3t-smtp-password at smtp.example.test"), {
      code: "EAUTH",
      responseCode: 535,
    });
    const { provider } = failing(secretive);
    const error = await refusal(provider.send(MESSAGE));
    expect(error.permanent).toBe(false);
    expect(error.message).toBe("The email provider refused the login (check SMTP_USER and SMTP_PASSWORD).");
    for (const secret of ["s3cr3t-smtp-password", "apikey", "smtp.example.test"]) {
      expect(error.message).not.toContain(secret);
    }
  });

  it("tells a refused mailbox from an outage", () => {
    expect(describeSmtpFailure({ code: "EENVELOPE", responseCode: 550 })).toEqual({ message: "The email provider refused the recipient (550).", permanent: true });
    expect(describeSmtpFailure({ responseCode: 550, command: "RCPT TO" }).permanent).toBe(true);
    // Rate limited, greylisted, or the provider's own trouble: worth trying again.
    expect(describeSmtpFailure({ code: "EENVELOPE", responseCode: 451 }).permanent).toBe(false);
    expect(describeSmtpFailure({ responseCode: 554, command: "DATA" }).permanent).toBe(false);
    expect(describeSmtpFailure({ code: "ETIMEDOUT" })).toEqual({ message: "The email provider did not answer in time.", permanent: false });
    expect(describeSmtpFailure({ code: "ECONNECTION" }).message).toBe("The email provider could not be reached.");
    expect(describeSmtpFailure(new Error("anything"))).toEqual({ message: "The email could not be sent.", permanent: false });
    expect(describeSmtpFailure(null).permanent).toBe(false);
  });

  it("opens a new connection after a failure instead of reusing a broken one", async () => {
    const { provider, created } = failing(Object.assign(new Error("gone"), { code: "ECONNECTION" }));
    await refusal(provider.send(MESSAGE));
    await refusal(provider.send(MESSAGE));
    expect(created()).toBe(2);
  });

  it("treats a recipient the provider rejected as not sent", async () => {
    const provider = new SmtpNotificationProvider(SETTINGS, async () => ({
      async sendMail() {
        return { messageId: "<x@shop.example>", rejected: ["nadia@example.com"] };
      },
    }));
    expect((await refusal(provider.send(MESSAGE))).permanent).toBe(true);
  });
});

describe("the provider's health", () => {
  it("says the mock is the mock", async () => {
    expect((await new MockNotificationProvider().health()).state).toBe("mock");
  });

  it("is not_configured without settings, naming what is missing", async () => {
    const health = await new SmtpNotificationProvider({}).health();
    expect(health).toEqual({ provider: "smtp", state: "not_configured", message: "Email is not configured: SMTP_HOST is not set; EMAIL_FROM is not set." });
  });

  it("is ready when the provider accepts the login, and sends nothing to find out", async () => {
    let sent = 0;
    const provider = new SmtpNotificationProvider(SETTINGS, async () => ({
      async sendMail() {
        sent += 1;
        return {};
      },
      async verify() {
        return true;
      },
    }));
    expect((await provider.health()).state).toBe("ready");
    expect(sent).toBe(0);
  });

  it("is unavailable when the provider cannot be reached, with no setting in the message", async () => {
    const { provider } = failing(Object.assign(new Error("connect ECONNREFUSED smtp.example.test:587"), { code: "ECONNECTION" }));
    const health = await provider.health();
    expect(health.state).toBe("unavailable");
    expect(JSON.stringify(health)).not.toMatch(/smtp\.example\.test|apikey|s3cr3t/);
  });
});
